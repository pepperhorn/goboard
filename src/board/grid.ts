import type { Subdiv } from '../core/types'
import { slotCount } from '../core/subdiv'
import { isWhiteKey, theme } from './theme'
import {
  pitchToY, quartersToX, visibleCols, visiblePitches,
} from './viewport'
import type { Size, Viewport } from './viewport'

/**
 * Row shading and gridlines. See go-spec.md §5.2 passes 1–2 and §5.3.
 *
 * Every line in a pass batches into ONE `Path2D` and one `stroke()`. The worst case
 * — 33 columns of 16x16 subdivision — is 8,400 lines; stroked individually that is
 * ~12 ms, batched it is ~0.5 ms.
 */

/** Supplies the active layer's subdivision for a column. */
export type SubdivFor = (col: number) => Subdiv | undefined

/** Snap to a device pixel and offset by half, so a 1px line lands crisp (§5.3). */
const crisp = (v: number, dpr: number): number => Math.round(v * dpr) / dpr + 0.5 / dpr

export function drawRows(ctx: CanvasRenderingContext2D, vp: Viewport, size: Size): void {
  ctx.fillStyle = theme.boardBg
  ctx.fillRect(0, 0, size.width, size.height)

  const { lo, hi } = visiblePitches(vp, size)
  // Two passes, one fillStyle assignment each, rather than one per row.
  for (const white of [true, false]) {
    ctx.fillStyle = white ? theme.rowWhite : theme.rowBlack
    for (let p = lo; p <= hi; p++) {
      if (isWhiteKey(p) !== white) continue
      ctx.fillRect(0, pitchToY(vp, p), size.width, vp.pxPerSemitone)
    }
  }

  // Octave separators read as the seams between keyboards.
  const path = new Path2D()
  for (let p = lo; p <= hi; p++) {
    if (p % 12 !== 0) continue
    const y = pitchToY(vp, p) + vp.pxPerSemitone
    path.moveTo(0, y)
    path.lineTo(size.width, y)
  }
  ctx.strokeStyle = theme.gridLine
  ctx.lineWidth = 1
  ctx.stroke(path)
}

export function drawGridlines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  subdivFor: SubdivFor,
  dpr: number,
): void {
  const { start, end } = visibleCols(vp, size)

  const quarters = new Path2D()
  const bars = new Path2D()
  for (let col = start; col <= end; col++) {
    const x = crisp(quartersToX(vp, col), dpr)
    const target = col % 4 === 0 ? bars : quarters
    target.moveTo(x, 0)
    target.lineTo(x, size.height)
  }

  ctx.lineWidth = 1
  ctx.strokeStyle = theme.gridLine
  ctx.stroke(quarters)
  ctx.strokeStyle = theme.gridLineBar
  ctx.stroke(bars)

  // Subdivision lines belong to the ACTIVE layer only — every layer's grid at once
  // would be noise (§5.2).
  if (vp.pxPerQuarter < 48) return

  const shallow = new Path2D()
  const deep = new Path2D()
  let any = false

  for (let col = start; col <= end; col++) {
    const sd = subdivFor(col)
    if (!sd || sd.split <= 1) continue
    const colX = quartersToX(vp, col)
    const slotW = vp.pxPerQuarter / sd.split
    if (slotW < 4) continue

    for (let i = 1; i < sd.split; i++) {
      const x = crisp(colX + i * slotW, dpr)
      shallow.moveTo(x, 0)
      shallow.lineTo(x, size.height)
      any = true
    }

    if (!sd.children) continue
    for (let i = 0; i < sd.split; i++) {
      const child = sd.children[i]
      if (!child || child.split <= 1) continue
      const childW = slotW / child.split
      if (childW < 4) continue
      for (let j = 1; j < child.split; j++) {
        const x = crisp(colX + i * slotW + j * childW, dpr)
        deep.moveTo(x, 0)
        deep.lineTo(x, size.height)
        any = true
      }
    }
  }

  if (!any) return
  ctx.strokeStyle = theme.gridLineSub
  ctx.stroke(shallow)
  ctx.strokeStyle = theme.gridLineSubDeep
  ctx.stroke(deep)
}

/** Worst-case line count for a column, used by the perf benchmark. */
export const gridLinesForColumn = (sd: Subdiv | undefined): number =>
  sd ? slotCount(sd) - 1 : 0
