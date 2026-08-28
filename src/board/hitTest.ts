import type { Frac, Layer, LayerId, Note, Pos } from '../core/types'
import type { NoteIndex } from '../core/noteIndex'
import type { GridCursor } from '../core/gridCursor'
import { toNumber } from '../core/frac'
import { add as posAdd } from '../core/pos'
import { quartersToPos } from '../core/tempo'
import type { Viewport } from './viewport'
import {
  MAX_PITCH, MIN_PITCH, pitchToCenterY, posToX, quartersToWidth, stoneRadius, xToQuarters,
  yToPitch,
} from './viewport'

/**
 * Pointer → model resolution. See go-spec.md §7.3.
 *
 * Pure and headless: no canvas, no DOM, no React. Everything here is a function of a
 * `Viewport`, the note index, the layer's subdivisions, and a screen point, so the
 * gesture layer can be tested without a surface.
 *
 * Two distinct questions live here and must not be confused (§7.3):
 *   - `pointToSlot` — *where would a new stone go?* Slot resolution, exact rational.
 *   - `hitNote` — *is there a stone under the pointer?* Geometric, against the drawn
 *     rectangle. Slot-based hit testing would make off-grid notes (§7: changing a
 *     subdivision re-quantizes nothing) visible but permanently unclickable.
 *
 * `noteRect` is exported because the renderer must draw the identical geometry — one
 * function, so hit testing and drawing cannot drift apart.
 */

/** The slot a click resolves to: an exact rational onset, its duration, and the row. */
export type SlotHit = { readonly pos: Pos; readonly dur: Frac; readonly pitch: number }

/** Drawn bounds of a stone, in screen pixels. */
export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The layer facts hit testing needs; a whole `Layer` satisfies it. */
export type HitLayer = Pick<Layer, 'id' | 'order' | 'visible'>

export type HitOptions = {
  /** Test non-active layers too — only the §7.2 double-click "promote layer" gesture. */
  readonly includeInactive?: boolean
  /**
   * Drawn slot width in px for a note, when the caller knows the note's layer
   * subdivision. Must be the same value the renderer used, or hits and pixels
   * disagree. Omitted: `noteRect`'s default (see there).
   */
  readonly slotWidthPx?: (note: Note) => number
}

/**
 * The slot that would receive a new stone at a screen point, or `null` outside the
 * MIDI range.
 *
 * Stones sit on intersections (design doc): the pointer resolves to whichever
 * intersection is *nearer*, not the cell it falls inside. The float pixel position is
 * used only to pick a side — `quartersToPos` turns `x` into an approximate `Pos` just
 * well enough to ask the cursor which slot governs it, and every returned value
 * (`slot.start`, `slot.start + slot.dur`) comes back out of exact region maths. The
 * approximated `Pos` itself is never returned or stored (§3.1) — only used to choose
 * *which* slot to query.
 */
export function pointToSlot(
  vp: Viewport,
  cursor: GridCursor,
  x: number,
  y: number,
): SlotHit | null {
  const pitch = yToPitch(vp, y)
  if (pitch < MIN_PITCH || pitch > MAX_PITCH) return null

  const approx = quartersToPos(xToQuarters(vp, x))
  const slot = cursor.slotAt(approx)
  const end = posAdd(slot.start, slot.dur)

  const startX = posToX(vp, slot.start)
  const endX = posToX(vp, end)
  if (Math.abs(x - endX) < Math.abs(x - startX)) {
    // The nearer intersection is the one where the NEXT slot starts — its own
    // duration (possibly clipped again) is what a stone placed there inherits.
    const next = cursor.slotAt(end)
    return { pos: next.start, dur: next.dur, pitch }
  }
  return { pos: slot.start, dur: slot.dur, pitch }
}

/**
 * The drawn bounds of a stone (§5.2): a circle of radius `stoneRadius` for a one-slot
 * note, stretched into a lozenge when the note is longer.
 *
 * The caps are centred on the *first and last slot* the note covers, so lengthening a
 * stone grows it rightwards and never shifts its head — and an off-grid note is drawn
 * on its own span rather than snapped to a grid it does not sit on.
 *
 * `slotWidthPx` is the width, in px, of the grid slot the note was placed in. A grid
 * line spacing can be coarser than one column (§3.2 — a whole-note grid, say), so
 * unlike the old per-column `Subdiv`, a slot is NOT assumed to be at most one column
 * wide; the caller-supplied width is honoured as given, never re-clamped to
 * `vp.pxPerQuarter`. Omitted, it falls back to the note's own duration — the least
 * assuming guess when the caller has no grid to consult — rather than a column.
 */
export function noteRect(vp: Viewport, note: Note, slotWidthPx?: number): Rect {
  const durW = quartersToWidth(vp, toNumber(note.dur))
  // A degenerate `dur = 0` note still draws its head, rather than vanishing — the
  // fallback can't be `durW` itself then, so it drops back to one quarter.
  const slotW = slotWidthPx ?? (durW > 0 ? durW : vp.pxPerQuarter)
  const unit = durW > 0 ? Math.min(slotW, durW) : slotW
  const r = stoneRadius(vp, unit)

  const x0 = posToX(vp, note.pos)
  const left = x0 + unit / 2 - r
  const right = x0 + Math.max(durW, unit) - unit / 2 + r
  return {
    x: left,
    y: pitchToCenterY(vp, note.pitch) - r,
    width: right - left,
    height: 2 * r,
  }
}

const contains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height

/**
 * Layers in hit priority — the inverse of draw order: active first, then descending
 * `order` (§7.3). Hidden layers are never hit; non-active layers are pointer-
 * transparent unless `includeInactive`.
 */
function hitOrder(
  layers: readonly HitLayer[],
  activeLayerId: LayerId,
  includeInactive: boolean,
): HitLayer[] {
  const active = layers.filter((l) => l.visible && l.id === activeLayerId)
  if (!includeInactive) return active
  const rest = layers
    .filter((l) => l.visible && l.id !== activeLayerId)
    .sort((a, b) => b.order - a.order)
  return [...active, ...rest]
}

/**
 * The note under a screen point, or `null`.
 *
 * Geometric, not slot-based (§7.3): the point is tested against each candidate's drawn
 * rectangle. Candidates come from `NoteIndex.hitCandidates`, which widens its column
 * scan by `ceil(maxDurQuarters)` — that widening is what makes the far end of a long
 * lozenge hittable at all, since long notes are indexed at their onset only (§4.1) —
 * and which already sorts by the §7.3 tie rule: shortest duration, then most recently
 * added.
 */
export function hitNote(
  vp: Viewport,
  index: NoteIndex,
  layers: readonly HitLayer[],
  activeLayerId: LayerId,
  x: number,
  y: number,
  opts: HitOptions = {},
): Note | null {
  const pitch = yToPitch(vp, y)
  if (pitch < MIN_PITCH || pitch > MAX_PITCH) return null
  // A stone never leaves its own row or its own span, so one column and one pitch
  // bound the search; the rectangle test does the rest.
  const col = Math.floor(xToQuarters(vp, x))

  for (const layer of hitOrder(layers, activeLayerId, opts.includeInactive === true)) {
    for (const note of index.hitCandidates(layer.id, col, pitch)) {
      if (contains(noteRect(vp, note, opts.slotWidthPx?.(note)), x, y)) return note
    }
  }
  return null
}

/** Widest right-edge resize zone, in px (§7.3). */
export const RESIZE_ZONE_MAX_PX = 6
/** Below this drawn stone width the zone is disabled entirely (§7.3). */
export const RESIZE_ZONE_MIN_STONE_PX = 10

/**
 * Is `x` inside the note's right-edge resize hot zone? Assumes the point already hit
 * the note, so only the horizontal position matters.
 *
 * The zone is `min(6px, stoneWidth * 0.25)` and is **disabled** below a 16 px stone: at
 * minimum zoom the stone is 6.7 px across, and a fixed 6 px zone would swallow it whole
 * and leave click-to-remove unreachable (§7.3).
 */
export function resizeZone(vp: Viewport, note: Note, x: number, slotWidthPx?: number): boolean {
  const rect = noteRect(vp, note, slotWidthPx)
  if (rect.width < RESIZE_ZONE_MIN_STONE_PX) return false
  const zone = Math.min(RESIZE_ZONE_MAX_PX, rect.width * 0.25)
  const right = rect.x + rect.width
  return x >= right - zone && x <= right
}

/** Movement that turns a click into a drag, per pointer type (§7.3). */
export const DRAG_THRESHOLD_MOUSE = 4
export const DRAG_THRESHOLD_TOUCH = 10

export type DragLatch = {
  /** True once the threshold has been crossed. */
  readonly dragging: boolean
  /** Feed the current pointer position; returns the latched state. */
  update(x: number, y: number): boolean
}

/**
 * A one-way latch: crossing the threshold latches "drag" **permanently** (§7.3).
 *
 * Returning to the origin must never re-arm the click, or a 2 px twitch during an
 * intended move deletes the note under the pointer.
 */
export function createDragLatch(
  originX: number,
  originY: number,
  threshold: number = DRAG_THRESHOLD_MOUSE,
): DragLatch {
  const limit = threshold * threshold
  let latched = false
  return {
    get dragging() {
      return latched
    },
    update(x: number, y: number): boolean {
      if (!latched) {
        const dx = x - originX
        const dy = y - originY
        if (dx * dx + dy * dy > limit) latched = true
      }
      return latched
    },
  }
}
