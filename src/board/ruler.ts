import type { Pos } from '../core/types'
import type { Meter } from '../core/meter'
import { barNumberAt } from '../core/meter'
import { pos, toQuarters } from '../core/pos'
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
    const { bar } = barNumberAt(meterMap, pos(col))
    ctx.fillText(`${bar}`, x + 3, h - 10)
  }
  ctx.strokeStyle = theme.gutterEdge
  ctx.lineWidth = 1
  ctx.stroke(ticks)

  ctx.beginPath()
  ctx.moveTo(0, h - 0.5)
  ctx.lineTo(size.width, h - 0.5)
  ctx.strokeStyle = theme.gutterEdge
  ctx.stroke()

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
