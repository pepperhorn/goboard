import { describe, expect, it } from 'vitest'
import {
  LATTICE, ZERO, add, cmp, div, eq, frac, gcd, lcm, mul, neg, normalize, sub, toNumber,
} from './frac'

describe('normalize', () => {
  it('reduces to lowest terms', () => {
    expect(normalize(6, 8)).toEqual({ n: 3, d: 4 })
    expect(normalize(100, 10)).toEqual({ n: 10, d: 1 })
  })

  it('collapses every zero to {n:0,d:1}', () => {
    // Without this, 0/5 and 0/1 disagree under eq and across a JSON round-trip.
    expect(normalize(0, 5)).toEqual(ZERO)
    expect(normalize(0, 519437318400)).toEqual(ZERO)
    expect(eq(normalize(0, 5), normalize(0, 1))).toBe(true)
  })

  it('carries the sign into the numerator so d > 0 always holds', () => {
    expect(normalize(1, -3)).toEqual({ n: -1, d: 3 })
    expect(normalize(-1, -3)).toEqual({ n: 1, d: 3 })
  })

  it('rejects a zero denominator and non-finite components', () => {
    expect(() => normalize(1, 0)).toThrow(RangeError)
    expect(() => normalize(NaN, 1)).toThrow(RangeError)
    expect(() => normalize(1, Infinity)).toThrow(RangeError)
  })

  it('rejects denominators that escape the lattice', () => {
    expect(() => normalize(1, LATTICE)).not.toThrow()
    expect(() => normalize(1, LATTICE + 1)).toThrow(/lattice/)
  })
})

describe('the denominator lattice', () => {
  it('is exactly 2^8 * 3^4 * 5^2 * 7^2 * 11^2 * 13^2', () => {
    expect(LATTICE).toBe(2 ** 8 * 3 ** 4 * 5 ** 2 * 7 ** 2 * 11 ** 2 * 13 ** 2)
    expect(LATTICE).toBe(519437318400)
    expect(Number.isSafeInteger(LATTICE)).toBe(true)
  })

  it('covers every depth-2 slot denominator', () => {
    for (let a = 1; a <= 16; a++) {
      for (let b = 1; b <= 16; b++) {
        expect(LATTICE % (a * b)).toBe(0)
      }
    }
  })

  it('is closed under addition of slot boundaries', () => {
    // Sum one slot from each of several differently-split columns; the result must
    // still divide L.
    let acc = ZERO
    for (const [s1, s2] of [[16, 16], [9, 9], [5, 5], [7, 7], [11, 11], [13, 13]]) {
      acc = add(acc, frac(1, s1 * s2))
    }
    expect(LATTICE % acc.d).toBe(0)
  })
})

describe('add', () => {
  it('adds simple fractions', () => {
    expect(add(frac(1, 2), frac(1, 3))).toEqual({ n: 5, d: 6 })
    expect(add(frac(1, 3), frac(2, 3))).toEqual({ n: 1, d: 1 })
  })

  it('stays exact where the naive n*d product would overflow 2^53', () => {
    // Five columns of nested tuplets. The naive denominator product is 9.4e18,
    // 1000x past 2^53; reducing by gcd first keeps every intermediate exact.
    let acc = ZERO
    for (const s of [16 * 16, 9 * 9, 5 * 5, 7 * 7, 11 * 11]) {
      acc = add(acc, frac(1, s))
    }
    expect(acc.d).toBe(3073593600)
    expect(acc.n).toBe(261023569)
    expect(Number.isSafeInteger(acc.n)).toBe(true)
    // Cross-check against exact big-integer arithmetic.
    let bn = 0n
    const bd = 3073593600n
    for (const s of [16 * 16, 9 * 9, 5 * 5, 7 * 7, 11 * 11]) bn += bd / BigInt(s)
    expect(BigInt(acc.n)).toBe(bn)
  })

  it('is exact for a long accumulation of mixed tuplets', () => {
    const splits = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 16]
    let acc = ZERO
    let bn = 0n
    const bd = BigInt(LATTICE)
    for (const s of splits) {
      acc = add(acc, frac(1, s))
      bn += bd / BigInt(s)
    }
    expect(BigInt(acc.n) * (bd / BigInt(acc.d))).toBe(bn)
  })
})

describe('sub and neg', () => {
  it('subtracts across zero', () => {
    expect(sub(frac(1, 3), frac(2, 3))).toEqual({ n: -1, d: 3 })
    expect(sub(frac(1, 3), frac(1, 3))).toEqual(ZERO)
  })

  it('negates zero to canonical zero', () => {
    expect(neg(ZERO)).toEqual(ZERO)
  })
})

describe('mul and div', () => {
  it('cross-reduces before multiplying', () => {
    expect(mul(frac(2, 3), frac(3, 4))).toEqual({ n: 1, d: 2 })
    expect(mul(frac(1, 256), frac(1, 169))).toEqual({ n: 1, d: 43264 })
  })

  it('collapses a zero operand', () => {
    expect(mul(ZERO, frac(7, 11))).toEqual(ZERO)
  })

  it('divides and rejects division by zero', () => {
    expect(div(frac(1, 2), frac(1, 4))).toEqual({ n: 2, d: 1 })
    expect(div(frac(1, 2), frac(-1, 4))).toEqual({ n: -2, d: 1 })
    expect(() => div(frac(1, 2), ZERO)).toThrow(RangeError)
  })
})

describe('cmp', () => {
  it('orders simple fractions', () => {
    expect(cmp(frac(1, 3), frac(1, 2))).toBe(-1)
    expect(cmp(frac(1, 2), frac(1, 3))).toBe(1)
    expect(cmp(frac(2, 4), frac(1, 2))).toBe(0)
  })

  it('orders negatives correctly', () => {
    expect(cmp(frac(-1, 3), frac(1, 3))).toBe(-1)
    expect(cmp(frac(-1, 2), frac(-1, 3))).toBe(-1)
  })

  it('is exact for adjacent positions with large, distinct denominators', () => {
    // 1/(16*16) apart at a denominator near the lattice ceiling: the reduced
    // cross-product must stay under 2^53.
    const a = frac(1, 256 * 81 * 25)
    const b = add(a, frac(1, 49 * 121 * 169))
    expect(cmp(a, b)).toBe(-1)
    expect(cmp(b, a)).toBe(1)
    const g = gcd(a.d, b.d)
    expect(Math.max(a.n * (b.d / g), b.n * (a.d / g))).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('agrees with exact big-integer comparison over the tuplet lattice', () => {
    const denoms = [256, 81, 25, 49, 121, 169, 143, 6864, 30240]
    for (const d1 of denoms) {
      for (const d2 of denoms) {
        for (const n1 of [1, 3, d1 - 1]) {
          for (const n2 of [1, 3, d2 - 1]) {
            const a = frac(n1, d1)
            const b = frac(n2, d2)
            const exact = BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d)
            const expected = exact < 0n ? -1 : exact > 0n ? 1 : 0
            expect(cmp(a, b)).toBe(expected)
          }
        }
      }
    }
  })
})

describe('gcd and lcm', () => {
  it('computes gcd over the tuplet primes', () => {
    expect(gcd(256, 81)).toBe(1)
    expect(gcd(30240, 6864)).toBe(48)
    expect(gcd(0, 7)).toBe(7)
  })

  it('computes lcm and handles zero', () => {
    expect(lcm(11, 13)).toBe(143)
    expect(lcm(16, 3)).toBe(48)
    expect(lcm(0, 5)).toBe(0)
  })
})

describe('toNumber', () => {
  it('converts for display only', () => {
    expect(toNumber(frac(3, 4))).toBeCloseTo(0.75, 12)
    expect(toNumber(ZERO)).toBe(0)
  })
})
