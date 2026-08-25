import type { Frac, Subdiv } from '../core/types'
import { slotCount } from '../core/subdiv'
import { isZero as fracIsZero, mul as fracMul, toNumber as fracToNumber, frac } from '../core/frac'
import type { GridRegion } from '../core/grid'
import { DEFAULT_GRID_VALUE, slotStartsIn } from '../core/grid'
import { pos, toQuarters } from '../core/pos'
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

/** Snap to a device pixel and offset by half, so a 1px line lands crisp (§5.3). */
const crisp = (v: number, dpr: number): number => Math.round(v * dpr) / dpr + 0.5 / dpr

/** No line may be drawn closer than this to its neighbor (§5.3 guard 6). */
const MIN_LINE_PX = 4

/**
 * The quarter-note stride, doubled as many times as it takes to clear `MIN_LINE_PX`
 * at this zoom. `pxPerQuarter` is at least `MIN_PX_PER_QUARTER` (24) in practice, so
 * this loop never actually iterates — it exists for the theoretical case where it
 * would (ruling F2).
 */
function coarseQuarterStride(vp: Viewport): Frac {
  let value = DEFAULT_GRID_VALUE
  while (fracToNumber(value) * vp.pxPerQuarter < MIN_LINE_PX) {
    value = fracMul(value, frac(2))
  }
  return value
}

/**
 * The regions actually used to draw: a region whose own line spacing would land
 * closer than `MIN_LINE_PX` apart contributes none of its own lines — it falls back
 * to the (possibly further-coarsened) quarter stride over its span instead (§5.3
 * guard 6, ruling F2). A region coarser than a quarter is left alone: its own,
 * sparser intersections are what should be drawn, not a union with the quarter grid.
 */
function effectiveRegions(vp: Viewport, regions: readonly GridRegion[]): readonly GridRegion[] {
  let fallback: Frac | undefined
  return regions.map((region) => {
    if (fracToNumber(region.value) * vp.pxPerQuarter >= MIN_LINE_PX) return region
    fallback ??= coarseQuarterStride(vp)
    return { start: region.start, value: fallback }
  })
}

/**
 * Every x (device-independent px) a gridline should be drawn at, across the visible
 * span — one line per intersection of the active grid (§3.2, §5.3 guard 6).
 */
export function gridlineXs(vp: Viewport, size: Size, regions: readonly GridRegion[]): number[] {
  const { start, end } = visibleCols(vp, size)
  const from = pos(start)
  const to = pos(end)
  const effective = effectiveRegions(vp, regions)
  return slotStartsIn(effective, from, to).map((p) => quartersToX(vp, toQuarters(p)))
}

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

/**
 * Gridlines for the active layer's grid (§5.2 pass 2, §5.3 guard 6).
 *
 * Every intersection of `regions`' active grid draws a line, batched by weight: bar
 * (`col % 4 === 0` — Task 12 replaces this with the meter map), quarter, and
 * sub-quarter. `gridlineXs` already drops anything that would draw closer than 4px
 * apart, so there is no separate zoom gate here.
 */
export function drawGridlines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  regions: readonly GridRegion[],
  dpr: number,
): void {
  const { start, end } = visibleCols(vp, size)
  const from = pos(start)
  const to = pos(end)
  const effective = effectiveRegions(vp, regions)
  const starts = slotStartsIn(effective, from, to)

  const bars = new Path2D()
  const quarters = new Path2D()
  const sub = new Path2D()

  for (const p of starts) {
    const x = crisp(quartersToX(vp, toQuarters(p)), dpr)
    const target = fracIsZero(p.frac) ? (p.col % 4 === 0 ? bars : quarters) : sub
    target.moveTo(x, 0)
    target.lineTo(x, size.height)
  }

  ctx.lineWidth = 1
  ctx.strokeStyle = theme.gridLine
  ctx.stroke(quarters)
  ctx.strokeStyle = theme.gridLineBar
  ctx.stroke(bars)
  ctx.strokeStyle = theme.gridLineSub
  ctx.stroke(sub)
}

/** Worst-case line count for a column, used by the perf benchmark. */
export const gridLinesForColumn = (sd: Subdiv | undefined): number =>
  sd ? slotCount(sd) - 1 : 0
