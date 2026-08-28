import { describe, expect, it } from 'vitest'
import { LATTICE, frac } from './frac'
import { pos } from './pos'
import {
  DEFAULT_METER,
  barLinesIn,
  barNumberAt,
  buildMeterMap,
  groupLinesIn,
  midiDenominator,
  validateMeter,
} from './meter'

const fourFour = DEFAULT_METER                                     // [1,1,1,1] quarters
const sixEight = { pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }
const sevenEight = { pos: pos(0), beatUnit: frac(1, 2), groups: [2, 2, 3] }

describe('barLinesIn', () => {
  it('places a bar line every sum(groups) * beatUnit quarters', () => {
    expect(barLinesIn([fourFour], pos(0), pos(9))).toEqual([pos(0), pos(4), pos(8)])
    expect(barLinesIn([sixEight], pos(0), pos(7))).toEqual([pos(0), pos(3), pos(6)])
  })

  it('follows a meter change mid-piece', () => {
    const map = [fourFour, { ...sevenEight, pos: pos(8) }]
    expect(barLinesIn(map, pos(0), pos(12))).toEqual([pos(0), pos(4), pos(8), pos(11, 1, 2)])
  })

  it('cuts the bar in progress short when a meter change lands mid-bar', () => {
    // 4/4 from 0, changing to 6/8 at col 6 — a position that is NOT a natural 4/4 bar
    // boundary (those would be 0, 4, 8, ...). The bar that would have run 4..8 must
    // instead end at 6, and the new meter's own bars proceed from there.
    const map = [fourFour, { ...sixEight, pos: pos(6) }]
    expect(barLinesIn(map, pos(0), pos(12))).toEqual([pos(0), pos(4), pos(6), pos(9), pos(12)])
  })

  it('locates the correct bar when `from` starts mid-bar', () => {
    expect(barLinesIn([fourFour], pos(5), pos(9))).toEqual([pos(8)])
  })
})

describe('groupLinesIn', () => {
  it('marks the internal group starts of a compound bar', () => {
    expect(groupLinesIn([sevenEight], pos(0), pos(4))).toEqual([pos(1), pos(2)]) // 2+2+3 eighths
  })

  it('never repeats a bar line as a group line', () => {
    expect(groupLinesIn([sixEight], pos(0), pos(6))).toEqual([pos(1, 1, 2), pos(4, 1, 2)])
  })

  it('marks every beat of a simple meter as a group line', () => {
    expect(groupLinesIn([fourFour], pos(0), pos(4))).toEqual([pos(1), pos(2), pos(3)])
  })
})

describe('barNumberAt', () => {
  it('counts bars from 1 at the origin', () => {
    expect(barNumberAt([fourFour], pos(0))).toEqual({ bar: 1, beat: 1 })
    expect(barNumberAt([fourFour], pos(5))).toEqual({ bar: 2, beat: 2 })
  })

  it('counts bars across a mid-piece meter change, including a cut-short bar', () => {
    const map = [fourFour, { ...sixEight, pos: pos(6) }]
    // Bars: [0,4) #1, [4,6) #2 (cut short by the change), [6,9) #3, [9,12) #4.
    expect(barNumberAt(map, pos(0))).toEqual({ bar: 1, beat: 1 })
    expect(barNumberAt(map, pos(5))).toEqual({ bar: 2, beat: 2 })
    expect(barNumberAt(map, pos(6))).toEqual({ bar: 3, beat: 1 })
    expect(barNumberAt(map, pos(10, 1, 2))).toEqual({ bar: 4, beat: 2 })
  })

  it('reports the felt beat by group, not by beat unit', () => {
    // 2+2+3 eighths: offset 2 quarters (4 eighths) in is the start of the third group.
    expect(barNumberAt([sevenEight], pos(2))).toEqual({ bar: 1, beat: 3 })
  })
})

/** The grid ladder's triplet values (`gridValue.ts`'s presets) — none is a legal `beatUnit`. */
const TRIPLET_BEAT_UNITS: readonly { n: number; d: number }[] = [
  { n: 1, d: 3 },
  { n: 2, d: 3 },
  { n: 4, d: 3 },
  { n: 1, d: 6 },
  { n: 1, d: 12 },
]

describe('validateMeter', () => {
  it('rejects a beatUnit whose SMF denominator is not a power of two', () => {
    expect(() => validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 3 }, groups: [3] }, 'm'))
      .toThrow(/power of two/)
  })

  it('rejects every grid-ladder triplet value as a beatUnit', () => {
    for (const beatUnit of TRIPLET_BEAT_UNITS) {
      expect(() => validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit, groups: [3] }, 'm'))
        .toThrow(/power of two/)
    }
  })

  it('rejects empty or non-positive groups', () => {
    expect(() => validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 2 }, groups: [] }, 'm'))
      .toThrow(RangeError)
    expect(() =>
      validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 2 }, groups: [2, 0] }, 'm'),
    ).toThrow(RangeError)
    expect(() =>
      validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 2 }, groups: [2, -1] }, 'm'),
    ).toThrow(RangeError)
  })

  it('accepts a well-formed meter and round-trips its fields', () => {
    const m = validateMeter({ pos: { col: 8, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 2 }, groups: [2, 2, 3] }, 'm')
    expect(m).toEqual({ ...sevenEight, pos: pos(8) })
  })

  it('names the failing path in its error', () => {
    expect(() => validateMeter(null, 'meterMap[2]')).toThrow(/meterMap\[2\]/)
  })

  /*
   * The power-of-two rule and the §3.1 lattice are two different rules and neither
   * implies the other. `4 / (1/512) = 2048` is a fine SMF denominator, but 512 does
   * not divide L = 2^8*3^4*5^2*7^2*11^2*13^2, and `normalize` only rejects
   * denominators *above* L. Checking this in the validator rather than in the store
   * is what puts the guard on the import path as well as the UI path.
   */
  it('rejects a beat unit off the §3.1 lattice even when its SMF denominator is a power of two', () => {
    expect(midiDenominator(frac(1, 512))).toBe(2048)
    expect(LATTICE % 512).not.toBe(0)
    expect(() =>
      validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 512 }, groups: [4] }, 'meterMap[1]'),
    ).toThrow(/meterMap\[1\]\.beatUnit: denominator 512 is not on the §3.1 lattice/)
  })

  it('still accepts every beat unit the lattice does reach', () => {
    for (const d of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
      expect(() =>
        validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d }, groups: [4] }, 'm'),
      ).not.toThrow()
    }
  })
})

describe('midiDenominator', () => {
  it('maps beat units to SMF denominators', () => {
    expect(midiDenominator(frac(1))).toBe(4)
    expect(midiDenominator(frac(1, 2))).toBe(8)
    expect(midiDenominator(frac(2))).toBe(2)
  })

  it('rejects a beat unit whose denominator is not a power of two', () => {
    expect(() => midiDenominator(frac(1, 3))).toThrow(/power of two/)
  })

  it('rejects every grid-ladder triplet value', () => {
    for (const { n, d } of TRIPLET_BEAT_UNITS) {
      expect(() => midiDenominator(frac(n, d))).toThrow(/power of two/)
    }
  })
})

describe('buildMeterMap', () => {
  it('defaults to one 4/4 at the origin when given nothing', () => {
    expect(buildMeterMap([])).toEqual([fourFour])
  })

  it('leaves an already-anchored map alone', () => {
    const map = [fourFour, { ...sevenEight, pos: pos(8) }]
    expect(buildMeterMap(map)).toEqual(map)
  })

  it('prepends the default meter when the first event starts after the origin', () => {
    const late = { ...sixEight, pos: pos(4) }
    expect(buildMeterMap([late])).toEqual([fourFour, late])
  })

  it('lets a later coincident event win', () => {
    const first = { ...fourFour }
    const second = { ...sixEight, pos: pos(0) }
    expect(buildMeterMap([first, second])).toEqual([second])
  })

  it('rejects an out-of-order list', () => {
    const map = [{ ...sevenEight, pos: pos(8) }, fourFour]
    expect(() => buildMeterMap(map)).toThrow(RangeError)
  })
})

describe('a map must be anchored at or before the origin', () => {
  it('rejects a raw meter list whose first entry starts after column 0, instead of back-extrapolating it', () => {
    // If this were allowed through, `barLinesIn` would extrapolate the 6/8 meter
    // backward from col 4 (bar lines at ..., -2, 1, 4, ...) rather than bounding
    // everything before col 4 with an implicit default.
    const late = { ...sixEight, pos: pos(4) }
    expect(() => barLinesIn([late], pos(0), pos(8))).toThrow(/anchored|buildMeterMap/)
    expect(() => groupLinesIn([late], pos(0), pos(8))).toThrow(/anchored|buildMeterMap/)
    expect(() => barNumberAt([late], pos(0))).toThrow(/anchored|buildMeterMap/)
  })

  it('is normalised by buildMeterMap rather than left to extrapolate', () => {
    const late = { ...sixEight, pos: pos(4) }
    const built = buildMeterMap([late])
    // Before col 4, the implicit 4/4 default governs (bar lines at 0, 4), not 6/8
    // extrapolated backward from col 4 (which would place one at col 1).
    expect(barLinesIn(built, pos(0), pos(4))).toEqual([pos(0), pos(4)])
    // From col 4 onward, the declared 6/8 meter (bar length 3) takes over.
    expect(barLinesIn(built, pos(4), pos(10))).toEqual([pos(4), pos(7), pos(10)])
  })
})

describe('degenerate meters cannot hang the bar walk', () => {
  it('throws rather than looping when groups is empty', () => {
    const bad = { pos: pos(0), beatUnit: frac(1), groups: [] as number[] }
    expect(() => barLinesIn([bad], pos(0), pos(100))).toThrow(RangeError)
    expect(() => groupLinesIn([bad], pos(0), pos(100))).toThrow(RangeError)
    expect(() => barNumberAt([bad], pos(50))).toThrow(RangeError)
  })
})
