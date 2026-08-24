import { describe, expect, it } from 'vitest'
import type { Note } from './types'
import { frac } from './frac'
import { pos } from './pos'
import { NoteIndex, cellKey } from './noteIndex'

/**
 * Terse note constructor. Durations and fracs are given as rational pairs so no
 * test ever puts a float into a stored value.
 */
function mk(
  id: string,
  layerId: string,
  col: number,
  pitch: number,
  dur: readonly [number, number] = [1, 1],
  off: readonly [number, number] = [0, 1],
): Note {
  return {
    id,
    layerId,
    pos: pos(col, off[0], off[1]),
    dur: frac(dur[0], dur[1]),
    pitch,
  }
}

const ids = (notes: readonly Note[]): string[] => notes.map((n) => n.id)

describe('build', () => {
  it('sorts an unsorted input array by pos, per layer', () => {
    const ix = NoteIndex.build([
      mk('c', 'L1', 9, 60),
      mk('a', 'L1', 2, 60),
      mk('d', 'L2', 4, 60),
      mk('b', 'L1', 2, 62, [1, 1], [1, 2]),
    ])
    expect(ids(ix.notesByLayer.get('L1')!)).toEqual(['a', 'b', 'c'])
    expect(ids(ix.notesByLayer.get('L2')!)).toEqual(['d'])
    expect(ix.byId.size).toBe(4)
  })

  it('sorts each cell bucket by frac regardless of input order', () => {
    const ix = NoteIndex.build([
      mk('late', 'L1', 3, 60, [1, 4], [3, 4]),
      mk('early', 'L1', 3, 60, [1, 4], [0, 1]),
      mk('mid', 'L1', 3, 60, [1, 4], [1, 3]),
    ])
    expect(ix.notesByCell.get(cellKey('L1', 3, 60))).toEqual(['early', 'mid', 'late'])
  })

  it('computes maxDurQuarters per layer', () => {
    const ix = NoteIndex.build([
      mk('a', 'L1', 0, 60, [1, 2]),
      mk('b', 'L1', 1, 60, [7, 2]),
      mk('c', 'L2', 0, 60, [1, 1]),
    ])
    expect(ix.maxDurQuarters.get('L1')).toBe(3.5)
    expect(ix.maxDurQuarters.get('L2')).toBe(1)
  })

  it('builds an empty index from an empty array', () => {
    const ix = NoteIndex.build([])
    expect(ix.byId.size).toBe(0)
    expect(ix.queryRange('L1', 0, 16)).toEqual([])
    expect(ix.hitCandidates('L1', 0, 60)).toEqual([])
  })
})

describe('long notes (§4.1 regression — the B1 blocker)', () => {
  // A note at col 5 with dur 4 draws across cols 5-8 but is indexed at col 5 only.
  const long = mk('long', 'L1', 5, 60, [4, 1])

  it('queryRange finds a note whose onset is left of the range', () => {
    const ix = NoteIndex.build([long])
    expect(ids(ix.queryRange('L1', 7, 9))).toEqual(['long'])
  })

  it('hitCandidates finds it under the far end of its lozenge', () => {
    const ix = NoteIndex.build([long])
    expect(ids(ix.hitCandidates('L1', 8, 60))).toEqual(['long'])
  })

  it('covers every column it spans and none beyond', () => {
    const ix = NoteIndex.build([long])
    for (const col of [5, 6, 7, 8]) {
      expect(ids(ix.hitCandidates('L1', col, 60))).toEqual(['long'])
    }
    expect(ix.hitCandidates('L1', 4, 60)).toEqual([])
    expect(ix.hitCandidates('L1', 9, 60)).toEqual([])
  })

  it('widens the scan by the longest duration on the layer, not the queried note', () => {
    // 'short' alone would need no widening; 'long' forces it for the whole layer.
    const ix = NoteIndex.build([long, mk('short', 'L1', 20, 60, [1, 4])])
    expect(ids(ix.queryRange('L1', 8, 9))).toEqual(['long'])
  })

  it('finds a long note with a fractional onset and duration', () => {
    const ix = NoteIndex.build([mk('trip', 'L1', 2, 60, [7, 3], [1, 3])])
    expect(ids(ix.queryRange('L1', 4, 5))).toEqual(['trip'])
    expect(ix.queryRange('L1', 5, 6)).toEqual([])
  })
})

describe('queryRange boundaries', () => {
  it('includes a note whose onset is exactly startCol and excludes one at endCol', () => {
    const ix = NoteIndex.build([
      mk('at-start', 'L1', 4, 60),
      mk('inside', 'L1', 5, 60),
      mk('at-end', 'L1', 8, 60),
    ])
    expect(ids(ix.queryRange('L1', 4, 8))).toEqual(['at-start', 'inside'])
  })

  it('excludes a note that ends exactly on startCol', () => {
    // [2, 4) touches col 4 nowhere: the range is half-open on both sides.
    const ix = NoteIndex.build([mk('abuts', 'L1', 2, 60, [2, 1])])
    expect(ix.queryRange('L1', 4, 8)).toEqual([])
    expect(ids(ix.queryRange('L1', 3, 8))).toEqual(['abuts'])
  })

  it('includes a note that starts just inside endCol', () => {
    const ix = NoteIndex.build([mk('sliver', 'L1', 7, 60, [1, 4], [3, 4])])
    expect(ids(ix.queryRange('L1', 0, 8))).toEqual(['sliver'])
    expect(ix.queryRange('L1', 8, 16)).toEqual([])
  })

  it('returns an empty array for an empty or inverted range', () => {
    const ix = NoteIndex.build([mk('a', 'L1', 4, 60)])
    expect(ix.queryRange('L1', 4, 4)).toEqual([])
    expect(ix.queryRange('L1', 6, 2)).toEqual([])
  })

  it('returns results sorted by pos', () => {
    const ix = new NoteIndex()
    ix.insert(mk('c', 'L1', 3, 60))
    ix.insert(mk('a', 'L1', 1, 60))
    ix.insert(mk('b', 'L1', 2, 60))
    expect(ids(ix.queryRange('L1', 0, 8))).toEqual(['a', 'b', 'c'])
  })

  it('ignores other layers', () => {
    const ix = NoteIndex.build([mk('a', 'L1', 4, 60), mk('b', 'L2', 4, 60)])
    expect(ids(ix.queryRange('L2', 0, 8))).toEqual(['b'])
    expect(ix.queryRange('L3', 0, 8)).toEqual([])
  })
})

describe('negative columns', () => {
  it('queries a range entirely left of the origin', () => {
    const ix = NoteIndex.build([
      mk('a', 'L1', -6, 60),
      mk('b', 'L1', -3, 60),
      mk('c', 'L1', 1, 60),
    ])
    expect(ids(ix.queryRange('L1', -4, -2))).toEqual(['b'])
  })

  it('spans the origin with a long note starting at a negative column', () => {
    const ix = NoteIndex.build([mk('long', 'L1', -5, 60, [7, 1])])
    expect(ids(ix.queryRange('L1', 0, 2))).toEqual(['long'])
    expect(ids(ix.hitCandidates('L1', 1, 60))).toEqual(['long'])
    expect(ix.hitCandidates('L1', 2, 60)).toEqual([])
  })

  it('keeps negative-column cell keys distinct', () => {
    const ix = NoteIndex.build([mk('n', 'L1', -3, 60), mk('p', 'L1', 3, 60)])
    expect(ix.notesByCell.get(cellKey('L1', -3, 60))).toEqual(['n'])
    expect(ix.notesByCell.get(cellKey('L1', 3, 60))).toEqual(['p'])
  })
})

describe('cell buckets', () => {
  it('keeps several notes in one cell sorted by frac as they arrive out of order', () => {
    const ix = new NoteIndex()
    ix.insert(mk('half', 'L1', 2, 60, [1, 4], [1, 2]))
    ix.insert(mk('zero', 'L1', 2, 60, [1, 4], [0, 1]))
    ix.insert(mk('third', 'L1', 2, 60, [1, 4], [1, 3]))
    ix.insert(mk('fifth', 'L1', 2, 60, [1, 4], [1, 5]))
    expect(ix.notesByCell.get(cellKey('L1', 2, 60))).toEqual(['zero', 'fifth', 'third', 'half'])
  })

  it('drops the bucket key once its last note is removed', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 2, 60))
    ix.remove('a')
    const bucket = ix.notesByCell.get(cellKey('L1', 2, 60))
    expect(bucket === undefined || bucket.length === 0).toBe(true)
  })
})

describe('update', () => {
  it('leaves no stale entry at the old cell key when a note moves columns', () => {
    const ix = new NoteIndex()
    ix.insert(mk('m', 'L1', 2, 60))
    ix.update('m', mk('m', 'L1', 9, 60))

    const oldKey = cellKey('L1', 2, 60)
    const oldBucket = ix.notesByCell.get(oldKey)
    expect(oldBucket === undefined || oldBucket.length === 0).toBe(true)
    expect(ix.findExact('L1', 60, pos(2))).toBeUndefined()
    expect(ix.hitCandidates('L1', 2, 60)).toEqual([])
    expect(ix.queryRange('L1', 0, 4)).toEqual([])

    expect(ix.notesByCell.get(cellKey('L1', 9, 60))).toEqual(['m'])
    expect(ix.findExact('L1', 60, pos(9))?.id).toBe('m')
    expect(ids(ix.queryRange('L1', 8, 12))).toEqual(['m'])
    expect(ids(ix.notesByLayer.get('L1')!)).toEqual(['m'])
  })

  it('leaves no stale entry when a note changes pitch', () => {
    const ix = new NoteIndex()
    ix.insert(mk('m', 'L1', 2, 60))
    ix.update('m', mk('m', 'L1', 2, 67))
    expect(ix.notesByCell.get(cellKey('L1', 2, 60))).toBeUndefined()
    expect(ix.hitCandidates('L1', 2, 60)).toEqual([])
    expect(ids(ix.hitCandidates('L1', 2, 67))).toEqual(['m'])
  })

  it('leaves no stale entry when a note changes layer', () => {
    const ix = new NoteIndex()
    ix.insert(mk('m', 'L1', 2, 60))
    ix.update('m', mk('m', 'L2', 2, 60))
    expect(ix.notesByLayer.get('L1')).toEqual([])
    expect(ix.queryRange('L1', 0, 4)).toEqual([])
    expect(ids(ix.queryRange('L2', 0, 4))).toEqual(['m'])
    expect(ix.notesByCell.get(cellKey('L1', 2, 60))).toBeUndefined()
  })

  it('keeps notesByLayer sorted after a move', () => {
    const ix = NoteIndex.build([
      mk('a', 'L1', 1, 60),
      mk('b', 'L1', 2, 60),
      mk('c', 'L1', 3, 60),
    ])
    ix.update('a', mk('a', 'L1', 9, 60))
    expect(ids(ix.notesByLayer.get('L1')!)).toEqual(['b', 'c', 'a'])
  })

  it('replaces rather than mutates: byId holds the new object', () => {
    const ix = new NoteIndex()
    const before = mk('m', 'L1', 2, 60)
    ix.insert(before)
    const after = mk('m', 'L1', 2, 60, [2, 1])
    ix.update('m', after)
    expect(ix.byId.get('m')).toBe(after)
    expect(before.dur).toEqual(frac(1))
  })

  it('rejects an unknown id or an id that disagrees with the replacement', () => {
    const ix = new NoteIndex()
    ix.insert(mk('m', 'L1', 2, 60))
    expect(() => ix.update('nope', mk('nope', 'L1', 2, 60))).toThrow()
    expect(() => ix.update('m', mk('other', 'L1', 2, 60))).toThrow()
  })
})

describe('maxDurQuarters', () => {
  it('rises on insert', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 0, 60, [1, 2]))
    expect(ix.maxDurQuarters.get('L1')).toBe(0.5)
    ix.insert(mk('b', 'L1', 1, 60, [4, 1]))
    expect(ix.maxDurQuarters.get('L1')).toBe(4)
  })

  it('rises on a lengthening update', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 0, 60, [1, 1]))
    ix.update('a', mk('a', 'L1', 0, 60, [6, 1]))
    expect(ix.maxDurQuarters.get('L1')).toBe(6)
    expect(ids(ix.queryRange('L1', 5, 6))).toEqual(['a'])
  })

  it('may go stale-high after a shrink or a remove, and recomputeMaxDur fixes it', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 0, 60, [8, 1]))
    ix.insert(mk('b', 'L1', 0, 62, [1, 1]))
    ix.update('a', mk('a', 'L1', 0, 60, [1, 2]))
    expect(ix.maxDurQuarters.get('L1')).toBe(8) // stale-high: safe, only widens the scan
    expect(ix.recomputeMaxDur('L1')).toBe(1)
    expect(ix.maxDurQuarters.get('L1')).toBe(1)

    ix.remove('b')
    expect(ix.maxDurQuarters.get('L1')).toBe(1) // stale-high again
    expect(ix.recomputeMaxDur('L1')).toBe(0.5)
  })

  it('recomputeMaxDur returns 0 for an empty or unknown layer', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 0, 60, [4, 1]))
    ix.remove('a')
    expect(ix.recomputeMaxDur('L1')).toBe(0)
    expect(ix.recomputeMaxDur('L9')).toBe(0)
  })

  it('never goes stale-low across a sequence of insert/update/remove', () => {
    const ix = new NoteIndex()
    const live = new Map<string, Note>()
    const trueMax = (): number => {
      let m = 0
      for (const n of live.values()) if (n.layerId === 'L1') m = Math.max(m, n.dur.n / n.dur.d)
      return m
    }
    const check = (): void => {
      expect(ix.maxDurQuarters.get('L1') ?? 0).toBeGreaterThanOrEqual(trueMax())
    }

    const steps: (() => void)[] = [
      () => { const n = mk('a', 'L1', 0, 60, [1, 3]); ix.insert(n); live.set('a', n) },
      () => { const n = mk('b', 'L1', 4, 62, [9, 2]); ix.insert(n); live.set('b', n) },
      () => { const n = mk('c', 'L1', 8, 64, [2, 1]); ix.insert(n); live.set('c', n) },
      () => { const n = mk('a', 'L1', 0, 60, [11, 1]); ix.update('a', n); live.set('a', n) },
      () => { const n = mk('a', 'L1', 0, 60, [1, 4]); ix.update('a', n); live.set('a', n) },
      () => { ix.remove('b'); live.delete('b') },
      () => { const n = mk('d', 'L1', 12, 60, [16, 3]); ix.insert(n); live.set('d', n) },
      () => { const n = mk('c', 'L1', 8, 64, [1, 1]); ix.update('c', n); live.set('c', n) },
      () => { ix.recomputeMaxDur('L1') },
      () => { const n = mk('d', 'L1', 12, 60, [1, 8]); ix.update('d', n); live.set('d', n) },
      () => { ix.remove('a'); live.delete('a') },
      () => { ix.recomputeMaxDur('L1') },
    ]
    for (const step of steps) {
      step()
      check()
      // The widened scan must still find every live note under its own onset column.
      for (const n of live.values()) {
        expect(ids(ix.hitCandidates(n.layerId, n.pos.col, n.pitch))).toContain(n.id)
      }
    }
  })
})

describe('hitCandidates', () => {
  it('orders same-cell ties shortest-first, then most-recently-added (§7.3)', () => {
    const ix = new NoteIndex()
    ix.insert(mk('long', 'L1', 2, 60, [4, 1]))
    ix.insert(mk('short', 'L1', 2, 60, [1, 4], [1, 2]))
    expect(ids(ix.hitCandidates('L1', 2, 60))).toEqual(['short', 'long'])
  })

  it('breaks equal-duration ties by most-recently-added', () => {
    const ix = new NoteIndex()
    ix.insert(mk('first', 'L1', 2, 60, [1, 1]))
    ix.insert(mk('second', 'L1', 2, 60, [1, 1], [1, 2]))
    ix.insert(mk('third', 'L1', 2, 60, [1, 1], [1, 4]))
    expect(ids(ix.hitCandidates('L1', 2, 60))).toEqual(['third', 'second', 'first'])
  })

  it('filters by pitch and layer', () => {
    const ix = NoteIndex.build([
      mk('hit', 'L1', 2, 60, [4, 1]),
      mk('wrong-pitch', 'L1', 2, 61, [4, 1]),
      mk('wrong-layer', 'L2', 2, 60, [4, 1]),
    ])
    expect(ids(ix.hitCandidates('L1', 3, 60))).toEqual(['hit'])
  })

  it('finds a zero-duration note at its onset column', () => {
    const ix = NoteIndex.build([mk('z', 'L1', 3, 60, [0, 1])])
    expect(ids(ix.hitCandidates('L1', 3, 60))).toEqual(['z'])
    expect(ids(ix.queryRange('L1', 3, 4))).toEqual(['z'])
    expect(ix.hitCandidates('L1', 4, 60)).toEqual([])
  })
})

describe('findExact', () => {
  it('matches on layer, pitch and exact rational pos', () => {
    const ix = NoteIndex.build([
      mk('a', 'L1', 3, 60, [1, 4], [1, 3]),
      mk('b', 'L1', 3, 60, [1, 4], [2, 3]),
    ])
    expect(ix.findExact('L1', 60, pos(3, 1, 3))?.id).toBe('a')
    expect(ix.findExact('L1', 60, pos(3, 2, 3))?.id).toBe('b')
  })

  it('returns undefined for a near miss', () => {
    const ix = NoteIndex.build([mk('a', 'L1', 3, 60, [1, 4], [1, 3])])
    expect(ix.findExact('L1', 60, pos(3, 1, 4))).toBeUndefined()
    expect(ix.findExact('L1', 61, pos(3, 1, 3))).toBeUndefined()
    expect(ix.findExact('L2', 60, pos(3, 1, 3))).toBeUndefined()
    expect(ix.findExact('L1', 60, pos(4, 1, 3))).toBeUndefined()
  })

  it('normalizes the queried frac, so 2/6 finds a note stored at 1/3', () => {
    const ix = NoteIndex.build([mk('a', 'L1', 3, 60, [1, 4], [1, 3])])
    expect(ix.findExact('L1', 60, pos(3, 2, 6))?.id).toBe('a')
  })

  it('does not see a removed note', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 3, 60))
    ix.remove('a')
    expect(ix.findExact('L1', 60, pos(3))).toBeUndefined()
  })
})

describe('insert and remove bookkeeping', () => {
  it('rejects a duplicate id', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 0, 60))
    expect(() => ix.insert(mk('a', 'L1', 4, 62))).toThrow()
  })

  it('returns the removed note, and undefined for an unknown id', () => {
    const ix = new NoteIndex()
    const a = mk('a', 'L1', 0, 60)
    ix.insert(a)
    expect(ix.remove('a')).toBe(a)
    expect(ix.remove('a')).toBeUndefined()
    expect(ix.byId.size).toBe(0)
    expect(ix.notesByLayer.get('L1')).toEqual([])
  })

  it('removes only the targeted note from a shared bucket', () => {
    const ix = new NoteIndex()
    ix.insert(mk('a', 'L1', 2, 60, [1, 4], [0, 1]))
    ix.insert(mk('b', 'L1', 2, 60, [1, 4], [1, 2]))
    ix.remove('a')
    expect(ix.notesByCell.get(cellKey('L1', 2, 60))).toEqual(['b'])
    expect(ids(ix.notesByLayer.get('L1')!)).toEqual(['b'])
  })
})
