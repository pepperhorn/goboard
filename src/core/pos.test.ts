import { describe, expect, it } from 'vitest'
import { ZERO, frac, toNumber } from './frac'
import {
  ORIGIN, add, canonicalize, cmp, diff, eq, floorDivMod, key, lt, pos, sub, toQuarters,
} from './pos'

describe('floorDivMod', () => {
  it('floors rather than truncating', () => {
    // JS `%` truncates: (-1) % 3 === -1. A leftward drag must not leave a negative frac.
    expect(floorDivMod(-1, 3)).toEqual({ q: -1, r: 2 })
    expect(floorDivMod(-3, 3)).toEqual({ q: -1, r: 0 })
    expect(floorDivMod(-4, 3)).toEqual({ q: -2, r: 2 })
    expect(floorDivMod(7, 3)).toEqual({ q: 2, r: 1 })
    expect(floorDivMod(0, 3)).toEqual({ q: 0, r: 0 })
  })

  it('is exact at large numerators where float division drifts', () => {
    const d = 3073593600
    expect(floorDivMod(d * 5, d)).toEqual({ q: 5, r: 0 })
    expect(floorDivMod(d * 5 - 1, d)).toEqual({ q: 4, r: d - 1 })
    expect(floorDivMod(-d * 5 + 1, d)).toEqual({ q: -5, r: 1 })
  })

  it('rejects a non-positive denominator', () => {
    expect(() => floorDivMod(1, 0)).toThrow(RangeError)
    expect(() => floorDivMod(1, -3)).toThrow(RangeError)
  })
})

describe('canonicalize', () => {
  it('carries whole quarters into col', () => {
    expect(canonicalize(0, frac(5, 3))).toEqual({ col: 1, frac: { n: 2, d: 3 } })
    expect(canonicalize(0, frac(3, 3))).toEqual({ col: 1, frac: ZERO })
  })

  it('normalizes a negative frac to the previous column', () => {
    // {col:0, frac:-1/3} and {col:-1, frac:2/3} are the same instant; only the
    // latter is canonical, and index keys depend on it.
    expect(canonicalize(0, frac(-1, 3))).toEqual({ col: -1, frac: { n: 2, d: 3 } })
    expect(canonicalize(-2, frac(-4, 3))).toEqual({ col: -4, frac: { n: 2, d: 3 } })
  })

  it('is idempotent', () => {
    const p = canonicalize(0, frac(-7, 5))
    expect(canonicalize(p.col, p.frac)).toEqual(p)
  })

  it('rejects a non-integer column', () => {
    expect(() => canonicalize(1.5, ZERO)).toThrow(RangeError)
  })
})

describe('cmp', () => {
  it('orders by column first, then by frac', () => {
    expect(cmp(pos(0), pos(1))).toBe(-1)
    expect(cmp(pos(1, 1, 4), pos(1, 1, 3))).toBe(-1)
    expect(cmp(pos(1, 2, 4), pos(1, 1, 2))).toBe(0)
  })

  it('orders across negative columns', () => {
    expect(cmp(pos(-1, 2, 3), pos(0))).toBe(-1)
    expect(cmp(pos(-2), pos(-1))).toBe(-1)
  })

  it('never treats two spellings of one instant as different', () => {
    // The trap: a truncating div-mod would produce {col:0, frac:-1/3} here, which
    // sorts after pos(-1, 1, 3) instead of before it.
    const a = canonicalize(0, frac(-1, 3))
    const b = pos(-1, 1, 3)
    expect(lt(b, a)).toBe(true)
    expect(eq(a, pos(-1, 2, 3))).toBe(true)
  })

  it('sorts a mixed array the same way toQuarters does', () => {
    const ps = [pos(2, 1, 3), pos(-1, 5, 7), pos(0), pos(-1), pos(2, 1, 4), pos(0, 11, 13)]
    const byCmp = [...ps].sort(cmp).map(toQuarters)
    const byNumber = [...ps].map(toQuarters).sort((x, y) => x - y)
    expect(byCmp).toEqual(byNumber)
  })
})

describe('add and sub', () => {
  it('advances within a column', () => {
    expect(add(pos(0, 1, 4), frac(1, 4))).toEqual({ col: 0, frac: { n: 1, d: 2 } })
  })

  it('crosses column boundaries', () => {
    expect(add(pos(0, 3, 4), frac(1, 2))).toEqual({ col: 1, frac: { n: 1, d: 4 } })
    expect(add(pos(0), frac(9, 2))).toEqual({ col: 4, frac: { n: 1, d: 2 } })
  })

  it('moves backwards past col 0', () => {
    expect(sub(pos(0, 1, 4), frac(1, 2))).toEqual({ col: -1, frac: { n: 3, d: 4 } })
    expect(sub(pos(0), frac(1, 1))).toEqual({ col: -1, frac: ZERO })
  })

  it('round-trips add then sub', () => {
    const durs = [frac(1, 3), frac(5, 7), frac(11, 13), frac(1, 256), frac(9, 2)]
    for (const start of [pos(0), pos(3, 5, 11), pos(-4, 1, 3)]) {
      for (const d of durs) {
        expect(sub(add(start, d), d)).toEqual(start)
      }
    }
  })

  it('stays exact accumulating slot durations across many columns', () => {
    // The §7 resize gesture: extend a note one slot at a time through columns with
    // different nested splits.
    let p = pos(0)
    for (const s of [16 * 16, 9 * 9, 5 * 5, 7 * 7, 11 * 11, 13 * 13]) {
      p = add(p, frac(1, s))
    }
    expect(Number.isSafeInteger(p.frac.n)).toBe(true)
    expect(Number.isSafeInteger(p.frac.d)).toBe(true)
    expect(p.col).toBe(0)
  })
})

describe('diff', () => {
  it('measures distance in quarter notes', () => {
    expect(diff(pos(0), pos(2))).toEqual({ n: 2, d: 1 })
    expect(diff(pos(0, 1, 4), pos(1, 1, 2))).toEqual({ n: 5, d: 4 })
  })

  it('is signed and antisymmetric', () => {
    expect(diff(pos(2), pos(0))).toEqual({ n: -2, d: 1 })
    expect(diff(pos(-3, 1, 7), pos(1, 2, 5))).toEqual({ n: 149, d: 35 })
  })

  it('agrees with toQuarters', () => {
    const pairs: [ReturnType<typeof pos>, ReturnType<typeof pos>][] = [
      [pos(0), pos(5, 3, 11)],
      [pos(-7, 1, 13), pos(2, 4, 9)],
      [pos(3, 255, 256), pos(3, 1, 256)],
    ]
    for (const [a, b] of pairs) {
      expect(toNumber(diff(a, b))).toBeCloseTo(toQuarters(b) - toQuarters(a), 10)
    }
  })

  it('is zero for a position against itself', () => {
    expect(diff(pos(4, 7, 16), pos(4, 7, 16))).toEqual(ZERO)
  })
})

describe('key', () => {
  it('is stable and distinguishes distinct positions', () => {
    expect(key(ORIGIN)).toBe('0:0/1')
    expect(key(pos(-1, 2, 3))).toBe('-1:2/3')
    expect(key(canonicalize(0, frac(-1, 3)))).toBe(key(pos(-1, 2, 3)))
  })
})
