import type { Frac, Pos, TempoEvent } from './types'
import { normalize } from './frac'
import { add as padd, canonicalize, cmp as pcmp, eq as peq, pos as mkPos, toQuarters } from './pos'

/**
 * Tempo map and seconds conversion. See go-spec.md §3.3.
 *
 * Tempo is piecewise-**constant**, so seconds is piecewise-**linear** in quarters:
 * within a segment `seconds = segSeconds + (quarters - segQuarters) * 60 / bpm`. A v2
 * tempo *ramp* is logarithmic (`t = 60*dq*ln(b1/b0)/(b1-b0)`) with an exponential
 * inverse and must not inherit this formula.
 *
 * Every segment slope `60 / bpm` is strictly positive, so the map is strictly
 * increasing and invertible in closed form: `secondsToPos` is a binary search over the
 * prefix seconds plus one multiply, O(log n) — and O(1) amortized during playback via
 * `createTempoCursor`, since the playhead only advances.
 *
 * This module is the only place where rational time becomes floating-point seconds
 * (§3.1). Positions and durations stay rational on the way in and on the way out.
 */

/** Slowest tempo the 24-bit microseconds-per-quarter MIDI tempo meta can express. */
export const MIN_BPM = 3.576

/** Fastest tempo we accept. */
export const MAX_BPM = 999

/** Tempo assumed when the caller supplies nothing at or before col 0. */
export const DEFAULT_BPM = 120

/**
 * Largest denominator `secondsToPos` will produce.
 *
 * The playhead is a float, so its position is approximate by construction; this bound
 * keeps the resulting `Frac` well inside the §3.1 lattice (1e6 vs L = 5.19e11) while
 * still recovering small-denominator positions — 1/3, 5/12, 11/13 — exactly.
 */
export const PLAYHEAD_MAX_DEN = 1_000_000

/**
 * A validated tempo map with its prefix arrays precomputed.
 *
 * All three arrays share indices: `events[i]` starts at absolute quarter `quarters[i]`,
 * which is `seconds[i]` seconds from col 0. `quarters` and `seconds` are both strictly
 * increasing (coincident events are de-duplicated at build time), so no binary search
 * can land inside a zero-length segment.
 */
export type TempoMap = {
  readonly events: readonly TempoEvent[]
  readonly quarters: readonly number[]
  readonly seconds: readonly number[]
}

/** A monotone playback cursor over a `TempoMap`. */
export type TempoCursor = {
  /** Absolute quarters at `s` seconds. O(1) amortized while `s` advances. */
  secondsToQuarters(s: number): number
  /** The same instant as a `Pos`, for the playhead. */
  secondsToPos(s: number): Pos
  /** Drop the cached segment — call on seek or stop (not required for correctness). */
  reset(): void
}

function checkBpm(bpm: number, i: number): void {
  if (!Number.isFinite(bpm)) throw new RangeError(`TempoMap: event ${i} has non-finite bpm`)
  if (bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new RangeError(`TempoMap: event ${i} bpm ${bpm} outside [${MIN_BPM}, ${MAX_BPM}]`)
  }
}

function checkPos(p: Pos, i: number): void {
  // Re-canonicalizing must be a no-op: an event carrying frac >= 1 or frac < 0 would
  // sort and key differently from the same instant written canonically.
  if (!peq(p, canonicalize(p.col, p.frac))) {
    throw new RangeError(`TempoMap: event ${i} pos is not canonical`)
  }
}

/**
 * Validate, normalize and precompute.
 *
 * - `bpm` must lie in `[MIN_BPM, MAX_BPM]`.
 * - Events must already be sorted by `pos` (an unsorted list is a caller bug, not
 *   something to silently repair — the order carries the user's intent).
 * - Coincident positions are de-duplicated, **last wins**, so every segment has
 *   positive length (§3.3).
 * - An implicit `{pos: col 0, bpm: 120}` is prepended unless the caller supplies an
 *   event at or before col 0.
 *
 * Seconds are anchored so that `toSeconds(map, ORIGIN) === 0` — col 0 is the time
 * origin whether or not an event sits there.
 */
export function buildTempoMap(events: readonly TempoEvent[]): TempoMap {
  const kept: TempoEvent[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    checkBpm(e.bpm, i)
    checkPos(e.pos, i)
    const prev = kept[kept.length - 1]
    if (prev) {
      const c = pcmp(prev.pos, e.pos)
      if (c > 0) throw new RangeError(`TempoMap: event ${i} is out of order`)
      if (c === 0) kept.pop() // coincident: last wins
    }
    kept.push({ pos: e.pos, bpm: e.bpm })
  }

  const first = kept[0]
  if (!first || first.pos.col > 0 || (first.pos.col === 0 && first.pos.frac.n > 0)) {
    kept.unshift({ pos: mkPos(0), bpm: DEFAULT_BPM })
  }

  const quarters: number[] = []
  const seconds: number[] = []
  let acc = 0
  for (let i = 0; i < kept.length; i++) {
    const q = toQuarters(kept[i]!.pos)
    if (i > 0) acc += (q - quarters[i - 1]!) * 60 / kept[i - 1]!.bpm
    quarters.push(q)
    seconds.push(acc)
  }

  const draft: TempoMap = { events: kept, quarters, seconds }
  // Shift the prefix so col 0 is t = 0. This is a no-op for the common case (an event
  // at col 0); it only matters when the caller anchors tempo before col 0.
  const shift = secondsAtQuarters(draft, 0)
  if (shift !== 0) for (let i = 0; i < seconds.length; i++) seconds[i]! -= shift

  return draft
}

/** Index of the segment containing `q`: the last boundary at or before it, clamped to 0. */
function segmentForQuarters(map: TempoMap, q: number): number {
  const xs = map.quarters
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (xs[mid]! <= q) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Index of the segment containing `s` seconds. */
function segmentForSeconds(map: TempoMap, s: number): number {
  const xs = map.seconds
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (xs[mid]! <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

function secondsAtQuarters(map: TempoMap, q: number): number {
  const i = segmentForQuarters(map, q)
  return map.seconds[i]! + (q - map.quarters[i]!) * 60 / map.events[i]!.bpm
}

function quartersAtSeconds(map: TempoMap, s: number): number {
  const i = segmentForSeconds(map, s)
  return map.quarters[i]! + (s - map.seconds[i]!) * map.events[i]!.bpm / 60
}

/**
 * Seconds from col 0 at `p`.
 *
 * Positions before col 0 extrapolate backwards along the first segment (segment index
 * clamps to 0), so the result is simply negative — the board is boundless in both
 * directions.
 */
export function toSeconds(map: TempoMap, p: Pos): number {
  return secondsAtQuarters(map, toQuarters(p))
}

/**
 * Best rational approximation of `x` with denominator <= `maxDen`, by continued
 * fractions (the Stern-Brocot convergents).
 *
 * Truncating the expansion at the denominator bound is what makes float noise
 * harmless: 0.33333333333333337 expands to 1/3 and then stops, because the next
 * convergent's denominator explodes past the bound.
 */
function approxFrac(x: number, maxDen: number): Frac {
  let pPrev2 = 0
  let qPrev2 = 1
  let pPrev = 1
  let qPrev = 0
  let v = x
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(v)
    const p = a * pPrev + pPrev2
    const q = a * qPrev + qPrev2
    if (q > maxDen || !Number.isFinite(q)) break
    pPrev2 = pPrev
    qPrev2 = qPrev
    pPrev = p
    qPrev = q
    const rem = v - a
    if (rem <= 1e-12) break
    v = 1 / rem
  }
  return qPrev === 0 ? normalize(0, 1) : normalize(pPrev, qPrev)
}

/**
 * Split a floating quarter count into a `Pos`.
 *
 * The column is a floored integer (exact); only the sub-column remainder goes through
 * `approxFrac`, bounded by `PLAYHEAD_MAX_DEN`. `canonicalize` absorbs the case where
 * the remainder rounds up to 1.
 */
export function quartersToPos(q: number): Pos {
  const col = Math.floor(q)
  if (!Number.isFinite(col)) throw new RangeError('quartersToPos: non-finite quarters')
  return canonicalize(col, approxFrac(q - col, PLAYHEAD_MAX_DEN))
}

/**
 * Closed-form inverse of `toSeconds`, for the playhead.
 *
 * Binary search the prefix seconds, then `q = segQuarters + (s - segSeconds) * bpm/60`.
 * The float quarter is turned back into rational time through the bounded continued-
 * fraction approximation above; that is fine here because nothing is *stored* from this
 * path — note positions come from the grid, never from the clock.
 */
export function secondsToPos(map: TempoMap, s: number): Pos {
  return quartersToPos(quartersAtSeconds(map, s))
}

/**
 * True elapsed seconds of a note at `p` lasting `dur` quarters.
 *
 * Computed as the difference of the two endpoint conversions, so a note spanning a
 * tempo change gets its real length rather than its onset tempo's guess (§8.1) — this
 * is the value the scheduler hands smplr as `duration`.
 */
export function durationSeconds(map: TempoMap, p: Pos, dur: Frac): number {
  return toSeconds(map, padd(p, dur)) - toSeconds(map, p)
}

/**
 * A cursor that caches the current segment index.
 *
 * The playhead advances monotonically, so the common case is "still in this segment"
 * (O(1)) and the rare case is "stepped over one boundary" — a `while`, not an `if`,
 * because a lookahead window can cross several close-together tempo changes at once. A
 * backward move (a seek) falls back to the binary search.
 */
export function createTempoCursor(map: TempoMap): TempoCursor {
  const last = map.seconds.length - 1
  let i = 0

  const locate = (s: number): number => {
    if (s < map.seconds[i]!) {
      i = segmentForSeconds(map, s)
      return i
    }
    while (i < last && s >= map.seconds[i + 1]!) i++
    return i
  }

  const secondsToQuarters = (s: number): number => {
    const j = locate(s)
    return map.quarters[j]! + (s - map.seconds[j]!) * map.events[j]!.bpm / 60
  }

  return {
    secondsToQuarters,
    secondsToPos: (s: number): Pos => quartersToPos(secondsToQuarters(s)),
    reset: (): void => {
      i = 0
    },
  }
}
