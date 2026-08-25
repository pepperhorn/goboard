/**
 * Frame-time collection for the §5.3 benchmark.
 *
 * §5.3 ends with "benchmark, not prose": the 60 fps target is conditional on eight
 * specific techniques, and without a recorded number the target rots quietly as the
 * playhead, lane, and subdivision lines each add a little per-frame work. So the
 * board's draw callback is timed on every frame and the samples land here.
 *
 * A ring buffer, not an array that grows: the collector runs for the life of the page
 * and an unbounded array of 60 samples/second is a leak. Percentiles are computed on
 * demand by copying and sorting the live window — the cost lands on whoever asks, not
 * on the frame.
 *
 * The mean is deliberately not the headline number. One 40 ms frame inside a smooth
 * second is a visible hitch and barely moves a mean, which is why the snapshot reports
 * p95, the max, and an explicit count of frames over the 16.7 ms budget.
 */

export const FRAME_BUDGET_MS = 1000 / 60

export type FrameSnapshot = {
  readonly count: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  /** Frames that missed the 60 fps budget — the number that actually shows on screen. */
  readonly overBudget: number
}

export type FrameStats = {
  record(ms: number): void
  reset(): void
  readonly count: number
  snapshot(): FrameSnapshot
}

const EMPTY: FrameSnapshot = { count: 0, mean: 0, p50: 0, p95: 0, max: 0, overBudget: 0 }

/**
 * `capacity` is the window, in frames. 600 is ten seconds at 60 fps — long enough to
 * cover a scripted pan sweep, short enough that a stale warm-up frame cannot dominate
 * the p95 of a later run.
 */
export function createFrameStats(capacity = 600): FrameStats {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('createFrameStats: capacity must be a positive integer')
  }

  const ring = new Float64Array(capacity)
  let n = 0
  let next = 0

  /**
   * Nearest-rank percentile on an ascending copy. `p50` of two samples is the larger,
   * which is the conservative reading for a latency budget.
   */
  const percentile = (sorted: Float64Array, p: number): number => {
    if (sorted.length === 0) return 0
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!
  }

  return {
    record(ms: number): void {
      if (!Number.isFinite(ms)) return
      ring[next] = ms
      next = (next + 1) % capacity
      if (n < capacity) n++
    },

    reset(): void {
      n = 0
      next = 0
    },

    get count(): number {
      return n
    },

    snapshot(): FrameSnapshot {
      if (n === 0) return EMPTY
      const live = ring.slice(0, n)
      let sum = 0
      let max = 0
      let overBudget = 0
      for (const v of live) {
        sum += v
        if (v > max) max = v
        if (v > FRAME_BUDGET_MS) overBudget++
      }
      const sorted = live.slice().sort()
      return {
        count: n,
        mean: sum / n,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max,
        overBudget,
      }
    },
  }
}

/**
 * The board's collector. A module singleton because §5.3 allows exactly one rAF owner,
 * so there is exactly one thing to measure — and the benchmark page needs to reach it
 * without threading a handle through every component.
 */
export const boardFrameStats = createFrameStats()
