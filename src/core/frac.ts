import type { Frac } from './types'

/**
 * Rational arithmetic over the denominator lattice of go-spec.md §3.1.
 *
 * Every reachable denominator divides
 *   L = 2^8 * 3^4 * 5^2 * 7^2 * 11^2 * 13^2 = 519_437_318_400
 * and the lattice is closed under addition. L is an exact double, but L^2 = 2.7e23
 * is not — so every operation here reduces by a gcd *before* multiplying. Forming
 * `b * d` directly overflows 2^53 in ordinary use.
 */

/** The denominator lattice bound: every reachable denominator divides this. */
export const LATTICE = 519437318400

/** Largest denominator we accept before declaring the model corrupt. */
const MAX_DEN = LATTICE

export const ZERO: Frac = { n: 0, d: 1 }
export const ONE: Frac = { n: 1, d: 1 }

/** Greatest common divisor of two non-negative integers. */
export function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

export function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return Math.abs(a) / gcd(a, b) * Math.abs(b)
}

/**
 * Normalize to lowest terms with `d > 0`. Zero always collapses to `{n:0,d:1}` —
 * without that, `0/5` and `0/1` compare unequal under `eq` and disagree across a
 * JSON round-trip.
 */
export function normalize(n: number, d: number): Frac {
  if (d === 0) throw new RangeError('Frac: zero denominator')
  if (!Number.isFinite(n) || !Number.isFinite(d)) throw new RangeError('Frac: non-finite')
  if (n === 0) return ZERO
  if (d < 0) {
    n = -n
    d = -d
  }
  const g = gcd(n, d)
  const nn = n / g
  const dd = d / g
  if (dd > MAX_DEN) {
    throw new RangeError(`Frac: denominator ${dd} escapes the lattice (max ${MAX_DEN})`)
  }
  if (!Number.isSafeInteger(nn) || !Number.isSafeInteger(dd)) {
    throw new RangeError('Frac: components are not safe integers')
  }
  return { n: nn, d: dd }
}

export function frac(n: number, d = 1): Frac {
  return normalize(n, d)
}

/**
 * a + b, reducing by gcd of the denominators first.
 *
 * The naive `n = a.n*b.d + b.n*a.d; d = a.d*b.d` overflows: five columns of nested
 * tuplets already reach d = 3.07e9, and the product of two such denominators is
 * 9.4e18 — 1000x past 2^53.
 */
export function add(a: Frac, b: Frac): Frac {
  const g = gcd(a.d, b.d)
  const bd = b.d / g
  const ad = a.d / g
  return normalize(a.n * bd + b.n * ad, a.d * bd)
}

export function sub(a: Frac, b: Frac): Frac {
  return add(a, neg(b))
}

export function neg(a: Frac): Frac {
  return a.n === 0 ? ZERO : { n: -a.n, d: a.d }
}

export function mul(a: Frac, b: Frac): Frac {
  if (a.n === 0 || b.n === 0) return ZERO
  // Cross-reduce before multiplying, for the same reason `add` does.
  const g1 = gcd(a.n, b.d)
  const g2 = gcd(b.n, a.d)
  return normalize((a.n / g1) * (b.n / g2), (a.d / g2) * (b.d / g1))
}

export function div(a: Frac, b: Frac): Frac {
  if (b.n === 0) throw new RangeError('Frac: division by zero')
  return mul(a, b.n < 0 ? { n: -b.d, d: -b.n } : { n: b.d, d: b.n })
}

/**
 * Sign of a - b. Cross-multiplies after reducing by gcd(a.d, b.d), which bounds the
 * product at LATTICE and keeps the comparison exact without relying on the (true but
 * fragile) argument that naive cross-multiplication happens to order this lattice
 * correctly anyway.
 */
export function cmp(a: Frac, b: Frac): number {
  const g = gcd(a.d, b.d)
  const left = a.n * (b.d / g)
  const right = b.n * (a.d / g)
  return left < right ? -1 : left > right ? 1 : 0
}

export const eq = (a: Frac, b: Frac): boolean => a.n === b.n && a.d === b.d
export const lt = (a: Frac, b: Frac): boolean => cmp(a, b) < 0
export const lte = (a: Frac, b: Frac): boolean => cmp(a, b) <= 0
export const gt = (a: Frac, b: Frac): boolean => cmp(a, b) > 0
export const gte = (a: Frac, b: Frac): boolean => cmp(a, b) >= 0

export const isZero = (a: Frac): boolean => a.n === 0
export const isPositive = (a: Frac): boolean => a.n > 0

/** Display and rendering only — never store the result. */
export function toNumber(a: Frac): number {
  return a.n / a.d
}

export function toString(a: Frac): string {
  return a.d === 1 ? `${a.n}` : `${a.n}/${a.d}`
}
