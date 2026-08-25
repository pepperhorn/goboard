import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { isOffGrid } from './stones'

const note = (at: ReturnType<typeof pos>) => ({ id: 'n', layerId: 'l', pos: at, dur: frac(1), pitch: 60 })

describe('isOffGrid on regions', () => {
  it('flags an onset that is not a slot start', () => {
    const regions = [{ start: pos(0), value: frac(1, 3) }]
    expect(isOffGrid(regions, note(pos(0, 1, 3)))).toBe(false)
    expect(isOffGrid(regions, note(pos(0, 1, 4)))).toBe(true)
  })

  it('treats the implicit quarter default as a grid', () => {
    expect(isOffGrid([], note(pos(3)))).toBe(false)
    expect(isOffGrid([], note(pos(3, 1, 2)))).toBe(true)
  })
})
