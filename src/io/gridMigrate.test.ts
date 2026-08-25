import { describe, expect, it } from 'vitest'
import type { Subdiv } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { enumerateSlots } from '../core/subdiv'
import { slotStartsIn } from '../core/grid'
import { subdivsToRegions } from './gridMigrate'

/** The slot starts a v1 column produces, as absolute positions. */
const v1Starts = (col: number, sd: Subdiv | undefined): string[] =>
  enumerateSlots(sd).map((s) => `${col + s.start.n / s.start.d}`)

const v2Starts = (regions: ReturnType<typeof subdivsToRegions>, col: number): string[] =>
  slotStartsIn(regions, pos(col), pos(col + 1))
    .filter((p) => p.col === col)
    .map((p) => `${p.col + p.frac.n / p.frac.d}`)

describe('subdivsToRegions', () => {
  it('maps a flat split to one region plus a restore', () => {
    const regions = subdivsToRegions(new Map([[2, { split: 3 }]]))
    expect(regions).toEqual([
      { start: pos(2), value: frac(1, 3) },
      { start: pos(3), value: frac(1) },
    ])
  })

  it('emits one region per uniform run for a nested column', () => {
    const sd: Subdiv = { split: 4, children: [null, null, { split: 3 }, null] }
    const regions = subdivsToRegions(new Map([[0, sd]]))
    expect(regions).toEqual([
      { start: pos(0), value: frac(1, 4) },
      { start: pos(0, 2, 4), value: frac(1, 12) },
      { start: pos(0, 3, 4), value: frac(1, 4) },
      { start: pos(1), value: frac(1) },
    ])
  })

  it('preserves enumerated slots exactly — the definition of lossless', () => {
    const cases: Subdiv[] = [
      { split: 1 },
      { split: 5 },
      { split: 11 },
      { split: 4, children: [{ split: 3 }, null, { split: 2 }, null] },
      { split: 13, children: Array.from({ length: 13 }, (_, i) => (i === 6 ? { split: 11 } : null)) },
    ]
    for (const sd of cases) {
      const regions = subdivsToRegions(new Map([[7, sd]]))
      expect(v2Starts(regions, 7), JSON.stringify(sd)).toEqual(v1Starts(7, sd))
    }
  })

  it('drops the restore when the next column carries its own entry', () => {
    const regions = subdivsToRegions(new Map([[0, { split: 2 }], [1, { split: 3 }]]))
    expect(regions).toEqual([
      { start: pos(0), value: frac(1, 2) },
      { start: pos(1), value: frac(1, 3) },
      { start: pos(2), value: frac(1) },
    ])
  })

  it('canonicalizes no-op entries away', () => {
    expect(subdivsToRegions(new Map([[3, { split: 1 }]]))).toEqual([])
    expect(subdivsToRegions(new Map([[3, { split: 2, children: [null, null] }]]))).toEqual([
      { start: pos(3), value: frac(1, 2) },
      { start: pos(4), value: frac(1) },
    ])
  })

  it('handles an empty map and negative columns', () => {
    expect(subdivsToRegions(new Map())).toEqual([])
    expect(subdivsToRegions(new Map([[-2, { split: 4 }]]))).toEqual([
      { start: pos(-2), value: frac(1, 4) },
      { start: pos(-1), value: frac(1) },
    ])
  })
})
