import { describe, expect, it } from 'vitest'
import type { Pos, TempoEvent } from './types'
import { frac } from './frac'
import { ORIGIN, add as padd, eq as peq, key as pkey, pos, toQuarters } from './pos'
import {
  DEFAULT_BPM,
  MAX_BPM,
  MIN_BPM,
  buildTempoMap,
  createTempoCursor,
  durationSeconds,
  quartersToPos,
  secondsToPos,
  toSeconds,
} from './tempo'

/** 120 BPM everywhere: 1 quarter = 0.5 s. */
const flat = buildTempoMap([])

/**
 * 120 from col 0, 60 from col 4, 240 from col 8, 480 from col 12.
 * Boundary seconds are exact binary fractions, so these can be asserted with `toBe`.
 *   col 0  -> 0
 *   col 4  -> 4 * 0.5   = 2
 *   col 8  -> 2 + 4 * 1 = 6
 *   col 12 -> 6 + 4 * 0.25  = 7
 *   col 16 -> 7 + 4 * 0.125 = 7.5
 */
const stepped = buildTempoMap([
  { pos: pos(4), bpm: 60 },
  { pos: pos(8), bpm: 240 },
  { pos: pos(12), bpm: 480 },
])

describe('buildTempoMap', () => {
  it('supplies an implicit 120 BPM event at col 0 for an empty map', () => {
    expect(flat.events).toEqual([{ pos: ORIGIN, bpm: DEFAULT_BPM }])
    expect(flat.quarters).toEqual([0])
    expect(flat.seconds).toEqual([0])
  })

  it('prepends the implicit default when the first event is after col 0', () => {
    const map = buildTempoMap([{ pos: pos(4), bpm: 60 }])
    expect(map.events).toHaveLength(2)
    expect(map.events[0]).toEqual({ pos: ORIGIN, bpm: DEFAULT_BPM })
    expect(map.events[1]?.bpm).toBe(60)
  })

  it('does not prepend when the caller supplies an event at col 0', () => {
    const map = buildTempoMap([{ pos: ORIGIN, bpm: 90 }, { pos: pos(4), bpm: 60 }])
    expect(map.events).toHaveLength(2)
    expect(map.events[0]?.bpm).toBe(90)
  })

  it('does not prepend when the caller supplies an event before col 0', () => {
    const map = buildTempoMap([{ pos: pos(-4), bpm: 90 }])
    expect(map.events).toHaveLength(1)
    expect(map.events[0]?.bpm).toBe(90)
  })

  it('anchors seconds at col 0 even when the first event is before col 0', () => {
    // 90 BPM = 2/3 s per quarter, starting at col -3.
    const map = buildTempoMap([{ pos: pos(-3), bpm: 90 }])
    expect(toSeconds(map, ORIGIN)).toBeCloseTo(0, 12)
    expect(toSeconds(map, pos(-3))).toBeCloseTo(-2, 12)
    expect(toSeconds(map, pos(3))).toBeCloseTo(2, 12)
  })

  it('precomputes prefix quarters and seconds at every boundary', () => {
    expect(stepped.quarters).toEqual([0, 4, 8, 12])
    expect(stepped.seconds).toEqual([0, 2, 6, 7])
  })

  it('de-duplicates coincident positions, last wins, leaving no zero-length segment', () => {
    const map = buildTempoMap([
      { pos: pos(4), bpm: 60 },
      { pos: pos(4), bpm: 240 },
      { pos: pos(4, 1, 2), bpm: 90 },
    ])
    expect(map.events.map((e) => e.bpm)).toEqual([DEFAULT_BPM, 240, 90])
    // Every segment has positive length, so a binary search can never land inside one.
    const keys = map.events.map((e) => pkey(e.pos))
    expect(new Set(keys).size).toBe(keys.length)
    for (let i = 1; i < map.quarters.length; i++) {
      expect(map.quarters[i]!).toBeGreaterThan(map.quarters[i - 1]!)
      expect(map.seconds[i]!).toBeGreaterThan(map.seconds[i - 1]!)
    }
  })

  it('de-duplicates a caller event at col 0 against the implicit default', () => {
    const map = buildTempoMap([{ pos: ORIGIN, bpm: 60 }])
    expect(map.events).toEqual([{ pos: ORIGIN, bpm: 60 }])
    expect(toSeconds(map, pos(1))).toBe(1)
  })

  it('rejects bpm 0', () => {
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: 0 }])).toThrow(RangeError)
  })

  it('rejects bpm 1e6', () => {
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: 1e6 }])).toThrow(RangeError)
  })

  it('rejects negative, NaN and infinite bpm', () => {
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: -120 }])).toThrow(RangeError)
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: NaN }])).toThrow(RangeError)
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: Infinity }])).toThrow(RangeError)
  })

  it('rejects bpm just outside [MIN_BPM, MAX_BPM] and accepts the bounds', () => {
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: MIN_BPM - 1e-6 }])).toThrow(RangeError)
    expect(() => buildTempoMap([{ pos: ORIGIN, bpm: MAX_BPM + 1e-6 }])).toThrow(RangeError)
    expect(buildTempoMap([{ pos: ORIGIN, bpm: MIN_BPM }]).events[0]?.bpm).toBe(MIN_BPM)
    expect(buildTempoMap([{ pos: ORIGIN, bpm: MAX_BPM }]).events[0]?.bpm).toBe(MAX_BPM)
  })

  it('rejects events that are not sorted by pos', () => {
    expect(() =>
      buildTempoMap([
        { pos: pos(4), bpm: 60 },
        { pos: pos(2), bpm: 90 },
      ]),
    ).toThrow(RangeError)
    // Out of order only within a column.
    expect(() =>
      buildTempoMap([
        { pos: pos(1, 1, 2), bpm: 60 },
        { pos: pos(1, 1, 3), bpm: 90 },
      ]),
    ).toThrow(RangeError)
  })

  it('rejects a non-canonical pos', () => {
    const bad = { pos: { col: 0, frac: frac(4, 3) } as Pos, bpm: 120 } as TempoEvent
    expect(() => buildTempoMap([bad])).toThrow(RangeError)
  })
})

describe('toSeconds', () => {
  it('is 0.5 s per quarter at a constant 120 BPM', () => {
    expect(toSeconds(flat, ORIGIN)).toBe(0)
    expect(toSeconds(flat, pos(1))).toBe(0.5)
    expect(toSeconds(flat, pos(4))).toBe(2)
    expect(toSeconds(flat, pos(0, 1, 2))).toBe(0.25)
    expect(toSeconds(flat, pos(3, 3, 4))).toBe(1.875)
  })

  it('extrapolates backwards along the first segment for negative columns', () => {
    expect(toSeconds(flat, pos(-2))).toBe(-1)
    expect(toSeconds(flat, pos(-1, 1, 2))).toBe(-0.25)
    expect(toSeconds(flat, pos(-1, 1, 3))).toBeCloseTo(-1 / 3, 12)
    expect(toSeconds(flat, pos(-100))).toBe(-50)
  })

  it('accumulates exactly across four segments', () => {
    expect(toSeconds(stepped, pos(0))).toBe(0)
    expect(toSeconds(stepped, pos(2))).toBe(1)
    expect(toSeconds(stepped, pos(4))).toBe(2)
    expect(toSeconds(stepped, pos(6))).toBe(4)
    expect(toSeconds(stepped, pos(8))).toBe(6)
    expect(toSeconds(stepped, pos(10))).toBe(6.5)
    expect(toSeconds(stepped, pos(12))).toBe(7)
    expect(toSeconds(stepped, pos(16))).toBe(7.5)
    // Beyond the last event the final tempo continues forever.
    expect(toSeconds(stepped, pos(100))).toBe(7 + 88 * 0.125)
  })

  it('is exact on fractional positions inside a later segment', () => {
    // col 9 + 1/2 sits in the 240 BPM segment: 6 + 1.5 * 0.25.
    expect(toSeconds(stepped, pos(9, 1, 2))).toBe(6.375)
  })

  it('extrapolates backwards along the first segment of a multi-segment map', () => {
    expect(toSeconds(stepped, pos(-4))).toBe(-2)
  })

  it('is strictly increasing over a sweep', () => {
    let prev = -Infinity
    for (let q = -20; q <= 40; q++) {
      for (const f of [0, 1 / 4, 1 / 3, 2 / 3]) {
        const s = toSeconds(stepped, quartersToPos(q + f))
        expect(s).toBeGreaterThan(prev)
        prev = s
      }
    }
  })
})

describe('durationSeconds', () => {
  it('matches the segment tempo for a note inside one segment', () => {
    expect(durationSeconds(flat, pos(2), frac(1, 4))).toBe(0.125)
    expect(durationSeconds(stepped, pos(5), frac(1))).toBe(1)
    expect(durationSeconds(stepped, pos(9), frac(2))).toBe(0.5)
  })

  it('gives the true elapsed seconds for a note whose duration spans a tempo change', () => {
    // Note at col 3, two quarters long. Tempo is 120 until col 4, then 60.
    //   col 3 -> 1.5 s ; col 5 -> 2 + 1 * 1.0 = 3 s  => 1.5 s elapsed
    // Naive "duration at the onset tempo" would say 1.0 s; the note is really 1.5 s.
    expect(durationSeconds(stepped, pos(3), frac(2))).toBe(1.5)
    expect(durationSeconds(stepped, pos(3), frac(2))).not.toBe(2 * 0.5)
  })

  it('handles a fractional onset and duration across a tempo change', () => {
    // col 3.5 -> 1.75 s ; col 4.75 -> 2 + 0.75 * 1.0 = 2.75 s => 1.0 s
    expect(durationSeconds(stepped, pos(3, 1, 2), frac(5, 4))).toBe(1)
  })

  it('spans three segments', () => {
    // col 2 -> 1 s ; col 13 -> 7 + 1 * 0.125 = 7.125 s
    expect(durationSeconds(stepped, pos(2), frac(11))).toBe(6.125)
  })

  it('agrees with the difference of the two endpoint conversions', () => {
    const p = pos(3, 5, 7)
    const d = frac(23, 6)
    expect(durationSeconds(stepped, p, d)).toBeCloseTo(
      toSeconds(stepped, padd(p, d)) - toSeconds(stepped, p),
      12,
    )
  })
})

describe('secondsToPos', () => {
  const spread: Pos[] = [
    ORIGIN,
    pos(1),
    pos(0, 1, 2),
    pos(2, 1, 3),
    pos(3, 2, 7),
    pos(5, 5, 12),
    pos(7, 11, 13),
    pos(9, 3, 4),
    pos(13, 1, 6),
    pos(-1, 1, 2),
    pos(-2, 1, 3),
    pos(-5, 7, 8),
    pos(-9),
  ]

  it('round-trips toSeconds within a tight tolerance on both maps', () => {
    for (const map of [flat, stepped]) {
      for (const p of spread) {
        const rt = secondsToPos(map, toSeconds(map, p))
        expect(toQuarters(rt) - toQuarters(p)).toBeCloseTo(0, 9)
      }
    }
  })

  it('recovers the exact rational position for lattice-sized denominators', () => {
    for (const map of [flat, stepped]) {
      for (const p of spread) {
        const rt = secondsToPos(map, toSeconds(map, p))
        expect(peq(rt, p), `${pkey(p)} -> ${pkey(rt)}`).toBe(true)
      }
    }
  })

  it('inverts the tempo map at and around segment boundaries', () => {
    expect(peq(secondsToPos(stepped, 2), pos(4))).toBe(true)
    expect(peq(secondsToPos(stepped, 6), pos(8))).toBe(true)
    expect(peq(secondsToPos(stepped, 7), pos(12))).toBe(true)
    expect(toQuarters(secondsToPos(stepped, 6.5))).toBeCloseTo(10, 9)
  })

  it('extrapolates backwards for negative seconds', () => {
    expect(peq(secondsToPos(flat, -1), pos(-2))).toBe(true)
    expect(toQuarters(secondsToPos(stepped, -2))).toBeCloseTo(-4, 9)
  })

  it('bounds the approximation denominator', () => {
    // An irrational-ish playhead time still yields a legal, bounded Frac.
    const p = secondsToPos(stepped, Math.PI)
    expect(p.frac.d).toBeLessThanOrEqual(1_000_000)
    expect(toSeconds(stepped, p)).toBeCloseTo(Math.PI, 6)
  })
})

describe('quartersToPos', () => {
  it('splits into a floored column and a canonical frac', () => {
    expect(peq(quartersToPos(0), ORIGIN)).toBe(true)
    expect(peq(quartersToPos(3.5), pos(3, 1, 2))).toBe(true)
    expect(peq(quartersToPos(-1 / 3), pos(-1, 2, 3))).toBe(true)
    expect(peq(quartersToPos(-2), pos(-2))).toBe(true)
  })
})

describe('createTempoCursor', () => {
  it('agrees with the non-cursor path over a monotone sweep', () => {
    const cursor = createTempoCursor(stepped)
    for (let s = -3; s <= 12; s += 0.01) {
      const viaCursor = cursor.secondsToQuarters(s)
      const direct = toQuarters(secondsToPos(stepped, s))
      expect(viaCursor).toBeCloseTo(direct, 9)
    }
  })

  it('advances across several segments within one step', () => {
    const cursor = createTempoCursor(stepped)
    expect(cursor.secondsToQuarters(0)).toBeCloseTo(0, 12)
    // One jump past three boundaries at once.
    expect(cursor.secondsToQuarters(7.25)).toBeCloseTo(14, 12)
  })

  it('handles a backward seek by re-searching', () => {
    const cursor = createTempoCursor(stepped)
    cursor.secondsToQuarters(7.25)
    expect(cursor.secondsToQuarters(1)).toBeCloseTo(2, 12)
    expect(cursor.secondsToQuarters(-1)).toBeCloseTo(-2, 12)
    expect(cursor.secondsToQuarters(6.5)).toBeCloseTo(10, 12)
  })

  it('reset() returns the cursor to the first segment without changing results', () => {
    const cursor = createTempoCursor(stepped)
    cursor.secondsToQuarters(7.25)
    cursor.reset()
    expect(cursor.secondsToQuarters(2)).toBeCloseTo(4, 12)
  })

  it('secondsToPos agrees with the module-level inverse', () => {
    const cursor = createTempoCursor(stepped)
    for (const s of [-1.5, 0, 0.75, 2, 5.5, 6.9, 7.5]) {
      expect(peq(cursor.secondsToPos(s), secondsToPos(stepped, s))).toBe(true)
    }
  })

  it('is O(1) amortized: a full sweep visits each boundary once', () => {
    const many: TempoEvent[] = []
    for (let i = 1; i <= 200; i++) many.push({ pos: pos(i * 4), bpm: 60 + (i % 7) * 20 })
    const map = buildTempoMap(many)
    const cursor = createTempoCursor(map)
    const end = map.seconds[map.seconds.length - 1]!
    for (let s = 0; s <= end; s += end / 5000) {
      expect(cursor.secondsToQuarters(s)).toBeCloseTo(toQuarters(secondsToPos(map, s)), 6)
    }
  })
})
