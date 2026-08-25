import { describe, expect, it } from 'vitest'
import { frac } from './frac'
import { pos } from './pos'
import type { GridRegion } from './grid'
import {
  canonicalizeGrid, gridValueAt, isOnGrid, setGridRange, slotAt, slotStartsIn,
} from './grid'

const R = (col: number, n: number, d: number, vn: number, vd: number): GridRegion => ({
  start: pos(col, n, d),
  value: frac(vn, vd),
})

describe('the implicit default', () => {
  it('is one quarter before the first region and for an empty list', () => {
    expect(gridValueAt([], pos(0))).toEqual(frac(1))
    expect(gridValueAt([R(4, 0, 1, 1, 3)], pos(0))).toEqual(frac(1))
    // The board is boundless leftward.
    expect(gridValueAt([R(0, 0, 1, 1, 3)], pos(-5))).toEqual(frac(1))
  })
})

describe('slotAt', () => {
  it('phase-anchors on the region start, not the origin', () => {
    const regions = [R(5, 1, 4, 2, 3)] // 2/3-quarter grid starting at 5 + 1/4
    expect(slotAt(regions, pos(5, 1, 4))).toEqual({ start: pos(5, 1, 4), dur: frac(2, 3) })
    // 5+1/4 + 2/3 = 5 + 11/12
    expect(slotAt(regions, pos(5, 11, 12))).toEqual({ start: pos(5, 11, 12), dur: frac(2, 3) })
  })

  it('returns the containing slot for a point inside it', () => {
    const regions = [R(0, 0, 1, 1, 3)]
    expect(slotAt(regions, pos(0, 1, 4))).toEqual({ start: pos(0), dur: frac(1, 3) })
  })

  it('clips the last slot at a region boundary', () => {
    // 2/3 grid from col 0, next region at col 1: slots [0,2/3) then [2/3,1) — clipped.
    const regions = [R(0, 0, 1, 2, 3), R(1, 0, 1, 1, 4)]
    expect(slotAt(regions, pos(0, 2, 3))).toEqual({ start: pos(0, 2, 3), dur: frac(1, 3) })
    expect(slotAt(regions, pos(1))).toEqual({ start: pos(1), dur: frac(1, 4) })
  })

  it('handles values coarser than a column', () => {
    const regions = [R(0, 0, 1, 4, 1)] // whole notes
    expect(slotAt(regions, pos(2))).toEqual({ start: pos(0), dur: frac(4) })
    expect(slotAt(regions, pos(4))).toEqual({ start: pos(4), dur: frac(4) })
  })

  it('works in negative columns', () => {
    const regions = [R(-8, 0, 1, 2, 1)]
    expect(slotAt(regions, pos(-5))).toEqual({ start: pos(-6), dur: frac(2) })
  })
})

describe('isOnGrid', () => {
  it('is true exactly on slot starts', () => {
    const regions = [R(0, 0, 1, 1, 3)]
    expect(isOnGrid(regions, pos(0, 1, 3))).toBe(true)
    expect(isOnGrid(regions, pos(0, 1, 4))).toBe(false)
  })
})

describe('slotStartsIn', () => {
  it('lists the intersections a draw pass needs, in order', () => {
    const regions = [R(0, 0, 1, 1, 2), R(1, 0, 1, 1, 3)]
    expect(slotStartsIn(regions, pos(0), pos(2))).toEqual([
      pos(0), pos(0, 1, 2),
      pos(1), pos(1, 1, 3), pos(1, 2, 3),
      pos(2),
    ])
  })
})

describe('canonicalizeGrid', () => {
  it('sorts by start and rejects nothing legal', () => {
    const out = canonicalizeGrid([R(4, 0, 1, 1, 4), R(0, 0, 1, 1, 3)])
    expect(out.map((r) => r.start.col)).toEqual([0, 4])
  })

  it('drops a same-valued region that lands on its predecessor lattice', () => {
    // 1/2 grid from 0; another 1/2 at col 1 changes nothing — col 1 is on the lattice.
    expect(canonicalizeGrid([R(0, 0, 1, 1, 2), R(1, 0, 1, 1, 2)])).toHaveLength(1)
  })

  it('keeps a same-valued region that resets the phase', () => {
    // 1/2 grid from 0; another 1/2 starting at 1/4 is a deliberate phase shift.
    const out = canonicalizeGrid([R(0, 0, 1, 1, 2), R(0, 1, 4, 1, 2)])
    expect(out).toHaveLength(2)
    expect(slotAt(out, pos(0, 1, 4))).toEqual({ start: pos(0, 1, 4), dur: frac(1, 2) })
  })

  it('drops a leading region equal to the implicit quarter default', () => {
    expect(canonicalizeGrid([R(0, 0, 1, 1, 1)])).toEqual([])
  })
})

describe('setGridRange', () => {
  it('sets a range and restores the previous value after it', () => {
    const out = setGridRange([], pos(4), pos(8), frac(1, 3))
    expect(gridValueAt(out, pos(4))).toEqual(frac(1, 3))
    expect(gridValueAt(out, pos(8))).toEqual(frac(1)) // back to the default
  })

  it('swallows regions the range covers', () => {
    const before = [R(2, 0, 1, 1, 6), R(5, 0, 1, 1, 8)]
    const out = setGridRange(before, pos(0), pos(8), frac(1, 4))
    expect(out.filter((r) => r.start.col > 0 && r.start.col < 8)).toEqual([])
    expect(gridValueAt(out, pos(3))).toEqual(frac(1, 4))
  })

  it('extends to infinity when `to` is undefined', () => {
    const out = setGridRange([], pos(4), undefined, frac(1, 2))
    expect(gridValueAt(out, pos(400))).toEqual(frac(1, 2))
  })
})
