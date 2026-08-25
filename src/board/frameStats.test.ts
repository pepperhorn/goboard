import { describe, expect, it } from 'vitest'
import { FRAME_BUDGET_MS, createFrameStats } from './frameStats'

describe('createFrameStats (§5.3)', () => {
  it('is empty before the first sample', () => {
    const stats = createFrameStats()
    expect(stats.count).toBe(0)
    expect(stats.snapshot()).toEqual({ count: 0, mean: 0, p50: 0, p95: 0, max: 0, overBudget: 0 })
  })

  it('reports mean, percentiles and the max', () => {
    const stats = createFrameStats()
    for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) stats.record(ms)

    const s = stats.snapshot()
    expect(s.count).toBe(10)
    expect(s.mean).toBeCloseTo(5.5, 10)
    expect(s.p50).toBe(5) // nearest rank: ceil(0.5 * 10) = 5th smallest
    expect(s.p95).toBe(10)
    expect(s.max).toBe(10)
  })

  it('sorts numerically, not as strings', () => {
    // The trap a plain `Array.sort` falls into: "9" > "10".
    const stats = createFrameStats()
    for (const ms of [9, 10, 11, 100]) stats.record(ms)
    expect(stats.snapshot().p50).toBe(10)
    expect(stats.snapshot().max).toBe(100)
  })

  it('counts frames over the 60 fps budget', () => {
    const stats = createFrameStats()
    stats.record(4)
    stats.record(FRAME_BUDGET_MS) // exactly on budget is not over it
    stats.record(FRAME_BUDGET_MS + 0.5)
    stats.record(40)
    expect(stats.snapshot().overBudget).toBe(2)
  })

  it('keeps only the last `capacity` samples', () => {
    const stats = createFrameStats(3)
    for (const ms of [100, 100, 100, 1, 2, 3]) stats.record(ms)

    const s = stats.snapshot()
    expect(s.count).toBe(3)
    expect(s.max).toBe(3) // the 100s have rolled out of the window
    expect(s.mean).toBeCloseTo(2, 10)
  })

  it('reset drops the window so a warm-up cannot skew the run', () => {
    const stats = createFrameStats()
    stats.record(80)
    stats.reset()
    expect(stats.count).toBe(0)
    stats.record(4)
    expect(stats.snapshot()).toMatchObject({ count: 1, max: 4 })
  })

  it('ignores non-finite samples rather than poisoning the percentiles', () => {
    const stats = createFrameStats()
    stats.record(5)
    stats.record(Number.NaN)
    stats.record(Number.POSITIVE_INFINITY)
    expect(stats.snapshot()).toMatchObject({ count: 1, max: 5 })
  })

  it('rejects a nonsensical capacity', () => {
    expect(() => createFrameStats(0)).toThrow(RangeError)
    expect(() => createFrameStats(1.5)).toThrow(RangeError)
  })
})
