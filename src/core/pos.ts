import type { Frac, Pos } from './types'
import { ZERO, add as fadd, cmp as fcmp, gcd, neg, normalize, toNumber } from './frac'

/**
 * Position arithmetic. See go-spec.md §3.1.
 *
 * Every mutation routes through `canonicalize` so that `0 <= frac < 1` always holds.
 * Two representations of the same instant (e.g. `{col:0, frac:-1/3}` and
 * `{col:-1, frac:2/3}`) would sort differently and produce different index keys, so
 * the same note would be findable at two columns.
 */

/**
 * Floored div-mod, not JS `%`.
 *
 * `%` truncates — `(-1) % 3 === -1` — so a leftward drag would leave a negative
 * `frac`. The correction loop also repairs the +/-1 error `Math.trunc(n/d)` can make
 * near exact boundaries once `n` is large.
 */
export function floorDivMod(n: number, d: number): { q: number; r: number } {
  if (d <= 0) throw new RangeError('floorDivMod: denominator must be positive')
  let q = Math.trunc(n / d)
  let r = n - q * d
  if (r < 0) {
    q--
    r += d
  }
  while (r >= d) {
    q++
    r -= d
  }
  return { q, r }
}

/** Restore the `0 <= frac < 1` invariant, carrying whole quarters into `col`. */
export function canonicalize(col: number, f: Frac): Pos {
  if (!Number.isSafeInteger(col)) throw new RangeError('Pos: col must be a safe integer')
  if (f.n === 0) return { col, frac: ZERO }
  const { q, r } = floorDivMod(f.n, f.d)
  return { col: col + q, frac: r === 0 ? ZERO : normalize(r, f.d) }
}

export function pos(col: number, n = 0, d = 1): Pos {
  return canonicalize(col, normalize(n, d))
}

export const ORIGIN: Pos = { col: 0, frac: ZERO }

/** Sign of a - b: compare `col` first, then the fractions. */
export function cmp(a: Pos, b: Pos): number {
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  return fcmp(a.frac, b.frac)
}

export const eq = (a: Pos, b: Pos): boolean => cmp(a, b) === 0
export const lt = (a: Pos, b: Pos): boolean => cmp(a, b) < 0
export const lte = (a: Pos, b: Pos): boolean => cmp(a, b) <= 0
export const gt = (a: Pos, b: Pos): boolean => cmp(a, b) > 0
export const gte = (a: Pos, b: Pos): boolean => cmp(a, b) >= 0

/** Advance a position by a duration in quarter-note units. `dur` may be negative. */
export function add(p: Pos, dur: Frac): Pos {
  return canonicalize(p.col, fadd(p.frac, dur))
}

export function sub(p: Pos, dur: Frac): Pos {
  return add(p, neg(dur))
}

/**
 * Signed distance b - a, in quarter-note units.
 *
 * Computed as `(b.col - a.col) + (b.frac - a.frac)` with the column difference folded
 * in as an integer, so the intermediate never leaves the lattice.
 */
export function diff(a: Pos, b: Pos): Frac {
  const cols = b.col - a.col
  const g = gcd(a.frac.d, b.frac.d)
  const d = a.frac.d * (b.frac.d / g)
  // Scale each numerator up to the common denominator `d`: a by d/a.d, b by d/b.d.
  const aScaled = a.frac.n * (b.frac.d / g)
  const bScaled = b.frac.n * (a.frac.d / g)
  return normalize(cols * d + (bScaled - aScaled), d)
}

/** Absolute position in quarter notes. Display and rendering only — never store. */
export function toQuarters(p: Pos): number {
  return p.col + toNumber(p.frac)
}

/** Stable key for maps and dedup. */
export function key(p: Pos): string {
  return `${p.col}:${p.frac.n}/${p.frac.d}`
}
