import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { DEFAULT_METER, barLinesIn, buildMeterMap } from '../core/meter'
import type { Meter } from '../core/meter'
import {
  MARKER_BAND_HEIGHT, markerAt, markerLabel, markerWidth, quantizeMeterDrop,
} from './meterMarkers'

const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }
const map = [
  { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] },
  { pos: pos(8), beatUnit: frac(1, 2), groups: [2, 2, 3] },
]

describe('markerAt', () => {
  it('hits a marker inside the top band', () => {
    expect(markerAt(vp, map, 8 * 96 + 2, 3)).toBe(1)
  })

  it('misses below the band, so seek and loop keep the rest of the ruler', () => {
    expect(markerAt(vp, map, 8 * 96 + 2, MARKER_BAND_HEIGHT + 4)).toBeNull()
  })

  it('misses between markers', () => {
    expect(markerAt(vp, map, 4 * 96, 3)).toBeNull()
  })

  it('misses on the band boundary itself, so the band is half-open', () => {
    expect(markerAt(vp, map, 8 * 96, MARKER_BAND_HEIGHT - 1)).toBe(1)
    expect(markerAt(vp, map, 8 * 96, MARKER_BAND_HEIGHT)).toBeNull()
  })

  it('takes the later marker when two chips overlap, matching what is drawn on top', () => {
    // Zoomed far out, a meter change two quarters after another lands inside its chip.
    const tight = { ...vp, pxPerQuarter: 2 }
    const packed = [
      { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] },
      { pos: pos(2), beatUnit: frac(1), groups: [1, 1, 1] },
    ]
    expect(markerAt(tight, packed, 4, 3)).toBe(1)
  })

  it('is only as wide as the chip it draws', () => {
    const half = markerWidth(markerLabel(map[1]!)) / 2
    expect(markerAt(vp, map, 8 * 96 + half, 3)).toBe(1)
    expect(markerAt(vp, map, 8 * 96 + half + 1, 3)).toBeNull()
  })
})

describe('markerLabel', () => {
  it('reads a grouped meter as its total over the SMF denominator', () => {
    expect(markerLabel({ pos: pos(8), beatUnit: frac(1, 2), groups: [2, 2, 3] })).toBe('7/8')
  })

  it('reads 4/4 and 3/4', () => {
    expect(markerLabel(DEFAULT_METER)).toBe('4/4')
    expect(markerLabel({ pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1] })).toBe('3/4')
  })

  it('reads a dotted-feel 6/8 as 6/8, not 2/4', () => {
    expect(markerLabel({ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] })).toBe('6/8')
  })
})

describe('quantizeMeterDrop', () => {
  const fourFour = buildMeterMap([DEFAULT_METER])

  it('snaps to the nearest bar line, not the nearest quarter', () => {
    // 4/4 bars start at 0, 4, 8, 12. A drop at 9.3 is nearest to 8.
    expect(quantizeMeterDrop(fourFour, 9.3)).toEqual(pos(8))
    expect(quantizeMeterDrop(fourFour, 10.9)).toEqual(pos(12))
  })

  it('never lands at or before the origin, which belongs to the anchor meter', () => {
    expect(quantizeMeterDrop(fourFour, 0.1)).toEqual(pos(4))
    expect(quantizeMeterDrop(fourFour, -3)).toEqual(pos(4))
  })

  it('follows a meter change: 7/8 bars are 3.5 quarters, so its bar lines are too', () => {
    const mixed = buildMeterMap([
      DEFAULT_METER,
      { pos: pos(8), beatUnit: frac(1, 2), groups: [2, 2, 3] },
    ])
    // Bars: 0, 4, 8, 11.5, 15, ... A drop at 11.4 snaps to the 7/8 bar line at 11.5.
    expect(quantizeMeterDrop(mixed, 11.4)).toEqual(pos(11, 1, 2))
  })

  it('returns a position that is genuinely a bar line of the map it was given', () => {
    const mixed = buildMeterMap([
      DEFAULT_METER,
      { pos: pos(6), beatUnit: frac(1, 2), groups: [2, 3] },
    ])
    for (const q of [1.1, 5.9, 6.4, 9.7, 13.2]) {
      const landed = quantizeMeterDrop(mixed, q)
      expect(barLinesIn(mixed, landed, landed)).toEqual([landed])
    }
  })

  it('stores an exact fraction — the pointer float only chooses among bar lines', () => {
    const eighths = buildMeterMap([
      DEFAULT_METER,
      { pos: pos(4), beatUnit: frac(1, 2), groups: [2, 2, 3] },
    ])
    const landed = quantizeMeterDrop(eighths, 7.51)
    expect(landed.frac.d).toBe(2)
    expect(Number.isInteger(landed.col)).toBe(true)
    expect(Number.isInteger(landed.frac.n)).toBe(true)
  })

  it('is idempotent: dropping a marker on its own bar line does not move it', () => {
    const rest: readonly Meter[] = buildMeterMap([DEFAULT_METER])
    expect(quantizeMeterDrop(rest, 8)).toEqual(pos(8))
  })
})
