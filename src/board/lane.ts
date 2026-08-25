import type { LayerId, Note, NoteId, Pos } from '../core/types'
import { toNumber } from '../core/frac'
import type { GridRegion, GridSlot } from '../core/grid'
import type { GridCursor } from '../core/gridCursor'
import { createGridCursor } from '../core/gridCursor'
import { add as posAdd, cmp as posCmp, key as posKey, pos as makePos } from '../core/pos'
import { quartersToPos } from '../core/tempo'
import { effectiveVelocity } from '../audio/scheduler'
import type { VelocityLayer } from '../audio/scheduler'
import { theme } from './theme'
import { posToX, quartersToWidth, quartersToX, visibleCols, xToQuarters } from './viewport'
import type { Size, Viewport } from './viewport'

/**
 * The velocity lane. See go-spec.md §6.2, §5.3 "Canvas coordination", and the grid
 * design doc §3.4 (slot velocity) and §3.6 (cursor-based grid resolution).
 *
 * Pure drawing plus the geometry the interaction layer hit-tests against — no React,
 * no DOM events, no rAF. The lane is its own canvas but NOT its own frame loop: the
 * single rAF owner calls `drawLane` inside the same callback that draws the board, or
 * the lane's bars tear away from the columns they belong to during a fast pan.
 *
 * Three things this module refuses to duplicate:
 *  - **Velocity resolution** comes from `effectiveVelocity` (§6.1), which the scheduler
 *    already owns. A second copy here would drift from what actually sounds.
 *  - **The `Viewport`** is the board's own object, passed in. Deriving a second one
 *    ("the lane only needs x") is exactly how the lane ends up a pixel off.
 *  - **Slot resolution** comes from `GridCursor`/`core/grid` (design §3.2), so a bar
 *    and the stone above it agree on which slot they are — including a slot clipped
 *    short by the next region's start.
 *
 * The unit of the lane is the **slot**, not the note and not the column: since a grid
 * value may be coarser than a quarter note (§3.2), a single slot can span two or four
 * columns, and it still draws exactly ONE cell. That is why nothing here iterates
 * columns to find slots — the draw walks slot starts and advances by each slot's own
 * (possibly clipped) duration. Columns are iterated only to stroke the column rules,
 * which are a property of the ruler, not of the grid.
 */

/** Lane strip height in CSS px (§6.2). */
export const LANE_HEIGHT = 96

export const MAX_VELOCITY = 127

/** The layer facts the lane reads. A full §4 `Layer` satisfies it. */
export type LaneLayer = VelocityLayer & {
  readonly id: LayerId
  readonly color: string
}

/**
 * A slot addressed in lane space: an absolute start and its (possibly clipped) span.
 *
 * Identical to `GridSlot` — the lane deliberately has no slot type of its own any more.
 * The old `{col, slotIndex}` pair could not name a slot that spans several columns.
 */
export type LaneSlot = GridSlot

/**
 * One drawn division of a bar. A slot whose notes all resolve to the same velocity is
 * one segment; mixed own/column/default velocities inside a chord split it (§6.2).
 */
export type LaneSegment = {
  readonly vel: number
  /** Every note this segment stands for, in pitch order. */
  readonly noteIds: readonly NoteId[]
}

/**
 * In-flight drag values, not yet committed to the store.
 *
 * A drag must show its result while it is happening, but §7.3 allows exactly one
 * command per gesture — so the gesture accumulates here and the store is written once,
 * on pointerup. `slots` is keyed by `slotKey(slot.start)`, `notes` by `NoteId`
 * (the Alt-drag chord-internal override, which outranks the slot value just as
 * `note.vel` outranks `colVel` in §6.1).
 */
export type LanePreview = {
  readonly slots?: ReadonlyMap<string, number> | undefined
  readonly notes?: ReadonlyMap<NoteId, number> | undefined
}

export type LaneScene = {
  /** The active layer — the lane shows that layer alone, in its color (§6.2). */
  readonly layer: LaneLayer
  /** The active layer's grid regions (§3.2); empty means one slot per quarter. */
  readonly grid: readonly GridRegion[]
  /** Notes on the active layer, pos-sorted; `NoteIndex.queryRange` satisfies it. */
  readonly notesInRange: (startCol: number, endCol: number) => readonly Note[]
  /** §11 open question 3: ghosts ship behind a toggle. */
  readonly showGhosts: boolean
  readonly preview?: LanePreview | undefined
}

/**
 * Key for a slot inside a `LanePreview` — its absolute start.
 *
 * A slot start is globally unique across the grid, so no column/index disambiguation is
 * needed and, crucially, a slot that covers four columns has exactly one key.
 */
export const slotKey = (start: Pos): string => posKey(start)

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// --- geometry -------------------------------------------------------------------

/**
 * The slot under a lane x coordinate — the interaction layer's hit test.
 *
 * The float pixel is turned into an approximate `Pos` by `quartersToPos` purely so the
 * cursor can be asked which slot governs it; the returned `start`/`dur` come back out
 * of exact region arithmetic and the approximation is never stored (§3.1). This is the
 * same contract `hitTest.pointToSlot` documents, minus the nearest-intersection step:
 * a lane cell is *containing*, not nearest, because the bar fills the cell.
 *
 * `quartersToPos`' bounded continued-fraction recovery is also what replaces the old
 * `BOUNDARY_EPS`: `32/96` comes back as exactly `1/3`, so a click on a triplet boundary
 * lands in the slot that boundary *starts*, per the half-open rule.
 *
 * `null` only for a non-finite x: the lane is boundless horizontally, exactly like the
 * board, so every real pixel belongs to some slot.
 */
export function laneSlotAt(vp: Viewport, cursor: GridCursor, x: number): LaneSlot | null {
  if (!Number.isFinite(x)) return null
  return cursor.slotAt(quartersToPos(xToQuarters(vp, x)))
}

/** Left edge and width of a slot's bar cell, in lane px. */
export function slotCellX(vp: Viewport, slot: LaneSlot): { x: number; width: number } {
  return {
    x: posToX(vp, slot.start),
    width: quartersToWidth(vp, toNumber(slot.dur)),
  }
}

/** Gap between a bar and its slot's edges, in px. */
const BAR_GAP = 2

/**
 * The drawn bar inside a slot's cell.
 *
 * Exported because the Alt-drag hit test must land on the same pixels the renderer
 * painted: segments are laid out inside this inset, not inside the raw cell.
 */
export function slotBarX(cellX: number, cellWidth: number): { x: number; width: number } {
  const gap = Math.min(BAR_GAP, cellWidth * 0.2)
  return { x: cellX + gap / 2, width: Math.max(1, cellWidth - gap) }
}

/**
 * Velocity for a lane y, clamped to 0–127. The lane grows upward from its bottom edge,
 * so y is inverted; `velocityToY` is the exact inverse.
 */
export function velocityAtY(laneHeight: number, y: number): number {
  if (!(laneHeight > 0)) return 0
  return clamp(Math.round(((laneHeight - y) / laneHeight) * MAX_VELOCITY), 0, MAX_VELOCITY)
}

/** Top edge of a bar at `vel` — `velocityAtY` inverted, and what the renderer draws. */
export function velocityToY(laneHeight: number, vel: number): number {
  return laneHeight - (clamp(vel, 0, MAX_VELOCITY) / MAX_VELOCITY) * laneHeight
}

/** Which of `count` side-by-side segments contains `x`, given the cell's span. */
export function segmentIndexAt(count: number, cellX: number, cellWidth: number, x: number): number {
  if (count <= 1 || cellWidth <= 0) return 0
  return clamp(Math.floor(((x - cellX) / cellWidth) * count), 0, count - 1)
}

// --- velocity resolution (§6.1, §3.4, preview-aware) ------------------------------

/** Velocity lookups for one lane frame, with the in-flight drag folded in. */
export type LaneVelocities = {
  /** Effective velocity of a note (§6.1), overridden by the drag in progress. */
  readonly velOf: (note: Note, slotStart: Pos) => number
  /** The would-be velocity of an *empty* slot: the column override, else the default. */
  readonly ghostOf: (slotStart: Pos) => number
}

/**
 * Bind a layer (and any preview) into the two lookups the lane draws with.
 *
 * The preview precedence mirrors §6.1 one level up: a per-note Alt-drag beats a
 * slot drag, which beats whatever the store currently holds.
 *
 * Per design §3.4, storage stays **column-keyed** while display is slot-scoped: the
 * value a slot shows is the one stored at its *starting* column, whatever else may sit
 * in the columns it goes on to cover. Note-level resolution is untouched — a note still
 * resolves through `note.vel → colVel.get(note.pos.col) → defaultVel`, on-grid or off,
 * because `effectiveVelocity` is the scheduler's function and the lane only draws it.
 */
export function laneVelocities(layer: LaneLayer, preview?: LanePreview | undefined): LaneVelocities {
  const slots = preview?.slots
  const notes = preview?.notes
  return {
    velOf: (note, slotStart) =>
      notes?.get(note.id) ?? slots?.get(slotKey(slotStart)) ?? effectiveVelocity(note, layer),
    ghostOf: (slotStart) =>
      slots?.get(slotKey(slotStart)) ?? layer.colVel.get(slotStart.col) ?? layer.defaultVel,
  }
}

/** The would-be velocity of an empty slot in `col`: column override, else layer default (§6.1). */
export const ghostVelocity = (layer: VelocityLayer, col: number): number =>
  layer.colVel.get(col) ?? layer.defaultVel

/**
 * Split a slot's notes into drawn segments — one per *distinct* velocity, ascending.
 *
 * A chord where every note inherits is a single full-width bar; override one note and
 * the bar splits in two, which is the whole point of §6.2's "renders split". Notes are
 * grouped, not listed, so a three-note chord at one velocity stays one bar.
 */
export function slotSegments(
  notes: readonly Note[],
  velOf: (note: Note) => number,
): LaneSegment[] {
  const byVel = new Map<number, NoteId[]>()
  for (const note of [...notes].sort((a, b) => a.pitch - b.pitch)) {
    const vel = velOf(note)
    const bucket = byVel.get(vel)
    if (bucket) bucket.push(note.id)
    else byVel.set(vel, [note.id])
  }
  return [...byVel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([vel, noteIds]) => ({ vel, noteIds }))
}

/**
 * One segment per note, in pitch order — the Alt-drag target list.
 *
 * Deliberately not `slotSegments`: velocity grouping makes two notes that currently
 * share a velocity indistinguishable, and §6.2's Alt-drag has to reach exactly one of
 * them ("sets only that note"). So the drawn split and the Alt hit-test are different
 * partitions of the same slot.
 */
export function noteSegments(
  notes: readonly Note[],
  velOf: (note: Note) => number,
): LaneSegment[] {
  return [...notes]
    .sort((a, b) => a.pitch - b.pitch)
    .map((note) => ({ vel: velOf(note), noteIds: [note.id] }))
}

/**
 * Bucket notes by the slot that contains them, keyed by `slotKey(slot.start)`.
 *
 * Keying by slot start rather than by `(column, index)` is what lets a slot spanning
 * several columns own a single bucket: two notes a whole column apart under a half-note
 * grid land in the same bucket, and the lane draws them as one split bar.
 *
 * Off-grid notes (§7: changing the grid re-quantizes nothing) land in the slot that
 * *contains* them rather than vanishing from the lane — `cursor.slotAt` resolves
 * containment, not equality.
 *
 * Resolution goes through a `GridCursor`, not a binary search per note (§3.6): `notes`
 * arrives pos-sorted from `NoteIndex`, so the cursor's forward walk is O(n + regions).
 * An unsorted caller still gets correct answers — a backward step just pays for a seek.
 */
export function bucketBySlot(
  regions: readonly GridRegion[],
  notes: readonly Note[],
): Map<string, Note[]> {
  const out = new Map<string, Note[]>()
  const cursor = createGridCursor(regions)
  for (const note of notes) {
    const key = slotKey(cursor.slotAt(note.pos).start)
    const bucket = out.get(key)
    if (bucket) bucket.push(note)
    else out.set(key, [note])
  }
  return out
}

// --- drawing ---------------------------------------------------------------------

/** Gap between the segments of a split bar. */
const SEGMENT_GAP = 1
/** Below this cell width a ghost is noise rather than information. */
const MIN_GHOST_WIDTH = 3

/** Snap to a device pixel, so bar edges are crisp rather than antialiased (§5.3). */
const px = (v: number, dpr: number): number => Math.round(v * dpr) / dpr
/** Snap a 1px line to a device pixel *center*. */
const crisp = (v: number, dpr: number): number => px(v, dpr) + 0.5 / dpr

/**
 * Draw the lane. Returns the number of bars drawn (solid + ghost), for the §5.3
 * benchmark.
 *
 * Batched by visual class per §5.3: the column rules, every ghost, every solid segment
 * and every bar cap are four paths and four style assignments, not four per bar.
 *
 * **Structure.** Two independent walks, which is the whole point of this pass:
 *  1. Column rules — `for (col = start; col <= end; col++)`. A rule is a property of
 *     the ruler, so it is drawn per column no matter what the grid does.
 *  2. Cells — a forward walk over slot *starts*, each step advancing by that slot's own
 *     `dur`. Since the walk never subdivides a column and never visits a position
 *     twice, a slot covering four columns is visited exactly once and therefore draws
 *     exactly one cell; a slot clipped short by the next region's start draws one
 *     narrow cell, and is a real, editable slot like any other.
 *
 * The walk starts at `cursor.slotAt(from).start`, which may lie left of the visible
 * span: a whole-note slot beginning three columns off-screen still has most of its cell
 * on screen, and skipping it (as a gridline pass legitimately does) would leave a hole.
 *
 * **The note query is bounded by the SLOTS, not by the columns.** Both edges: the first
 * slot can start left of `start`, and the last slot — the one containing `to` — can end
 * arbitrarily far right of `end`. Querying `[start, end + 1)` would silently drop the
 * notes of a coarse slot whose head is on screen and whose tail is not, and that slot
 * would then render as a ghost at the layer default instead of as a bar. A column-scoped
 * loop could not make that mistake; a slot-scoped one can, so the bound is derived from
 * the walk's own endpoints.
 */
export function drawLane(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  scene: LaneScene,
  dpr: number,
): number {
  const h = size.height
  ctx.fillStyle = theme.laneBg
  ctx.fillRect(0, 0, size.width, h)

  const { start, end } = visibleCols(vp, size)
  const { velOf, ghostOf } = laneVelocities(scene.layer, scene.preview)

  const cursor = createGridCursor(scene.grid)
  const from = makePos(start)
  const to = makePos(end)
  // The leftmost cell may begin before the viewport; its notes begin there too. The
  // rightmost cell is the slot containing `to` — the walk runs while `at <= to` and
  // steps contiguously, so that slot is the last one it visits — and it may end well
  // past `end`. Two O(1) cursor probes give both edges; `reset` puts the cursor back
  // at the sentinel so the draw walk below starts from `first` with a forward step.
  const first = cursor.slotAt(from).start
  const lastCol = slotColumns(cursor.slotAt(to)).toCol
  cursor.reset()

  // Onsets only: a note's bar sits in the slot it starts in, so unlike the board this
  // pass needs no `maxDurQuarters` widening — a long note contributes one bar, at its
  // head, and cannot reach in from the left.
  const byslot = bucketBySlot(
    scene.grid,
    scene.notesInRange(Math.min(first.col, start), Math.max(end + 1, lastCol)),
  )

  const rules = new Path2D()
  const bars = new Path2D()
  const ghosts = new Path2D()
  const caps = new Path2D()
  let drawn = 0
  let anyGhost = false
  let anyBar = false

  for (let col = start; col <= end; col++) {
    const colX = crisp(quartersToX(vp, col), dpr)
    rules.moveTo(colX, 0)
    rules.lineTo(colX, h)
  }

  for (let at = first; posCmp(at, to) <= 0; ) {
    const slot = cursor.slotAt(at)
    // A region boundary can only shorten a slot, never zero it (`slotAt` picks the
    // later region at a coincident start) — but never trust an unbounded walk.
    if (slot.dur.n <= 0) break

    const cellX = posToX(vp, slot.start)
    const cellW = quartersToWidth(vp, toNumber(slot.dur))
    at = posAdd(slot.start, slot.dur)
    if (cellX > size.width || cellX + cellW < 0) continue

    const { x: barX, width: barW } = slotBarX(cellX, cellW)
    const notes = byslot.get(slotKey(slot.start))

    if (notes === undefined || notes.length === 0) {
      if (!scene.showGhosts || cellW < MIN_GHOST_WIDTH) continue
      const y = px(velocityToY(h, ghostOf(slot.start)), dpr)
      ghosts.rect(px(barX, dpr), y, px(barW, dpr), h - y)
      anyGhost = true
      drawn++
      continue
    }

    const segments = slotSegments(notes, (n) => velOf(n, slot.start))
    const n = segments.length
    const segW = Math.max(1, (barW - (n - 1) * SEGMENT_GAP) / n)
    for (let s = 0; s < n; s++) {
      const x = px(barX + s * (segW + SEGMENT_GAP), dpr)
      const y = px(velocityToY(h, segments[s]!.vel), dpr)
      const w = px(segW, dpr)
      bars.rect(x, y, w, h - y)
      // A cap keeps a near-zero bar visible and reads as the drag handle it is.
      caps.moveTo(x, crisp(y, dpr))
      caps.lineTo(x + w, crisp(y, dpr))
      anyBar = true
      drawn++
    }
  }

  ctx.lineWidth = 1
  ctx.strokeStyle = theme.gridLine
  ctx.stroke(rules)

  if (anyGhost) {
    ctx.fillStyle = theme.laneGhost
    ctx.fill(ghosts)
  }
  if (anyBar) {
    ctx.fillStyle = scene.layer.color
    ctx.fill(bars)
    ctx.strokeStyle = theme.laneEdge
    ctx.stroke(caps)
  }

  // Top and bottom rules last, so bars cannot sit on top of the strip's own edge.
  ctx.strokeStyle = theme.laneEdge
  ctx.beginPath()
  ctx.moveTo(0, crisp(0, dpr))
  ctx.lineTo(size.width, crisp(0, dpr))
  ctx.moveTo(0, crisp(h - 1, dpr))
  ctx.lineTo(size.width, crisp(h - 1, dpr))
  ctx.stroke()

  return drawn
}

/**
 * The half-open column range a slot covers — `[start.col, endCol)`.
 *
 * Design §3.4: a lane edit on a slot writes its velocity to **every** column the slot
 * covers, so the value is there whichever column a later note is placed in.
 *
 * The end column is computed in integers, deliberately. `ceil(toQuarters(...))` looks
 * equivalent and is not: `toQuarters` is a float, and a value like `1/3` lands on the
 * wrong side of a boundary often enough to matter (§3.1 — no float decides a column).
 *
 * **Known limitation, deliberate — do not "fix" this by changing where velocity is
 * stored.** Under an *off-phase coarse* grid, consecutive slots cover OVERLAPPING column
 * ranges. A region `{start: pos(0,1,2), value: 1}` gives slots `[0.5, 1.5)` and
 * `[1.5, 2.5)`, covering columns 0–1 and 1–2 respectively; column 1 belongs to both. So
 * a lane edit on the first slot also moves the *displayed* value of the second, since a
 * slot displays what is stored at its starting column (`laneVelocities.ghostOf`).
 *
 * That is a direct consequence of design §3.4's two halves — "storage stays
 * column-keyed" and "a lane edit writes every column the slot covers" — and not of this
 * function. Making it exact would need slot-keyed velocity storage, which is a model
 * change: it would disturb §6.1's `note.vel → colVel → defaultVel` resolution order,
 * which the scheduler owns, and the on-disk project format, which is column-keyed. Both
 * are far outside this plan. The overlap only arises for a grid coarser than a quarter
 * AND anchored off a column boundary; on-phase grids of any coarseness partition the
 * columns cleanly and have no overlap at all.
 */
export function slotColumns(slot: LaneSlot): { fromCol: number; toCol: number } {
  const end = posAdd(slot.start, slot.dur)
  return { fromCol: slot.start.col, toCol: end.frac.n === 0 ? end.col : end.col + 1 }
}

/**
 * Does this slot cover whole columns and nothing less?
 *
 * §6.2's rule was "an undivided column edits the column value"; with a grid that can be
 * coarser than a column, the same rule reads "a slot no finer than a column edits the
 * column values it covers". A sub-column slot with notes in it edits those notes
 * instead, exactly as before.
 */
export function slotIsColumnAligned(slot: LaneSlot): boolean {
  return slot.start.frac.n === 0 && slot.dur.d === 1 && slot.dur.n > 0
}
