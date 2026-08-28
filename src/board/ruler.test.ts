import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import type { Meter } from '../core/meter'
import { DEFAULT_METER } from '../core/meter'
import { drawRuler } from './ruler'
import type { Viewport } from './viewport'

/**
 * Headless coverage for the ruler's bar-number labels (§7.1).
 *
 * Before this file existed, every tick was labelled with its *containing* bar (so
 * stride-1 4/4 printed `1 1 1 1 2 2 2 2 ...`) and bar numbers went non-positive left
 * of the origin, because the anchor's bar arithmetic extrapolates backwards past it.
 * `drawRuler` batches its tick marks into a `Path2D`, which the node test environment
 * has no implementation of (same situation `lane.test.ts` and `grid.test.ts` solve),
 * so a stub stands in and only `fillText` calls are recorded — that is the surface
 * these tests care about. A recorded label is filtered to plain digits: a meter-marker
 * chip's label (`markerLabel`, e.g. "4/4") always contains a `/` and would otherwise be
 * mistaken for a bar number.
 */

class StubPath {
  moveTo(): void {}
  lineTo(): void {}
}

function paint(vp: Viewport, size: { width: number; height: number }, meterMap: readonly Meter[]) {
  const prevPath = (globalThis as { Path2D?: unknown }).Path2D
  ;(globalThis as { Path2D?: unknown }).Path2D = StubPath
  const labels: string[] = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillRect: () => {},
    fill: () => {},
    stroke: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    rect: () => {},
    fillText: (text: string) => {
      if (/^\d+$/.test(text)) labels.push(text)
    },
  } as unknown as CanvasRenderingContext2D
  try {
    drawRuler(ctx, vp, size, meterMap, {})
    return labels
  } finally {
    ;(globalThis as { Path2D?: unknown }).Path2D = prevPath
  }
}

// 96 px/quarter puts `labelStride` at 1 — every column is a tick.
const vp: Viewport = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }
const size = { width: 800, height: 28 }

describe('drawRuler bar labels', () => {
  it('labels only bar-start ticks, not every tick in the bar', () => {
    // DEFAULT_METER is 4/4: bar lines at columns 0, 4, 8. Columns 1-3, 5-7 must stay
    // unlabelled, not repeat "1" or "2".
    const labels = paint(vp, size, [DEFAULT_METER])
    expect(labels).toEqual(['1', '2', '3'])
  })

  it('numbers bars from 1, not 0', () => {
    const labels = paint(vp, size, [DEFAULT_METER])
    expect(labels[0]).toBe('1')
  })

  it('emits nothing non-positive left of the origin', () => {
    // Panned so the visible span is columns -8..1: bar lines at -8, -4 and 0 all
    // exist arithmetically (the anchor's bar length extrapolates backwards), but only
    // column 0 is bar 1 — the other two compute to bar -1 and bar 0.
    const pannedLeft: Viewport = { ...vp, xQuarters: -8 }
    const labels = paint(pannedLeft, size, [DEFAULT_METER])
    expect(labels).toEqual(['1'])
    for (const l of labels) expect(Number(l)).toBeGreaterThan(0)
  })

  it('labels bar starts under a non-default meter too', () => {
    const meter: Meter = { pos: { col: 0, frac: frac(0) }, beatUnit: frac(1, 2), groups: [3, 3] }
    // 3-quarter bars: bar lines at 0, 3, 6.
    const labels = paint(vp, { width: 700, height: 28 }, [meter])
    expect(labels).toEqual(['1', '2', '3'])
  })

  it('labels every bar of a 7/8 meter, whose 3.5-quarter bar starts are never on a tick', () => {
    // 7/8: beatUnit 1/2, groups [2,2,3] -> bar length 3.5 quarters. Bar lines at
    // 0, 3.5, 7, 10.5, 14, 17.5 - only the integer ones (0, 7, 14) ever coincide with
    // an integer-column tick, which is exactly the bug: labelling off the tick loop
    // intersected with bar starts drops every bar whose start is a half-quarter.
    const meter: Meter = { pos: { col: 0, frac: frac(0) }, beatUnit: frac(1, 2), groups: [2, 2, 3] }
    const labels = paint(vp, { width: 1800, height: 28 }, [meter])
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('keeps labelling every bar of 3/4 when zoomed out enough to skip ticks', () => {
    // Below 48 px/quarter, labelStride steps ticks by 2 columns, so only even columns
    // are ticks. 3/4's bar lines (multiples of 3) land on an even column only every
    // other bar (6, 12, 18, ...) - the same "tick ^ bar start" bug as the 7/8 case,
    // just reached by zooming out instead of by a fractional meter.
    const meter: Meter = { pos: { col: 0, frac: frac(0) }, beatUnit: frac(1), groups: [3] }
    const zoomedOut: Viewport = { ...vp, pxPerQuarter: 30 }
    const labels = paint(zoomedOut, { width: 1000, height: 28 }, [meter])
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
  })
})
