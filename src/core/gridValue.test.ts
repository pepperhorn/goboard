import { describe, expect, it } from 'vitest'
import { frac } from './frac'
import { GRID_PRESETS, gridValueLabel, validateGridValue } from './gridValue'

describe('GRID_PRESETS', () => {
  it('carries the eleven named values from whole to 32nd-triplet', () => {
    expect(GRID_PRESETS.map((p) => p.id)).toEqual([
      'whole', 'half', 'half-triplet', 'quarter', 'quarter-triplet',
      '8th', '8th-triplet', '16th', '16th-triplet', '32nd', '32nd-triplet',
    ])
    expect(GRID_PRESETS.map((p) => p.value)).toEqual([
      frac(4), frac(2), frac(4, 3), frac(1), frac(2, 3),
      frac(1, 2), frac(1, 3), frac(1, 4), frac(1, 6), frac(1, 8), frac(1, 12),
    ])
  })
})

describe('validateGridValue', () => {
  it('accepts any lattice fraction in range, not just the presets', () => {
    // Quintuplets and 11-tuplets are why §3.1 is rational at all.
    expect(validateGridValue({ n: 1, d: 5 }, 'grid')).toEqual(frac(1, 5))
    expect(validateGridValue({ n: 1, d: 11 }, 'grid')).toEqual(frac(1, 11))
    expect(validateGridValue({ n: 2, d: 7 }, 'grid')).toEqual(frac(2, 7))
  })

  it('reduces on the way in', () => {
    expect(validateGridValue({ n: 2, d: 8 }, 'grid')).toEqual(frac(1, 4))
  })

  it('rejects values outside 1/256..4 quarters', () => {
    expect(() => validateGridValue({ n: 5, d: 1 }, 'grid')).toThrow(RangeError)
    expect(() => validateGridValue({ n: 1, d: 512 }, 'grid')).toThrow(RangeError)
    expect(() => validateGridValue({ n: 0, d: 1 }, 'grid')).toThrow(RangeError)
    expect(() => validateGridValue({ n: -1, d: 4 }, 'grid')).toThrow(RangeError)
  })

  it('rejects denominators off the §3.1 lattice', () => {
    expect(() => validateGridValue({ n: 1, d: 17 }, 'grid')).toThrow(RangeError)
  })

  it('names the path it rejected', () => {
    expect(() => validateGridValue('x', 'layers[2].grid[0].value')).toThrow(
      /layers\[2\]\.grid\[0\]\.value/,
    )
  })
})

describe('gridValueLabel', () => {
  it('uses the preset name when there is one', () => {
    expect(gridValueLabel(frac(1, 4))).toBe('16th')
    expect(gridValueLabel(frac(4))).toBe('whole')
  })

  it('falls back to the fraction for a custom tuplet', () => {
    expect(gridValueLabel(frac(1, 7))).toBe('1/7')
    expect(gridValueLabel(frac(2, 7))).toBe('2/7')
  })
})
