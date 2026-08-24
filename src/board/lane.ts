import type { Frac, LayerId, Note, NoteId, Subdiv } from '../core/types'
import { frac, toNumber } from '../core/frac'
import { enumerateSlots, slotIndexAt } from '../core/subdiv'
import { effectiveVelocity } from '../audio/scheduler'
import type { VelocityLayer } from '../audio/scheduler'
import { theme } from './theme'
import { quartersToWidth, quartersToX, visibleCols, xToQuarters } from './viewport'
import type { Size, Viewport } from './viewport'

/**
 * The velocity lane. See go-spec.md §6.2, and §5.3 "Canvas coordination".
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
 *  - **Slot enumeration** comes from `enumerateSlots`/`slotIndexAt` (§3.2), so a bar
 *    and the stone above it agree on which slot they are, including inside a nested
 *    split where the flattened index is not `i` but a running sum.
 *
 * The unit of the lane is the **slot**, not the note and not the column: a column split
 * into 5 draws 5 bars whether it holds 0 notes or 12.
 */

/** Lane strip height in CSS px (§6.2). */
export const LANE_HEIGHT = 96

export const MAX_VELOCITY = 127

/** The active layer's subdivision for a column; `undefined` is the `{split:1}` default. */
export type SubdivFor = (col: number) => Subdiv | undefined

/** The layer facts the lane reads. A full §4 `Layer` satisfies it. */
export type LaneLayer = VelocityLayer & {
  readonly id: LayerId
  readonly color: string
}

/** A slot addressed in lane space: which column, which flattened slot, and its rational span. */
export type LaneSlot = {
  readonly col: number
  readonly slotIndex: number
  readonly start: Frac
  readonly dur: Frac
}

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
 * on pointerup. `slots` is keyed by `slotKey(col, slotIndex)`, `notes` by `NoteId`
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
  readonly subdivFor: SubdivFor
  /** Notes on the active layer, pos-sorted; `NoteIndex.queryRange` satisfies it. */
  readonly notesInRange: (startCol: number, endCol: number) => readonly Note[]
  /** §11 open question 3: ghosts ship behind a toggle. */
  readonly showGhosts: boolean
  readonly preview?: LanePreview | undefined
}

/** Key for a slot inside a `LanePreview`. */
export const slotKey = (col: number, slotIndex: number): string => `${col}:${slotIndex}`

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// --- geometry -------------------------------------------------------------------

/**
 * Boundary tolerance, in slot units — the same trap `hitTest.pointToSlot` documents:
 * spans are half-open, but the pointer arrives as a float and `32/96 * 3` is
 * `0.9999999999999999`, so a bare `Math.floor` puts a click on a triplet boundary in
 * the previous slot.
 */
const BOUNDARY_EPS = 1e-9

/** Index of the slot containing `u` slot-units, snapped up at a boundary and clamped. */
function slotIndexIn(u: number, count: number): number {
  let i = Math.floor(u)
  if (u - i >= 1 - BOUNDARY_EPS) i += 1
  return i < 0 ? 0 : i >= count ? count - 1 : i
}

/**
 * The slot under a lane x coordinate — the interaction layer's hit test.
 *
 * Returns the *flattened* slot index, matching `enumerateSlots` order, so a caller can
 * address the bar it just drew. The rational `start`/`dur` are built from integer slot
 * indices, never from the float x (§3.1).
 *
 * `null` only for a non-finite x: the lane is boundless horizontally, exactly like the
 * board, so every real pixel belongs to some column.
 */
export function laneSlotAt(vp: Viewport, subdivFor: SubdivFor, x: number): LaneSlot | null {
  if (!Number.isFinite(x)) return null

  const q = xToQuarters(vp, x)
  let col = Math.floor(q)
  let off = q - col
  // A column boundary starts the next column, on the same half-open rule.
  if (off >= 1 - BOUNDARY_EPS) {
    col += 1
    off = 0
  }

  const sd = subdivFor(col)
  const split = sd?.split ?? 1
  const i = slotIndexIn(off * split, split)
  const children = sd?.children

  // Slots before slot i: one per leaf, `child.split` per subdivided slot.
  let index = i
  if (children !== undefined) {
    index = 0
    for (let k = 0; k < i; k++) index += children[k]?.split ?? 1
  }

  const child = children?.[i] ?? null
  if (child === null) {
    return { col, slotIndex: index, start: frac(i, split), dur: frac(1, split) }
  }
  const t = child.split
  const j = slotIndexIn((off * split - i) * t, t)
  return {
    col,
    slotIndex: index + j,
    start: frac(i * t + j, split * t),
    dur: frac(1, split * t),
  }
}

/** Left edge and width of a slot's bar cell, in lane px. */
export function slotCellX(vp: Viewport, col: number, slot: { start: Frac; dur: Frac }): {
  x: number
  width: number
} {
  return {
    x: quartersToX(vp, col + toNumber(slot.start)),
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

// --- velocity resolution (§6.1, preview-aware) ------------------------------------

/** Velocity lookups for one lane frame, with the in-flight drag folded in. */
export type LaneVelocities = {
  /** Effective velocity of a note (§6.1), overridden by the drag in progress. */
  readonly velOf: (note: Note, col: number, slotIndex: number) => number
  /** The would-be velocity of an *empty* slot: the column override, else the layer default. */
  readonly ghostOf: (col: number, slotIndex: number) => number
}

/**
 * Bind a layer (and any preview) into the two lookups the lane draws with.
 *
 * The preview precedence mirrors §6.1 one level up: a per-note Alt-drag beats a
 * slot drag, which beats whatever the store currently holds.
 */
export function laneVelocities(layer: LaneLayer, preview?: LanePreview | undefined): LaneVelocities {
  const slots = preview?.slots
  const notes = preview?.notes
  return {
    velOf: (note, col, slotIndex) =>
      notes?.get(note.id) ?? slots?.get(slotKey(col, slotIndex)) ?? effectiveVelocity(note, layer),
    ghostOf: (col, slotIndex) =>
      slots?.get(slotKey(col, slotIndex)) ?? layer.colVel.get(col) ?? layer.defaultVel,
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
 * Bucket a column's notes by flattened slot index.
 *
 * Off-grid notes (§7: changing a subdivision re-quantizes nothing) land in the slot
 * that *contains* them rather than vanishing from the lane — `slotIndexAt` resolves
 * containment, not equality.
 */
export function bucketBySlot(sd: Subdiv | undefined, notes: readonly Note[]): Map<number, Note[]> {
  const out = new Map<number, Note[]>()
  for (const note of notes) {
    const index = slotIndexAt(sd, note.pos.frac)
    if (index < 0) continue
    const bucket = out.get(index)
    if (bucket) bucket.push(note)
    else out.set(index, [note])
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

  // Onsets only: a note's bar sits in the slot it starts in, so unlike the board this
  // pass needs no `maxDurQuarters` widening — a long note contributes one bar, at its
  // head, and cannot reach in from the left.
  const { start, end } = visibleCols(vp, size)
  const { velOf, ghostOf } = laneVelocities(scene.layer, scene.preview)

  const byCol = new Map<number, Note[]>()
  for (const note of scene.notesInRange(start, end)) {
    if (note.pos.col < start || note.pos.col >= end) continue
    const bucket = byCol.get(note.pos.col)
    if (bucket) bucket.push(note)
    else byCol.set(note.pos.col, [note])
  }

  const rules = new Path2D()
  const bars = new Path2D()
  const ghosts = new Path2D()
  const caps = new Path2D()
  let drawn = 0
  let anyGhost = false
  let anyBar = false

  for (let col = start; col <= end; col++) {
    const colX = quartersToX(vp, col)
    rules.moveTo(crisp(colX, dpr), 0)
    rules.lineTo(crisp(colX, dpr), h)

    const sd = scene.subdivFor(col)
    const slots = enumerateSlots(sd)
    const byslot = bucketBySlot(sd, byCol.get(col) ?? [])

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      const cellX = colX + quartersToWidth(vp, toNumber(slot.start))
      const cellW = quartersToWidth(vp, toNumber(slot.dur))
      if (cellX > size.width || cellX + cellW < 0) continue

      const { x: barX, width: barW } = slotBarX(cellX, cellW)

      const notes = byslot.get(i)
      if (notes === undefined || notes.length === 0) {
        if (!scene.showGhosts || cellW < MIN_GHOST_WIDTH) continue
        const y = px(velocityToY(h, ghostOf(col, i)), dpr)
        ghosts.rect(px(barX, dpr), y, px(barW, dpr), h - y)
        anyGhost = true
        drawn++
        continue
      }

      const segments = slotSegments(notes, (n) => velOf(n, col, i))
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
