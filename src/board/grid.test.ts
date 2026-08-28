import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import type { GridRegion } from '../core/grid'
import type { Meter } from '../core/meter'
import { DEFAULT_METER } from '../core/meter'
import { pos } from '../core/pos'
import { barLineXs, drawGridlines, gridlineXs, groupLineXs } from './grid'

const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }
const size = { width: 384, height: 300 }

describe('gridlineXs', () => {
  it('draws one line per intersection of the active grid', () => {
    expect(gridlineXs(vp, size, [{ start: pos(0), value: frac(1, 2) }])).toEqual([
      0, 48, 96, 144, 192, 240, 288, 336, 384,
    ])
  })

  it('follows a coarse grid', () => {
    expect(gridlineXs(vp, size, [{ start: pos(0), value: frac(2) }])).toEqual([0, 192, 384])
  })

  it('drops lines closer together than 4px, per §5.3 guard 6', () => {
    const dense = [{ start: pos(0), value: frac(1, 32) }] // 3px at this zoom
    expect(gridlineXs(vp, size, dense)).toEqual([0, 96, 192, 288, 384])
  })

  // --- §5.3 guard 6's other half: sub-quarter lines below 48 px/quarter -----------

  it('falls back to the quarter stride for a sub-quarter region below 48 px/quarter', () => {
    const zoomedOut = { ...vp, pxPerQuarter: 40 } // between 24 and 48
    // A 1/8 region lands 5px apart at this zoom — not caught by the 4px guard above,
    // but still illegibly dense per the *other* guard 6 condition (§5.3).
    const fine: GridRegion[] = [{ start: pos(0), value: frac(1, 8) }]
    const quarterOnly: GridRegion[] = [{ start: pos(0), value: frac(1) }]
    expect(gridlineXs(zoomedOut, size, fine)).toEqual(gridlineXs(zoomedOut, size, quarterOnly))
  })

  it('leaves a sub-quarter region alone once zoomed in to 48 px/quarter or past it', () => {
    const zoomedIn = { ...vp, pxPerQuarter: 48 }
    const fine: GridRegion[] = [{ start: pos(0), value: frac(1, 8) }]
    const quarterOnly: GridRegion[] = [{ start: pos(0), value: frac(1) }]
    expect(gridlineXs(zoomedIn, size, fine)).not.toEqual(gridlineXs(zoomedIn, size, quarterOnly))
  })

  it('never gates a region at or coarser than a quarter, regardless of zoom', () => {
    const zoomedOut = { ...vp, pxPerQuarter: 40 }
    const coarse: GridRegion[] = [{ start: pos(0), value: frac(2) }]
    expect(gridlineXs(zoomedOut, size, coarse)).toEqual([0, 80, 160, 240, 320, 400])
  })
})

describe('barLineXs', () => {
  it('puts the heavy line on beat one of each bar', () => {
    const meter = [{ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }]
    expect(barLineXs(vp, size, meter)).toEqual([0, 288]) // every 3 quarters at 96px
  })
})

describe('groupLineXs', () => {
  it('marks the internal felt-beat boundary, excluding the bar start', () => {
    const meter = [{ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }]
    expect(groupLineXs(vp, size, meter)).toEqual([144]) // 1.5 quarters in, at 96px/quarter
  })
})

// --- drawGridlines: three weights, bar/group lines immune to the density guard ----

/**
 * `drawGridlines` batches into `Path2D`, which the node test environment has no
 * implementation of (same situation `lane.test.ts` solves for `drawLane`). Recording
 * the x's passed to `moveTo` gives the test what it needs: which weight bucket each
 * line landed in.
 */
class RecordingPath {
  static made: RecordingPath[] = []
  readonly xs: number[] = []
  constructor() {
    RecordingPath.made.push(this)
  }
  moveTo(x: number): void {
    this.xs.push(x)
  }
  lineTo(): void {}
}

const stubCtx = (): CanvasRenderingContext2D =>
  ({
    strokeStyle: '',
    lineWidth: 1,
    stroke: () => {},
  }) as unknown as CanvasRenderingContext2D

/** Run one `drawGridlines` frame and hand back the three weight paths, in construction order. */
function paintGridlines(
  regions: readonly GridRegion[],
  meterMap: readonly Meter[],
  viewport: typeof vp = vp,
) {
  const prev = (globalThis as { Path2D?: unknown }).Path2D
  ;(globalThis as { Path2D?: unknown }).Path2D = RecordingPath
  RecordingPath.made = []
  try {
    drawGridlines(stubCtx(), viewport, size, regions, meterMap, 1)
    // Construction order inside `drawGridlines`: bars, groups, intersections.
    return {
      bars: RecordingPath.made[0]!,
      groups: RecordingPath.made[1]!,
      intersections: RecordingPath.made[2]!,
    }
  } finally {
    ;(globalThis as { Path2D?: unknown }).Path2D = prev
  }
}

/**
 * `drawGridlines` snaps every x to a crisp device pixel (`crisp`, §5.3): at `dpr` 1
 * that is `Math.round(x) + 0.5`. The `barLineXs` / `groupLineXs` helpers return the
 * un-snapped logical x, so comparisons below re-apply the same offset.
 */
const crisp1 = (x: number): number => Math.round(x) + 0.5

describe('drawGridlines', () => {
  it('draws every bar line from the meter, even one the layer grid never lands on', () => {
    const meter: Meter[] = [{ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }] // 3-quarter bars
    // A grid spaced every 5 quarters: its own slots are 0, 5, 10... — never col 3,
    // where the meter's second bar line falls. If bar lines were filtered through
    // this grid's slot starts (the pre-Task-12 approach), the col-3 line would be
    // silently dropped instead of drawn.
    const regions: GridRegion[] = [{ start: pos(0), value: frac(5) }]
    const { bars } = paintGridlines(regions, meter)
    expect(bars.xs).toEqual(barLineXs(vp, size, meter).map(crisp1))
    expect(bars.xs).toContain(crisp1(288))
  })

  it('classifies group lines separately from bar and intersection lines', () => {
    const meter: Meter[] = [{ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }]
    const regions: GridRegion[] = [{ start: pos(0), value: frac(1, 2) }]
    const { bars, groups, intersections } = paintGridlines(regions, meter)
    expect(bars.xs).toEqual(barLineXs(vp, size, meter).map(crisp1))
    expect(groups.xs).toEqual(groupLineXs(vp, size, meter).map(crisp1))
    // Every other eighth-note slot in [0, 4] quarters, minus the bar and group lines.
    expect(intersections.xs).toEqual([48, 96, 192, 240, 336, 384].map(crisp1))
  })

  it('drops a sub-quarter region below 48 px/quarter, leaving the meter\'s bar/group lines intact', () => {
    const zoomedOut = { ...vp, pxPerQuarter: 40 } // between 24 and 48
    // A 1/8 region lands 5px apart at this zoom — the reproduction in the review that
    // caught this. Under DEFAULT_METER (plain 4/4), the quarter-stride fallback lands
    // exactly on the meter's own bar/group lines, so nothing is left over to draw as
    // an intersection.
    const fine: GridRegion[] = [{ start: pos(0), value: frac(1, 8) }]
    const { bars, groups, intersections } = paintGridlines(fine, [DEFAULT_METER], zoomedOut)
    expect(intersections.xs).toEqual([])
    expect(bars.xs.length).toBeGreaterThan(0)
    expect(groups.xs.length).toBeGreaterThan(0)
  })
})
