import type { Pos } from '../core/types'
import type { Meter } from '../core/meter'
import { barLinesIn, barNumberAt } from '../core/meter'
import { pos, toQuarters } from '../core/pos'
import {
  MARKER_BAND_HEIGHT, markerCenterX, markerLabel, markerWidth,
} from './meterMarkers'
import { theme } from './theme'
import { quartersToX, visibleCols, xToQuarters } from './viewport'
import type { Size, Viewport } from './viewport'

/**
 * The ruler strip. See go-spec.md §7.1.
 *
 * One surface owning column numbers, the loop region, and the playhead handle —
 * §7 binds seek, loop, and the subdivision editor here, so there is deliberately no
 * separate "column header".
 */

export const RULER_HEIGHT = 28

export type RulerState = {
  readonly loop?: { readonly start: Pos; readonly end: Pos } | undefined
  readonly playheadQuarters?: number | undefined
  /**
   * A meter marker being dragged: it is drawn at `quarters` instead of at its own
   * position, so the chip follows the pointer before the move is committed. The map
   * itself is untouched until pointerup, which is what keeps a drag one command (§7.3).
   */
  readonly meterDrag?: { readonly index: number; readonly quarters: number } | undefined
}

/**
 * The meter markers, in the top `MARKER_BAND_HEIGHT` pixels (§7.2, design §3.7).
 *
 * Drawn after the column numbers and before the playhead: a marker should sit over the
 * bar numbering it explains, but never hide the playhead handle.
 */
function drawMeterMarkers(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  meterMap: readonly Meter[],
  drag: RulerState['meterDrag'],
): void {
  const top = 1
  const height = MARKER_BAND_HEIGHT - 2
  ctx.font = '600 9px Poppins, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1

  for (let i = 0; i < meterMap.length; i++) {
    const m = meterMap[i]!
    const label = markerLabel(m)
    const width = markerWidth(label)
    const dragging = drag !== undefined && drag.index === i
    const cx = dragging ? quartersToX(vp, drag.quarters) : markerCenterX(vp, m)
    if (cx + width < 0 || cx - width > size.width) continue

    const left = Math.round(cx - width / 2)
    ctx.fillStyle = dragging ? theme.meterChipDragging : theme.meterChipBg
    ctx.beginPath()
    ctx.rect(left, top, width, height)
    ctx.fill()
    ctx.strokeStyle = theme.meterChipEdge
    ctx.stroke()
    ctx.fillStyle = theme.meterChipText
    ctx.fillText(label, left + width / 2, top + height / 2)
  }
}

/** Column-number label interval that keeps labels from colliding as you zoom out. */
function labelStride(pxPerQuarter: number): number {
  for (const stride of [1, 2, 4, 8, 16, 32]) {
    if (stride * pxPerQuarter >= 48) return stride
  }
  return 64
}

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  meterMap: readonly Meter[],
  state: RulerState,
): void {
  const h = size.height
  ctx.fillStyle = theme.rulerBg
  ctx.fillRect(0, 0, size.width, h)

  if (state.loop) {
    const x0 = quartersToX(vp, toQuarters(state.loop.start))
    const x1 = quartersToX(vp, toQuarters(state.loop.end))
    ctx.fillStyle = theme.loopFill
    ctx.fillRect(x0, 0, x1 - x0, h)
    ctx.strokeStyle = theme.loopEdge
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x0, 0)
    ctx.lineTo(x0, h)
    ctx.moveTo(x1, 0)
    ctx.lineTo(x1, h)
    ctx.stroke()
  }

  const { start, end } = visibleCols(vp, size)
  const stride = labelStride(vp.pxPerQuarter)
  const ticks = new Path2D()
  ctx.fillStyle = theme.rulerText
  ctx.font = '500 10px Poppins, sans-serif'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  for (let col = Math.ceil(start / stride) * stride; col <= end; col += stride) {
    const x = Math.round(quartersToX(vp, col)) + 0.5
    ticks.moveTo(x, h - 7)
    ticks.lineTo(x, h)
  }
  ctx.strokeStyle = theme.gutterEdge
  ctx.lineWidth = 1
  ctx.stroke(ticks)

  // Bars count from 1 at the anchor. Labels are driven off the actual bar-line
  // positions, not off the tick loop above: a bar start is frequently not an integer
  // column on a `stride` multiple (any odd-eighth meter has fractional bar starts,
  // and `labelStride` skips columns once zoomed out), so intersecting bar starts with
  // ticks silently drops those labels. Instead labels thin out by proximity to the
  // previously drawn one, and a bar number is skipped only when it is non-positive:
  // the anchor's bar arithmetic extrapolates backwards past the origin, so a bar line
  // left of it computes to bar 0, -1, ... — arithmetically real but not a bar that
  // exists.
  let lastLabelX = -Infinity
  for (const p of barLinesIn(meterMap, pos(start), pos(end))) {
    const { bar } = barNumberAt(meterMap, p)
    if (bar < 1) continue
    const x = quartersToX(vp, toQuarters(p))
    if (x - lastLabelX < 48) continue
    ctx.fillText(`${bar}`, x + 3, h - 10)
    lastLabelX = x
  }

  ctx.beginPath()
  ctx.moveTo(0, h - 0.5)
  ctx.lineTo(size.width, h - 0.5)
  ctx.strokeStyle = theme.gutterEdge
  ctx.stroke()

  drawMeterMarkers(ctx, vp, size, meterMap, state.meterDrag)

  if (state.playheadQuarters !== undefined) {
    const x = quartersToX(vp, state.playheadQuarters)
    ctx.fillStyle = theme.playhead
    ctx.beginPath()
    ctx.moveTo(x - 5, 2)
    ctx.lineTo(x + 5, 2)
    ctx.lineTo(x, 11)
    ctx.closePath()
    ctx.fill()
  }
}

/** Screen x back to a quarter position — used by seek and loop drags (§7.2). */
export const rulerXToQuarters = (vp: Viewport, x: number): number => xToQuarters(vp, x)
