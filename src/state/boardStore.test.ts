import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { DEFAULT_METER, barLinesIn, barNumberAt } from '../core/meter'
import type { Meter } from '../core/meter'
import { createEmptyProject } from '../io/project'
import { BoardStore } from './boardStore'

/**
 * Meter edits through the store (§3.7, §7.3).
 *
 * Two things are load-bearing and are what most of this file is about. Every edit is
 * a command, or `BoardView`'s commit-keyed meter cache would render a stale map. And
 * the meter at index 0 anchors the whole map at or before the origin — every function
 * in `meter.ts`'s bar arithmetic asserts that and throws a `RangeError` when it is
 * violated, so an index-0 move or removal is not a cosmetic mistake, it is a crash on
 * the next frame.
 */

const store = () => new BoardStore(createEmptyProject(), { width: 800, height: 600 })

const sevenEight = (col: number): Meter => ({
  pos: pos(col),
  beatUnit: frac(1, 2),
  groups: [2, 2, 3],
})

describe('BoardStore.setMeter', () => {
  it('adds a meter change and keeps the map sorted and anchored', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    expect(b.getMeterMap()).toEqual([DEFAULT_METER, sevenEight(8)])
    expect(b.getProject().meterMap).toBe(b.getMeterMap())
  })

  it('replaces the meter already at that position rather than duplicating it', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    b.setMeter({ pos: pos(8), beatUnit: frac(1), groups: [1, 1, 1] })
    expect(b.getMeterMap()).toHaveLength(2)
    expect(b.getMeterMap()[1]!.groups).toEqual([1, 1, 1])
  })

  it('can restate the anchor meter itself, since that leaves it at the origin', () => {
    const b = store()
    b.setMeter({ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] })
    expect(b.getMeterMap()).toHaveLength(1)
    expect(barNumberAt(b.getMeterMap(), pos(3))).toEqual({ bar: 2, beat: 1 })
  })

  it('is one undoable command', () => {
    const b = store()
    const before = b.getMeterMap()
    b.setMeter(sevenEight(8))
    expect(b.commitVersion).toBe(1)
    b.undo()
    expect(b.getMeterMap()).toEqual(before)
    b.redo()
    expect(b.getMeterMap()).toHaveLength(2)
  })

  it('bumps commitVersion, which is what stops the board drawing a stale map', () => {
    const b = store()
    const v = b.commitVersion
    b.setMeter(sevenEight(8))
    expect(b.commitVersion).toBeGreaterThan(v)
  })

  it('rejects a triplet beat unit instead of storing an unwritable time signature', () => {
    const b = store()
    expect(() => b.setMeter({ pos: pos(4), beatUnit: frac(1, 3), groups: [4] }))
      .toThrow(/beatUnit/)
    expect(b.getMeterMap()).toHaveLength(1)
    expect(b.commitVersion).toBe(0)
  })

  it('rejects an empty or non-positive grouping', () => {
    const b = store()
    expect(() => b.setMeter({ pos: pos(4), beatUnit: frac(1), groups: [] })).toThrow(/groups/)
    expect(() => b.setMeter({ pos: pos(4), beatUnit: frac(1), groups: [0] })).toThrow(/groups/)
    expect(b.getMeterMap()).toHaveLength(1)
  })

  /*
   * The lattice rule lives in `validateMeter`, not here, so the file reader has it too
   * (`readMeterMap`). This test is the UI half of that one guard: 4 / (1/512) = 2048
   * is a power of two, so the SMF rule passes it, and 512 does not divide the lattice.
   */
  it('inherits validateMeter\'s §3.1 lattice rule, which the power-of-two rule does not imply', () => {
    const b = store()
    expect(() => b.setMeter({ pos: pos(4), beatUnit: frac(1, 512), groups: [4] }))
      .toThrow(/meter\.beatUnit.*lattice/)
    expect(b.getMeterMap()).toHaveLength(1)
    expect(b.commitVersion).toBe(0)
  })
})

describe('BoardStore.moveMeter', () => {
  it('moves a later meter and keeps the map sorted', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    b.moveMeter(1, pos(4))
    expect(b.getMeterMap().map((m) => m.pos)).toEqual([pos(0), pos(4)])
    expect(barLinesIn(b.getMeterMap(), pos(0), pos(8))).toEqual([
      pos(0), pos(4), pos(7, 1, 2),
    ])
  })

  it('is one undoable command for the whole drag', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    const commits = b.commitVersion
    b.moveMeter(1, pos(4))
    expect(b.commitVersion).toBe(commits + 1)
    b.undo()
    expect(b.getMeterMap()[1]!.pos).toEqual(pos(8))
  })

  it('REFUSES to move index 0, which would break the anchoring invariant', () => {
    const b = store()
    const before = b.getMeterMap()
    b.moveMeter(0, pos(4))
    expect(b.getMeterMap()).toBe(before)
    expect(b.commitVersion).toBe(0)
    // The proof that the refusal matters: the map that move would have produced is
    // exactly the one every bar-arithmetic entry point throws on.
    expect(() => barLinesIn([{ ...DEFAULT_METER, pos: pos(4) }], pos(0), pos(16)))
      .toThrow(RangeError)
    expect(() => barNumberAt([{ ...DEFAULT_METER, pos: pos(4) }], pos(8)))
      .toThrow(/anchored/)
  })

  it('refuses a move onto or before the origin, which would displace the anchor', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    const before = b.getMeterMap()
    b.moveMeter(1, pos(0))
    expect(b.getMeterMap()).toBe(before)
    b.moveMeter(1, pos(-4))
    expect(b.getMeterMap()).toBe(before)
  })

  it('refuses a move onto another meter, which would silently swallow it', () => {
    const b = store()
    b.setMeter(sevenEight(4))
    b.setMeter(sevenEight(8))
    const before = b.getMeterMap()
    b.moveMeter(2, pos(4))
    expect(b.getMeterMap()).toBe(before)
    expect(b.getMeterMap()).toHaveLength(3)
  })

  it('ignores an out-of-range index and a move to where it already is', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    const before = b.getMeterMap()
    b.moveMeter(9, pos(4))
    b.moveMeter(-1, pos(4))
    b.moveMeter(1, pos(8))
    expect(b.getMeterMap()).toBe(before)
  })
})

describe('BoardStore.removeMeter', () => {
  it('removes a later meter as one undoable command', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    b.removeMeter(1)
    expect(b.getMeterMap()).toEqual([DEFAULT_METER])
    b.undo()
    expect(b.getMeterMap()).toEqual([DEFAULT_METER, sevenEight(8)])
  })

  it('REFUSES to remove index 0, which would leave the map unanchored or empty', () => {
    const b = store()
    const before = b.getMeterMap()
    b.removeMeter(0)
    expect(b.getMeterMap()).toBe(before)
    expect(b.commitVersion).toBe(0)
    expect(() => barLinesIn([], pos(0), pos(4))).toThrow(/empty/)
  })

  it('still refuses index 0 when a later meter exists to fall back on', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    const before = b.getMeterMap()
    b.removeMeter(0)
    expect(b.getMeterMap()).toBe(before)
  })

  it('ignores an out-of-range index', () => {
    const b = store()
    const before = b.getMeterMap()
    b.removeMeter(3)
    b.removeMeter(-2)
    expect(b.getMeterMap()).toBe(before)
  })
})

describe('the built map the UI indexes into', () => {
  /*
   * `moveMeter(i)` and `removeMeter(i)` take the index of a marker the user grabbed,
   * which came from `getMeterMap()`. If the store indexed into `project.meterMap`
   * instead, a map that `buildMeterMap` had to prepend a default to would shift every
   * index by one and the wrong meter would move.
   */
  it('is the same list the project holds after any meter edit', () => {
    const b = store()
    b.setMeter(sevenEight(8))
    expect(b.getProject().meterMap).toBe(b.getMeterMap())
    b.moveMeter(1, pos(4))
    expect(b.getProject().meterMap).toBe(b.getMeterMap())
    b.removeMeter(1)
    expect(b.getProject().meterMap).toBe(b.getMeterMap())
  })

  it('is anchored even when the project it was built from was not', () => {
    const raw = { ...createEmptyProject(), meterMap: [sevenEight(4)] }
    const b = new BoardStore(raw, { width: 800, height: 600 })
    expect(b.getMeterMap()).toEqual([DEFAULT_METER, sevenEight(4)])
    // Index 1 is the 7/8 the user can see, not the implicit default at index 0.
    b.removeMeter(1)
    expect(b.getMeterMap()).toEqual([DEFAULT_METER])
  })
})
