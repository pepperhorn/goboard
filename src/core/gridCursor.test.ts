import { describe, expect, it, vi } from 'vitest'
import { frac } from './frac'
import { pos } from './pos'
import * as grid from './grid'
import { createGridCursor } from './gridCursor'

const regions = [
  { start: pos(0), value: frac(1, 2) },
  { start: pos(4), value: frac(1, 3) },
  { start: pos(8), value: frac(1, 4) },
]

describe('createGridCursor', () => {
  it('agrees with slotAt everywhere, in order', () => {
    const cursor = createGridCursor(regions)
    for (let q = 0; q < 12; q += 0.25) {
      const p = pos(Math.floor(q), Math.round((q % 1) * 4), 4)
      expect(cursor.slotAt(p)).toEqual(grid.slotAt(regions, p))
    }
  })

  it('agrees with slotAt on a backward seek', () => {
    const cursor = createGridCursor(regions)
    cursor.slotAt(pos(10))
    expect(cursor.slotAt(pos(1))).toEqual(grid.slotAt(regions, pos(1)))
  })

  it('does not binary-search while walking forward', () => {
    const spy = vi.spyOn(grid, 'regionIndexAt')
    const cursor = createGridCursor(regions)
    for (let col = 0; col < 12; col++) cursor.slotAt(pos(col))
    // One search to place the cursor at most; the rest step forward.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
  })

  it('reset returns it to the start for the next frame', () => {
    const cursor = createGridCursor(regions)
    cursor.slotAt(pos(10))
    cursor.reset()
    expect(cursor.slotAt(pos(0))).toEqual(grid.slotAt(regions, pos(0)))
  })
})
