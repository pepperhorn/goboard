import type { Frac, Pos } from './types'
import {
  add as fadd,
  div as fdiv,
  frac,
  isPositive as fIsPositive,
  lt as flt,
  mul as fmul,
  normalize,
  toString as fracToString,
} from './frac'
import { ORIGIN, add as padd, canonicalize, cmp as pcmp, diff as pdiff, pos } from './pos'

/**
 * The meter map: bar lines, bar numbers and MIDI time signatures. See design §3.7.
 *
 * A meter is a position, a beat unit (in quarter notes) and a list of beat groups —
 * `groups: [2, 2, 3]` with `beatUnit: 1/2` is 7/8 felt as 2+2+3 eighths. Bar length is
 * `sum(groups) * beatUnit`; group starts subdivide the bar into its felt beats.
 *
 * `beatUnit` is restricted so that `4 / beatUnit` is a power of two, because SMF's
 * time-signature denominator is a 2^k field (`midiDenominator` below). The grid
 * ladder's triplet values (1/3, 2/3, 4/3, 1/6, 1/12) are legal grid spacings but must
 * never leak into a `beatUnit` — `validateMeter` is the guard.
 *
 * A meter change **starts a new bar at its position**, regardless of where the
 * previous bar would otherwise have ended: the previous bar is cut short. That is what
 * makes every meter's `pos` itself always a bar boundary, which is what lets
 * `barStartAt` below locate a bar with arithmetic instead of walking from the origin.
 */
export type Meter = { readonly pos: Pos; readonly beatUnit: Frac; readonly groups: readonly number[] }

/** No `meterMap` means one 4/4 at the origin. */
export const DEFAULT_METER: Meter = { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function readFracLocal(v: unknown, where: string): Frac {
  if (typeof v !== 'object' || v === null) {
    throw new RangeError(`${where}: expected a fraction, got ${typeof v}`)
  }
  const raw = v as { n?: unknown; d?: unknown }
  if (typeof raw.n !== 'number' || typeof raw.d !== 'number') {
    throw new RangeError(`${where}: n and d must be numbers`)
  }
  if (!Number.isInteger(raw.n) || !Number.isInteger(raw.d) || raw.d === 0) {
    throw new RangeError(`${where}: n and d must be integers with d != 0`)
  }
  return normalize(raw.n, raw.d)
}

function readPosLocal(v: unknown, where: string): Pos {
  if (typeof v !== 'object' || v === null) {
    throw new RangeError(`${where}: expected a position, got ${typeof v}`)
  }
  const raw = v as { col?: unknown; frac?: unknown }
  if (typeof raw.col !== 'number' || !Number.isSafeInteger(raw.col)) {
    throw new RangeError(`${where}.col: must be a safe integer, got ${typeof raw.col}`)
  }
  const f = readFracLocal(raw.frac, `${where}.frac`)
  const canon = canonicalize(raw.col, f)
  if (canon.col !== raw.col || canon.frac.n !== f.n || canon.frac.d !== f.d) {
    throw new RangeError(`${where}: is not canonical`)
  }
  return canon
}

/**
 * `4 / beatUnit` as an exact `Frac` operation, or `undefined` when it is not a
 * positive power of two. Shared by `midiDenominator` and `validateMeter` so the two
 * never disagree about which beat units are legal.
 */
function midiDenominatorOrUndefined(beatUnit: Frac): number | undefined {
  const q = fdiv(frac(4), beatUnit)
  if (q.d !== 1 || q.n <= 0 || (q.n & (q.n - 1)) !== 0) return undefined
  return q.n
}

/**
 * Validate arbitrary parsed JSON into a `Meter`, or throw a `RangeError` naming the
 * failing path — the same discipline `validateGridValue` uses (`gridValue.ts`).
 *
 * `groups` must be non-empty with every entry a positive integer, and `beatUnit` must
 * be positive with `4 / beatUnit` a power of two. Both are load-bearing: an empty or
 * non-positive `groups` would make `barLength` zero or negative, which would hang the
 * walk in `barLinesIn` / `groupLinesIn` rather than fail — `barLength` re-checks this
 * defensively for exactly that reason, but rejecting it here is what keeps a malformed
 * meter from ever reaching that walk in the first place.
 */
export function validateMeter(v: unknown, where: string): Meter {
  if (typeof v !== 'object' || v === null) {
    throw new RangeError(`${where}: expected a meter, got ${typeof v}`)
  }
  const raw = v as { pos?: unknown; beatUnit?: unknown; groups?: unknown }
  const at = readPosLocal(raw.pos, `${where}.pos`)
  const beatUnit = readFracLocal(raw.beatUnit, `${where}.beatUnit`)
  if (!fIsPositive(beatUnit)) {
    throw new RangeError(`${where}.beatUnit: must be positive, got ${fracToString(beatUnit)}`)
  }
  if (midiDenominatorOrUndefined(beatUnit) === undefined) {
    throw new RangeError(
      `${where}.beatUnit: SMF denominator (4 / beatUnit) must be a power of two, got beatUnit ${fracToString(beatUnit)}`,
    )
  }

  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new RangeError(`${where}.groups: must be a non-empty array`)
  }
  const groups: number[] = []
  for (let i = 0; i < raw.groups.length; i++) {
    const g: unknown = raw.groups[i]
    if (typeof g !== 'number' || !Number.isInteger(g) || g <= 0) {
      throw new RangeError(`${where}.groups[${i}]: must be a positive integer, got ${describeValue(g)}`)
    }
    groups.push(g)
  }
  return { pos: at, beatUnit, groups }
}

function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/**
 * `4 / beatUnit` as an SMF time-signature denominator, or throw if `beatUnit` is not a
 * positive power-of-two fraction of a quarter note. Computed via exact `Frac`
 * arithmetic — the result is a plain `number` (SMF's denominator is genuinely an
 * integer), but nothing float-derived feeds back into a `Frac` or `Pos`.
 */
export function midiDenominator(beatUnit: Frac): number {
  const d = midiDenominatorOrUndefined(beatUnit)
  if (d === undefined) {
    throw new RangeError(
      `midiDenominator: beatUnit ${fracToString(beatUnit)} is not a power of two`,
    )
  }
  return d
}

// ---------------------------------------------------------------------------
// Building the map
// ---------------------------------------------------------------------------

/**
 * Sort-check, de-duplicate (last wins at a coincident position) and default a raw list
 * of meters — the same shape `buildTempoMap` gives `tempoMap` (`tempo.ts`). An implicit
 * `DEFAULT_METER` is prepended unless the caller already supplies one at or before
 * col 0.
 *
 * This is also where the bar-arithmetic precondition below is established: every
 * function in the "Bar arithmetic" section requires `map[0].pos` to be at or before
 * the origin, and this is the only place that guarantee is produced. A meter list
 * read from disk (or built by hand) must be passed through here before it reaches
 * `barLinesIn`, `groupLinesIn` or `barNumberAt` — passing a raw list straight through
 * throws rather than silently extrapolating (see `assertAnchored`).
 */
export function buildMeterMap(events: readonly Meter[]): readonly Meter[] {
  const kept: Meter[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    const prev = kept[kept.length - 1]
    if (prev) {
      const c = pcmp(prev.pos, e.pos)
      if (c > 0) throw new RangeError(`buildMeterMap: event ${i} is out of order`)
      if (c === 0) kept.pop() // coincident: last wins
    }
    kept.push(e)
  }

  const first = kept[0]
  if (!first || first.pos.col > 0 || (first.pos.col === 0 && first.pos.frac.n > 0)) {
    kept.unshift(DEFAULT_METER)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Bar arithmetic
// ---------------------------------------------------------------------------

/**
 * `sum(groups) * beatUnit`, re-validated defensively: a `Meter` reaching this function
 * with an empty or non-positive `groups`, or a non-positive `beatUnit`, would give the
 * bar-walking loops below a zero or negative step — an infinite loop, not a thrown
 * error. `validateMeter` is the normal gate; this is the backstop for a `Meter` that
 * was hand-built rather than validated.
 */
function barLength(m: Meter): Frac {
  if (m.groups.length === 0) {
    throw new RangeError('Meter: groups must be non-empty — malformed meter reached the bar walk')
  }
  let total = 0
  for (const g of m.groups) {
    if (!Number.isInteger(g) || g <= 0) {
      throw new RangeError(
        'Meter: every group must be a positive integer — malformed meter reached the bar walk',
      )
    }
    total += g
  }
  const length = fmul(frac(total), m.beatUnit)
  if (!fIsPositive(length)) {
    throw new RangeError('Meter: bar length must be positive — malformed meter reached the bar walk')
  }
  return length
}

/**
 * Precondition of every function below: `map[0].pos` must be at or before the origin.
 *
 * `meterIndexAt` clamps an out-of-range query to index 0 rather than returning a
 * sentinel the way `regionIndexAt` (`grid.ts`) returns `-1` for "before the first
 * region" — there is no implicit default meter to fall back on the way grid regions
 * fall back on `DEFAULT_GRID_VALUE`, only `map[0]` itself, extrapolated backward by
 * arithmetic. That is safe *only* because `buildMeterMap` guarantees `map[0].pos` is
 * at or before column 0, so no in-piece query (which never precedes column 0) can
 * land before it. A raw meter list that skips `buildMeterMap` — e.g. a `.go.json`
 * `meterMap` whose first entry starts at `pos(4)` — would otherwise have that first
 * meter silently extrapolated backward instead of being bounded by an implicit
 * default. This assertion turns that into a thrown error instead.
 */
function assertAnchored(map: readonly Meter[], fn: string): void {
  if (map.length === 0) throw new RangeError(`${fn}: meter map is empty`)
  if (pcmp(map[0]!.pos, ORIGIN) > 0) {
    throw new RangeError(
      `${fn}: meter map is not anchored at or before the origin (first meter at col ` +
        `${map[0]!.pos.col}) — pass it through buildMeterMap first`,
    )
  }
}

/** Index of the meter governing `at`: the last one with `pos <= at`, clamped to 0. */
function meterIndexAt(map: readonly Meter[], at: Pos): number {
  let lo = 0
  let hi = map.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pcmp(map[mid]!.pos, at) <= 0) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** floor(a / b), exact. `b` must be positive. */
function floorFracDiv(a: Frac, b: Frac): number {
  const q = fdiv(a, b)
  return q.d === 1 ? q.n : Math.floor(q.n / q.d)
}

/** ceil(a / b), exact. `a` and `b` must be positive. */
function ceilFracDiv(a: Frac, b: Frac): number {
  const q = fdiv(a, b)
  return q.d === 1 ? q.n : Math.floor(q.n / q.d) + 1
}

/**
 * The start of the bar (governed by `map[i]`) containing `at`.
 *
 * Because a meter change always starts a new bar exactly at its own position (see the
 * module doc), the bars within segment `i` are anchored at `map[i].pos` with no
 * leftover phase from an earlier segment — `k = floor((at - map[i].pos) / barLength)`
 * locates the bar directly, without walking from the start of the piece.
 */
function barStartAt(map: readonly Meter[], i: number, at: Pos): Pos {
  const m = map[i]!
  const len = barLength(m)
  const k = floorFracDiv(pdiff(m.pos, at), len)
  return padd(m.pos, fmul(frac(k), len))
}

/** One bar step forward from `barStart` (governed by `map[i]`), switching meters if the next one's position is reached. */
function advanceBar(map: readonly Meter[], i: number, barStart: Pos): { i: number; pos: Pos } {
  const len = barLength(map[i]!)
  const natural = padd(barStart, len)
  const next = map[i + 1]
  if (next !== undefined && pcmp(natural, next.pos) >= 0) {
    // The next meter forces a bar boundary at its own position, regardless of where
    // this bar would otherwise have ended.
    return { i: i + 1, pos: next.pos }
  }
  return { i, pos: natural }
}

/**
 * Every bar line in `[from, to]`, in order. Thick lines in the §3.7 rendering.
 *
 * Precondition: `map[0].pos` must be at or before the origin — build `map` with
 * `buildMeterMap` first. See `assertAnchored`.
 */
export function barLinesIn(map: readonly Meter[], from: Pos, to: Pos): Pos[] {
  assertAnchored(map, 'barLinesIn')
  const out: Pos[] = []
  let i = meterIndexAt(map, from)
  let barStart = barStartAt(map, i, from)
  while (pcmp(barStart, to) <= 0) {
    if (pcmp(barStart, from) >= 0) out.push(barStart)
    const step = advanceBar(map, i, barStart)
    i = step.i
    barStart = step.pos
  }
  return out
}

/**
 * Every internal group start in `[from, to]`, in order — medium lines in the §3.7
 * rendering. Offset 0 (the bar start) is never included, so a bar line is never also
 * reported as a group line.
 *
 * Precondition: `map[0].pos` must be at or before the origin — build `map` with
 * `buildMeterMap` first. See `assertAnchored`.
 */
export function groupLinesIn(map: readonly Meter[], from: Pos, to: Pos): Pos[] {
  assertAnchored(map, 'groupLinesIn')
  const out: Pos[] = []
  let i = meterIndexAt(map, from)
  let barStart = barStartAt(map, i, from)
  while (pcmp(barStart, to) <= 0) {
    const m = map[i]!
    let cum = 0
    for (let g = 0; g < m.groups.length - 1; g++) {
      cum += m.groups[g]!
      const linePos = padd(barStart, fmul(frac(cum), m.beatUnit))
      if (pcmp(linePos, from) >= 0 && pcmp(linePos, to) <= 0) out.push(linePos)
    }
    const step = advanceBar(map, i, barStart)
    i = step.i
    barStart = step.pos
  }
  return out
}

/** Which felt beat (1-indexed group) of its bar `offset` (from that bar's start) falls in. */
function beatOfOffset(m: Meter, offset: Frac): number {
  let cum: Frac = frac(0)
  for (let idx = 0; idx < m.groups.length; idx++) {
    const next = fadd(cum, fmul(frac(m.groups[idx]!), m.beatUnit))
    if (flt(offset, next)) return idx + 1
    cum = next
  }
  return m.groups.length
}

/**
 * The bar number (from 1 at the origin) and felt beat (from 1) containing `at`.
 *
 * Precondition: `map[0].pos` must be at or before the origin — build `map` with
 * `buildMeterMap` first. See `assertAnchored`.
 */
export function barNumberAt(map: readonly Meter[], at: Pos): { bar: number; beat: number } {
  assertAnchored(map, 'barNumberAt')
  const i = meterIndexAt(map, at)

  // Bars contributed by every earlier meter segment. A segment cut short by the next
  // meter change still counts as one (possibly partial) bar, hence `ceil`.
  let barCount = 0
  for (let s = 0; s < i; s++) {
    barCount += ceilFracDiv(pdiff(map[s]!.pos, map[s + 1]!.pos), barLength(map[s]!))
  }

  const len = barLength(map[i]!)
  const k = floorFracDiv(pdiff(map[i]!.pos, at), len)
  const barStart = padd(map[i]!.pos, fmul(frac(k), len))
  const offset = pdiff(barStart, at)
  return { bar: barCount + k + 1, beat: beatOfOffset(map[i]!, offset) }
}
