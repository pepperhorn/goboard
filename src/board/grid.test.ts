import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { gridlineXs } from './grid'

const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }
const size = { width: 384, height: 300 }

describe('gridlineXs', () => {
  it('draws one line per intersection of the active grid', () => {
    expect(gridlineXs(vp, size, [{ start: pos(0), value: frac(1, 2) }])).toEqual([
      0, 48, 96, 144, 192, 240, 288, 336, 384,
    ])
  })

  it('follows a coarse grid', () => {
    expect(gridlineXs(vp, size, [{ start: pos(0), value: frac(2) }])).toEqual([0, 192, 384])
  })

  it('drops lines closer together than 4px, per §5.3 guard 6', () => {
    const dense = [{ start: pos(0), value: frac(1, 32) }] // 3px at this zoom
    expect(gridlineXs(vp, size, dense)).toEqual([0, 96, 192, 288, 384])
  })
})
