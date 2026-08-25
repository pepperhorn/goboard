import type { Frac, Pos } from '../core/types'
import { mul as fracMul, toNumber as fracToNumber, frac } from '../core/frac'
import type { GridRegion } from '../core/grid'
import { DEFAULT_GRID_VALUE, slotStartsIn } from '../core/grid'
import type { Meter } from '../core/meter'
import { barLinesIn, groupLinesIn } from '../core/meter'
import { key as posKey, pos, toQuarters } from '../core/pos'
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

/**
 * Every x a bar line falls at, across the visible span (§3.7). Driven entirely by
 * `meterMap`, not by the active layer's grid — a bar line is not subject to the 4px
 * density guard `effectiveRegions` applies to the fine subdivision grid.
 */
export function barLineXs(vp: Viewport, size: Size, meterMap: readonly Meter[]): number[] {
  const { start, end } = visibleCols(vp, size)
  return barLinesIn(meterMap, pos(start), pos(end)).map((p) => quartersToX(vp, toQuarters(p)))
}

/** Every x an internal group (felt-beat) line falls at, across the visible span (§3.7). */
export function groupLineXs(vp: Viewport, size: Size, meterMap: readonly Meter[]): number[] {
  const { start, end } = visibleCols(vp, size)
  return groupLinesIn(meterMap, pos(start), pos(end)).map((p) => quartersToX(vp, toQuarters(p)))
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
 * Gridlines for the active layer's grid (§5.2 pass 2, §5.3 guard 6, §3.7).
 *
 * Three weights, in ascending prominence: intersection (`theme.gridLineSub`), group
 * (`theme.gridLine`), bar (`theme.gridLineBar`, heaviest). Bar and group lines come
 * from `meterMap` via `barLinesIn` / `groupLinesIn`, drawn as their own paths —
 * `effectiveRegions`' 4px density guard governs only the fine subdivision grid
 * (`regions`), never the meter: a bar line must never be dropped just because the
 * active layer's grid is dense at this zoom. A position in `regions`' grid that
 * coincides with a bar or group line is drawn once, at the heavier weight, rather
 * than doubled up as an intersection line too.
 */
export function drawGridlines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  regions: readonly GridRegion[],
  meterMap: readonly Meter[],
  dpr: number,
): void {
  const { start, end } = visibleCols(vp, size)
  const from = pos(start)
  const to = pos(end)
  const effective = effectiveRegions(vp, regions)
  const starts = slotStartsIn(effective, from, to)

  const barPositions = barLinesIn(meterMap, from, to)
  const groupPositions = groupLinesIn(meterMap, from, to)
  const barKeys = new Set(barPositions.map(posKey))
  const groupKeys = new Set(groupPositions.map(posKey))

  const bars = new Path2D()
  const groups = new Path2D()
  const intersections = new Path2D()

  const addLine = (path: Path2D, p: Pos): void => {
    const x = crisp(quartersToX(vp, toQuarters(p)), dpr)
    path.moveTo(x, 0)
    path.lineTo(x, size.height)
  }

  for (const p of barPositions) addLine(bars, p)
  for (const p of groupPositions) addLine(groups, p)
  for (const p of starts) {
    const k = posKey(p)
    if (barKeys.has(k) || groupKeys.has(k)) continue
    addLine(intersections, p)
  }

  ctx.lineWidth = 1
  ctx.strokeStyle = theme.gridLineSub
  ctx.stroke(intersections)
  ctx.strokeStyle = theme.gridLine
  ctx.stroke(groups)
  ctx.strokeStyle = theme.gridLineBar
  ctx.stroke(bars)
}
