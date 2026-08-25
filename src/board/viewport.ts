import type { Pos } from '../core/types'
import { toQuarters } from '../core/pos'

/**
 * The board's coordinate system. See go-spec.md §5.1.
 *
 * One `Viewport` is shared by the board, ruler, gutter, and velocity lane — they
 * must never derive their own (§5.3). It lives in the vanilla store, not React,
 * because pan and zoom write 60x/second (§2).
 */
export type Viewport = {
  /** Absolute quarter-note position at the left edge. */
  readonly xQuarters: number
  /** MIDI pitch at the top edge; pitch increases upward. */
  readonly yPitch: number
  readonly pxPerQuarter: number
  readonly pxPerSemitone: number
}

/** Pixel size of a board surface. */
export type Size = { readonly width: number; readonly height: number }

export const MIN_PX_PER_QUARTER = 24
export const MAX_PX_PER_QUARTER = 512
export const MIN_PX_PER_SEMITONE = 8
export const MAX_PX_PER_SEMITONE = 48

export const MIN_PITCH = 0
export const MAX_PITCH = 127

/** The board's vertical anchor row, C3 (§4). */
export const ANCHOR_PITCH = 48

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Initial view: col 0 at the left edge, C3 vertically centered, 96 px/quarter,
 * 16 px/semitone (§5.1).
 */
export function initialViewport(size: Size): Viewport {
  const pxPerSemitone = 16
  const rows = size.height / pxPerSemitone
  return clampVertical(
    { xQuarters: 0, yPitch: ANCHOR_PITCH + rows / 2, pxPerQuarter: 96, pxPerSemitone },
    size,
  )
}

/**
 * Keep the visible pitch band inside 0–127.
 *
 * When the band is taller than the MIDI range the clamp would fight itself, so the
 * band is centered instead — otherwise zooming out far enough would jam the board
 * against one end.
 */
export function clampVertical(vp: Viewport, size: Size): Viewport {
  const rows = size.height / vp.pxPerSemitone
  const span = MAX_PITCH - MIN_PITCH + 1
  const top = rows >= span
    ? MIN_PITCH + (span + rows) / 2
    : clamp(vp.yPitch, MIN_PITCH + rows, MAX_PITCH + 1)
  return top === vp.yPitch ? vp : { ...vp, yPitch: top }
}

// --- horizontal ---

export const quartersToX = (vp: Viewport, q: number): number =>
  (q - vp.xQuarters) * vp.pxPerQuarter

export const xToQuarters = (vp: Viewport, x: number): number =>
  vp.xQuarters + x / vp.pxPerQuarter

export const posToX = (vp: Viewport, p: Pos): number => quartersToX(vp, toQuarters(p))

/** Width in pixels of a duration measured in quarter notes. */
export const quartersToWidth = (vp: Viewport, q: number): number => q * vp.pxPerQuarter

// --- vertical ---

/** Screen y of the TOP edge of a pitch row. */
export const pitchToY = (vp: Viewport, pitch: number): number =>
  (vp.yPitch - pitch) * vp.pxPerSemitone

/** Screen y of the CENTER of a pitch row — where stones are drawn. */
export const pitchToCenterY = (vp: Viewport, pitch: number): number =>
  pitchToY(vp, pitch) + vp.pxPerSemitone / 2

/**
 * The pitch row containing screen y — the inverse of `pitchToY`.
 *
 * Ceils, not floors: row `p` spans `[(yPitch-p)*s, (yPitch-p+1)*s)`, so solving for
 * `p` gives `p = ceil(yPitch - y/s)`. Flooring lands one row off everywhere except
 * exactly on a row's top edge, which is the axis-inversion trap §5.1 warns about.
 */
export const yToPitch = (vp: Viewport, y: number): number =>
  Math.ceil(vp.yPitch - y / vp.pxPerSemitone)

// --- visible ranges ---

/**
 * Half-open column range covering the surface, widened by `margin` columns.
 *
 * Callers pass `ceil(maxDurQuarters)` as the margin, not 1 — a note whose onset is
 * left of the viewport can still have a lozenge inside it (§4.1, §5.3).
 */
export function visibleCols(vp: Viewport, size: Size, margin = 0): { start: number; end: number } {
  const start = Math.floor(xToQuarters(vp, 0)) - margin
  const end = Math.ceil(xToQuarters(vp, size.width)) + margin
  return { start, end }
}

/** Inclusive pitch range covering the surface, clamped to the MIDI range. */
export function visiblePitches(vp: Viewport, size: Size): { lo: number; hi: number } {
  const hi = Math.min(MAX_PITCH, Math.ceil(vp.yPitch))
  const lo = Math.max(MIN_PITCH, yToPitch(vp, size.height))
  return { lo, hi }
}

// --- gestures ---

export function panBy(vp: Viewport, dxPx: number, dyPx: number, size: Size): Viewport {
  return clampVertical(
    {
      ...vp,
      xQuarters: vp.xQuarters - dxPx / vp.pxPerQuarter,
      yPitch: vp.yPitch + dyPx / vp.pxPerSemitone,
    },
    size,
  )
}

/**
 * Zoom about a fixed screen point, so the musical position under the cursor does
 * not move (§5.1). Pass `factorY = 1` for a horizontal-only zoom.
 */
export function zoomAbout(
  vp: Viewport,
  anchorX: number,
  anchorY: number,
  factorX: number,
  factorY: number,
  size: Size,
): Viewport {
  const qAtAnchor = xToQuarters(vp, anchorX)
  const pxPerQuarter = clamp(vp.pxPerQuarter * factorX, MIN_PX_PER_QUARTER, MAX_PX_PER_QUARTER)
  const pxPerSemitone = clamp(vp.pxPerSemitone * factorY, MIN_PX_PER_SEMITONE, MAX_PX_PER_SEMITONE)

  // Solve for the origin that keeps the anchor's musical coordinate fixed. The
  // vertical axis is inverted, hence the sign difference.
  const pitchAtAnchor = vp.yPitch - anchorY / vp.pxPerSemitone
  return clampVertical(
    {
      xQuarters: qAtAnchor - anchorX / pxPerQuarter,
      yPitch: pitchAtAnchor + anchorY / pxPerSemitone,
      pxPerQuarter,
      pxPerSemitone,
    },
    size,
  )
}

/** True when stones are too small for the layer ring to read (§5.3 LOD). */
/**
 * Screen translation between two viewports, rounded to whole device pixels — the
 * §5.3 self-blit's input.
 *
 * `null` means "no blit is possible": the zoom changed (every pixel moves, not just
 * shifts), or the shift is at least a full surface (nothing of the old frame survives,
 * so copying it is pure cost).
 *
 * The rounding is what makes the blit exact. A fractional offset would resample the
 * whole board every frame — slower than the redraw it replaces, and blurry. The caller
 * pairs this with `shiftedViewport` so the fraction that was rounded away is *carried*
 * rather than accumulated: the canvas then holds a coherent picture of a viewport
 * within half a device pixel of the true one, instead of drifting a little each frame.
 */
export function panDelta(
  from: Viewport,
  to: Viewport,
  size: Size,
  dpr: number,
): { readonly dx: number; readonly dy: number } | null {
  if (from.pxPerQuarter !== to.pxPerQuarter || from.pxPerSemitone !== to.pxPerSemitone) return null

  const dx = Math.round((from.xQuarters - to.xQuarters) * to.pxPerQuarter * dpr) / dpr
  const dy = Math.round((to.yPitch - from.yPitch) * to.pxPerSemitone * dpr) / dpr
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
  if (Math.abs(dx) >= size.width || Math.abs(dy) >= size.height) return null
  return { dx, dy }
}

/** The viewport a surface actually shows after being blitted by `delta` (§5.3). */
export function shiftedViewport(
  from: Viewport,
  delta: { readonly dx: number; readonly dy: number },
): Viewport {
  return {
    ...from,
    xQuarters: from.xQuarters - delta.dx / from.pxPerQuarter,
    yPitch: from.yPitch + delta.dy / from.pxPerSemitone,
  }
}

export const stoneRadius = (vp: Viewport, slotWidthPx: number): number =>
  Math.min(vp.pxPerSemitone, slotWidthPx) * 0.42

export const RING_LOD_RADIUS = 4
