import type { Frac, Layer, LayerId, Note, Pos, Subdiv } from '../core/types'
import type { NoteIndex } from '../core/noteIndex'
import { frac, toNumber } from '../core/frac'
import { pos as makePos } from '../core/pos'
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

/** The active layer's subdivision for a column; `undefined` means the `{split:1}` default. */
export type SubdivFor = (col: number) => Subdiv | undefined

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
 * Tolerance, in slot widths, for landing a click on a boundary.
 *
 * Spans are half-open — the boundary belongs to the slot it *starts* (§3.2) — but the
 * pointer arrives as a float, and `32/96 * 3` is `0.9999999999999999`, so a bare
 * `Math.floor` puts a click on a triplet boundary in the previous slot. The snap is
 * ~1e-7 px at any legal zoom: far below the pointer's own resolution, and it never
 * moves the *rational* result, which is built from the slot index.
 */
const BOUNDARY_EPS = 1e-9

/** Index of the slot containing `u` (in slot units), snapped up at a boundary and clamped. */
function slotIndex(u: number, count: number): number {
  let i = Math.floor(u)
  if (u - i >= 1 - BOUNDARY_EPS) i += 1
  return i < 0 ? 0 : i >= count ? count - 1 : i
}

/**
 * The slot that would receive a new stone at a screen point, or `null` outside the
 * MIDI range.
 *
 * The slot *index* comes from float pixel math; the returned `Frac` is then built from
 * that integer index through `frac.ts` — a float is never rounded into a rational
 * (§3.1). This is the likeliest place for a float to leak into the model, and the
 * denominators here (`split` and `split * child.split`) are exactly the ones
 * `enumerateSlots` produces, so the two agree by construction.
 */
export function pointToSlot(
  vp: Viewport,
  subdivFor: SubdivFor,
  x: number,
  y: number,
): SlotHit | null {
  const pitch = yToPitch(vp, y)
  if (pitch < MIN_PITCH || pitch > MAX_PITCH) return null

  const q = xToQuarters(vp, x)
  let col = Math.floor(q)
  let off = q - col
  // The column boundary starts the next column, on the same half-open rule.
  if (off >= 1 - BOUNDARY_EPS) {
    col += 1
    off = 0
  }

  const sd = subdivFor(col)
  const split = sd?.split ?? 1
  const i = slotIndex(off * split, split)
  const child = sd?.children?.[i] ?? null
  if (child === null) {
    return { pos: makePos(col, i, split), dur: frac(1, split), pitch }
  }
  // Sub-slot j of slot i starts at (i*t + j)/(s*t) — formed from integers, exactly as
  // `enumerateSlots` does, never as `i/s + j/(s*t)` in floats.
  const t = child.split
  const j = slotIndex((off * split - i) * t, t)
  return { pos: makePos(col, i * t + j, split * t), dur: frac(1, split * t), pitch }
}

/**
 * The drawn bounds of a stone (§5.2): a circle of radius `stoneRadius` for a one-slot
 * note, stretched into a lozenge when the note is longer.
 *
 * The caps are centred on the *first and last slot* the note covers, so lengthening a
 * stone grows it rightwards and never shifts its head — and an off-grid note is drawn
 * on its own span rather than snapped to a grid it does not sit on.
 *
 * `slotWidthPx` is the width of one slot of the note's layer subdivision at its onset
 * column. It defaults to `min(durWidth, pxPerQuarter)`: a slot is never wider than a
 * whole column, and a note is never narrower than the slot it was placed in (§4), so
 * the default is exact for the common cases and degrades to "one stone per column"
 * for a long note in a column whose subdivision the caller did not supply.
 */
export function noteRect(vp: Viewport, note: Note, slotWidthPx?: number): Rect {
  const durW = quartersToWidth(vp, toNumber(note.dur))
  const slotW = slotWidthPx ?? vp.pxPerQuarter
  // A degenerate `dur = 0` note still draws its head, rather than vanishing.
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
