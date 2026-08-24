import { describe, expect, it } from 'vitest'
import type { Subdiv, SubdivL2 } from './types'
import { ONE, add, frac, lt, toString } from './frac'
import {
  MAX_SLOTS,
  MAX_SPLIT,
  enumerateSlots,
  slotAt,
  slotCount,
  slotIndexAt,
  validateSubdiv,
} from './subdiv'

/** The §3.2 worked example: 16ths with triplet 32nds on the last 16th. */
const WORKED: Subdiv = { split: 4, children: [null, null, null, { split: 3 }] }

/** The densest legal column: 16 x 16 = the 256-slot maximum. */
const MAXIMAL: Subdiv = {
  split: MAX_SPLIT,
  children: Array.from({ length: MAX_SPLIT }, (): SubdivL2 => ({ split: MAX_SPLIT })),
}

/** Readable diffs: `['0', '1/4', '1/2', ...]` beats sixteen `{n,d}` objects. */
const starts = (sd: Subdiv | undefined): string[] => enumerateSlots(sd).map((s) => toString(s.start))
const durs = (sd: Subdiv | undefined): string[] => enumerateSlots(sd).map((s) => toString(s.dur))

/** A depth-1 node of `split` with one child at `index`. */
function withChild(split: number, index: number, child: SubdivL2): Subdiv {
  return {
    split,
    children: Array.from({ length: split }, (_, i) => (i === index ? child : null)),
  }
}

describe('enumerateSlots', () => {
  it('treats a missing map entry as {split:1} — one slot spanning the column', () => {
    expect(enumerateSlots(undefined)).toEqual([{ start: frac(0), dur: frac(1) }])
    expect(enumerateSlots({ split: 1 })).toEqual(enumerateSlots(undefined))
  })

  it('splits a childless node into equal slots', () => {
    expect(starts({ split: 4 })).toEqual(['0', '1/4', '1/2', '3/4'])
    expect(durs({ split: 4 })).toEqual(['1/4', '1/4', '1/4', '1/4'])
    expect(starts({ split: 5 })).toEqual(['0', '1/5', '2/5', '3/5', '4/5'])
  })

  it('treats an explicit null child as a leaf', () => {
    expect(enumerateSlots({ split: 3, children: [null, null, null] })).toEqual(
      enumerateSlots({ split: 3 }),
    )
  })

  it('expands the §3.2 worked example into 6 slots at exact fractions', () => {
    const slots = enumerateSlots(WORKED)
    expect(slots).toHaveLength(6)
    // 0, 1/4, 2/4, 3/4, 3/4 + 1/12, 3/4 + 2/12
    expect(slots.map((s) => s.start)).toEqual([
      frac(0),
      frac(1, 4),
      frac(2, 4),
      frac(3, 4),
      add(frac(3, 4), frac(1, 12)),
      add(frac(3, 4), frac(2, 12)),
    ])
    expect(durs(WORKED)).toEqual(['1/4', '1/4', '1/4', '1/12', '1/12', '1/12'])
  })

  it('nests 11 inside 13 at exact fractions', () => {
    const sd = withChild(13, 5, { split: 11 })
    const slots = enumerateSlots(sd)
    expect(slots).toHaveLength(12 + 11)
    // Slot 5 of 13 spans [5/13, 6/13); its 11 sub-slots start at (5*11 + j)/143.
    for (let j = 0; j < 11; j++) {
      expect(slots[5 + j]!.start).toEqual(frac(55 + j, 143))
      expect(slots[5 + j]!.dur).toEqual(frac(1, 143))
    }
    expect(slots[5]!.start).toEqual(frac(5, 13))
    expect(slots[5 + 11]!.start).toEqual(frac(6, 13))
  })

  it('nests 13 inside 11 at exact fractions', () => {
    const sd = withChild(11, 10, { split: 13 })
    const slots = enumerateSlots(sd)
    expect(slots).toHaveLength(10 + 13)
    // The last slot of 11, subdivided by 13: starts at (10*13 + j)/143.
    for (let j = 0; j < 13; j++) {
      expect(slots[10 + j]!.start).toEqual(frac(130 + j, 143))
      expect(slots[10 + j]!.dur).toEqual(frac(1, 143))
    }
    expect(slots[10]!.start).toEqual(frac(10, 11))
    expect(slots.at(-1)!.start).toEqual(frac(142, 143))
  })

  it('produces exactly 256 slots at the maximum, tiling the column exactly', () => {
    const slots = enumerateSlots(MAXIMAL)
    expect(slots).toHaveLength(MAX_SLOTS)
    for (let i = 1; i < slots.length; i++) {
      expect(lt(slots[i - 1]!.start, slots[i]!.start)).toBe(true)
    }
    const total = slots.reduce((acc, s) => add(acc, s.dur), frac(0))
    expect(total).toEqual(ONE)
    for (const s of slots) {
      expect(s.start.d).toBeLessThanOrEqual(MAX_SLOTS)
      expect(s.dur.d).toBeLessThanOrEqual(MAX_SLOTS)
    }
    expect(slots[0]!.start).toEqual(frac(0))
    expect(slots[1]!.start).toEqual(frac(1, 256))
    expect(slots[16]!.start).toEqual(frac(1, 16))
    expect(slots.at(-1)!.start).toEqual(frac(255, 256))
  })

  it('leaves no gap or overlap: each start is the previous start plus its duration', () => {
    for (const sd of [undefined, { split: 1 }, { split: 7 }, WORKED, MAXIMAL]) {
      const slots = enumerateSlots(sd)
      let cursor = frac(0)
      for (const s of slots) {
        expect(s.start).toEqual(cursor)
        cursor = add(cursor, s.dur)
      }
      expect(cursor).toEqual(ONE)
    }
  })
})

describe('slotCount', () => {
  it('matches enumerateSlots().length without materializing the array', () => {
    const cases: (Subdiv | undefined)[] = [
      undefined,
      { split: 1 },
      { split: 16 },
      WORKED,
      withChild(13, 5, { split: 11 }),
      withChild(11, 10, { split: 13 }),
      MAXIMAL,
    ]
    for (const sd of cases) {
      expect(slotCount(sd)).toBe(enumerateSlots(sd).length)
    }
    expect(slotCount(undefined)).toBe(1)
    expect(slotCount(WORKED)).toBe(6)
    expect(slotCount(MAXIMAL)).toBe(MAX_SLOTS)
  })
})

describe('slotIndexAt', () => {
  it('resolves offsets in the default single-slot column', () => {
    expect(slotIndexAt(undefined, frac(0))).toBe(0)
    expect(slotIndexAt(undefined, frac(1, 2))).toBe(0)
    expect(slotIndexAt(undefined, frac(255, 256))).toBe(0)
  })

  it('treats slot spans as half-open: a boundary belongs to the slot it starts', () => {
    expect(slotIndexAt(WORKED, frac(0))).toBe(0)
    expect(slotIndexAt(WORKED, frac(1, 8))).toBe(0)
    expect(slotIndexAt(WORKED, frac(1, 4))).toBe(1)
    expect(slotIndexAt(WORKED, frac(1, 2))).toBe(2)
    expect(slotIndexAt(WORKED, frac(3, 4))).toBe(3)
    expect(slotIndexAt(WORKED, add(frac(3, 4), frac(1, 12)))).toBe(4)
    expect(slotIndexAt(WORKED, add(frac(3, 4), frac(2, 12)))).toBe(5)
    expect(slotIndexAt(WORKED, frac(99, 100))).toBe(5)
  })

  it('lands every slot on its own index, for every tree', () => {
    for (const sd of [undefined, WORKED, withChild(13, 5, { split: 11 }), MAXIMAL]) {
      const slots = enumerateSlots(sd)
      slots.forEach((s, i) => {
        expect(slotIndexAt(sd, s.start)).toBe(i)
        // Just inside the slot, and just short of its end.
        const mid = add(s.start, frac(s.dur.n, s.dur.d * 2))
        expect(slotIndexAt(sd, mid)).toBe(i)
      })
    }
  })

  it('returns -1 outside [0, 1)', () => {
    expect(slotIndexAt(WORKED, frac(-1, 4))).toBe(-1)
    expect(slotIndexAt(WORKED, frac(1))).toBe(-1)
    expect(slotIndexAt(WORKED, frac(5, 4))).toBe(-1)
    expect(slotIndexAt(undefined, frac(-1, 256))).toBe(-1)
  })
})

describe('slotAt', () => {
  it('returns the containing slot', () => {
    expect(slotAt(undefined, frac(1, 3))).toEqual({ start: frac(0), dur: frac(1) })
    expect(slotAt(WORKED, frac(1, 4))).toEqual({ start: frac(1, 4), dur: frac(1, 4) })
    expect(slotAt(WORKED, frac(7, 8))).toEqual({ start: frac(5, 6), dur: frac(1, 12) })
  })

  it('agrees with enumerateSlots for every tree', () => {
    for (const sd of [undefined, WORKED, withChild(11, 10, { split: 13 }), MAXIMAL]) {
      const slots = enumerateSlots(sd)
      slots.forEach((s) => {
        expect(slotAt(sd, s.start)).toEqual(s)
      })
    }
  })

  it('returns undefined outside [0, 1)', () => {
    expect(slotAt(WORKED, frac(1))).toBeUndefined()
    expect(slotAt(WORKED, frac(-1, 12))).toBeUndefined()
  })
})

describe('validateSubdiv', () => {
  it('accepts the default, the worked example and the 256-slot maximum', () => {
    expect(validateSubdiv({ split: 1 })).toEqual({ split: 1 })
    expect(validateSubdiv({ split: 16 })).toEqual({ split: 16 })
    expect(validateSubdiv(WORKED)).toEqual(WORKED)
    expect(slotCount(validateSubdiv(MAXIMAL))).toBe(MAX_SLOTS)
  })

  it('rebuilds the tree, dropping properties the type does not carry', () => {
    const dirty = { split: 2, children: [null, { split: 3, label: 'x' }], zoom: 4 }
    expect(validateSubdiv(dirty)).toEqual({ split: 2, children: [null, { split: 3 }] })
  })

  it('rejects a non-object', () => {
    expect(() => validateSubdiv(null)).toThrow(/expected an object/)
    expect(() => validateSubdiv(4)).toThrow(/expected an object/)
    expect(() => validateSubdiv('{"split":2}')).toThrow(/expected an object/)
  })

  it('rejects a split outside 1..16', () => {
    expect(() => validateSubdiv({})).toThrow(/split must be an integer in 1\.\.16/)
    expect(() => validateSubdiv({ split: 0 })).toThrow(/split must be an integer in 1\.\.16/)
    expect(() => validateSubdiv({ split: -4 })).toThrow(/split must be an integer in 1\.\.16/)
    expect(() => validateSubdiv({ split: 17 })).toThrow(/split must be an integer in 1\.\.16/)
    expect(() => validateSubdiv({ split: 2.5 })).toThrow(/split must be an integer in 1\.\.16/)
    expect(() => validateSubdiv({ split: NaN })).toThrow(/split must be an integer in 1\.\.16/)
    expect(() => validateSubdiv({ split: '4' })).toThrow(/split must be an integer in 1\.\.16/)
  })

  it('rejects children that is not an array', () => {
    expect(() => validateSubdiv({ split: 2, children: {} })).toThrow(/children must be an array/)
    expect(() => validateSubdiv({ split: 2, children: null })).toThrow(/children must be an array/)
  })

  it('rejects children.length !== split', () => {
    expect(() => validateSubdiv({ split: 4, children: [null, null] })).toThrow(
      /children\.length 2 !== split 4/,
    )
    expect(() => validateSubdiv({ split: 1, children: [null, null] })).toThrow(
      /children\.length 2 !== split 1/,
    )
    expect(() => validateSubdiv({ split: 2, children: [] })).toThrow(/children\.length 0 !== split 2/)
  })

  it('rejects a child that is neither a node nor null', () => {
    expect(() => validateSubdiv({ split: 1, children: [3] })).toThrow(/child 0 must be/)
    expect(() => validateSubdiv({ split: 2, children: [null, 'x'] })).toThrow(/child 1 must be/)
    expect(() => validateSubdiv({ split: 1, children: [undefined] })).toThrow(/child 0 must be/)
  })

  it('rejects a child split outside 1..16', () => {
    expect(() => validateSubdiv({ split: 1, children: [{ split: 0 }] })).toThrow(
      /child 0 split must be an integer in 1\.\.16/,
    )
    expect(() => validateSubdiv({ split: 2, children: [null, { split: 17 }] })).toThrow(
      /child 1 split must be an integer in 1\.\.16/,
    )
    expect(() => validateSubdiv({ split: 1, children: [{ split: 1.5 }] })).toThrow(
      /child 0 split must be an integer in 1\.\.16/,
    )
    expect(() => validateSubdiv({ split: 1, children: [{}] })).toThrow(
      /child 0 split must be an integer in 1\.\.16/,
    )
  })

  it('rejects a third level of nesting — the depth-2 type cannot, imported JSON can', () => {
    const deep = { split: 1, children: [{ split: 2, children: [null, { split: 3 }] }] }
    expect(() => validateSubdiv(deep)).toThrow(/child 0 must not carry children/)
    // Even an empty `children` is a violation of the depth-2 shape.
    expect(() => validateSubdiv({ split: 1, children: [{ split: 2, children: [] }] })).toThrow(
      /child 0 must not carry children/,
    )
  })

  it('rejects a total slot count over 256', () => {
    expect(() => validateSubdiv({ split: 1, children: [{ split: 1000 }] })).toThrow(
      /1000 slots exceeds the 256-slot maximum/,
    )
    expect(() =>
      validateSubdiv({ split: 2, children: [{ split: 200 }, { split: 200 }] }),
    ).toThrow(/400 slots exceeds the 256-slot maximum/)
  })
})
