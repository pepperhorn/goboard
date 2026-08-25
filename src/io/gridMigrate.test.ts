import { describe, expect, it } from 'vitest'
import type { Subdiv, SubdivL2 } from '../core/types'
import { frac, gcd } from '../core/frac'
import { pos } from '../core/pos'
import { MAX_SPLIT, enumerateSlots } from '../core/subdiv'
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

// --- Property test: random v1 corpus -----------------------------------------------
//
// §7 ("Testing") of the design spec requires a property test that the v1 -> v2
// converter preserves enumerated slot starts exactly across a random corpus of v1
// projects. The suite above is five hand-picked shapes; this section generates many
// more via a seeded PRNG (never `Math.random()`, so a failure is reproducible and CI
// never flakes) and checks the same losslessness property on every one.

/** mulberry32: a small, fast, seedable PRNG — good enough for test-corpus generation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer in `[lo, hi]`, inclusive, drawn from a `[0, 1)` PRNG sample. */
function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1))
}

/** A fully random depth-2 `Subdiv`: any split, any mix of null/depth-2 children. */
function randomSubdiv(rand: () => number): Subdiv {
  const split = randInt(rand, 1, MAX_SPLIT)
  if (rand() < 0.5) return { split }
  const children: (SubdivL2 | null)[] = []
  for (let i = 0; i < split; i++) {
    children.push(rand() < 0.5 ? null : { split: randInt(rand, 1, MAX_SPLIT) })
  }
  return { split, children }
}

/**
 * A `Subdiv` nesting a child at BOTH the first index (0) and the last index
 * (split - 1) of the same column — risky shape #1 from the review finding, since a
 * naive run-detection could merge or mis-anchor the two end runs.
 */
function randomBothEndsSubdiv(rand: () => number): Subdiv {
  const split = randInt(rand, 2, MAX_SPLIT)
  const children: (SubdivL2 | null)[] = new Array(split).fill(null)
  children[0] = { split: randInt(rand, 2, MAX_SPLIT) }
  children[split - 1] = { split: randInt(rand, 2, MAX_SPLIT) }
  return { split, children }
}

/**
 * A `Subdiv` with exactly one nested child whose split is coprime with the outer
 * split — exercises denominators that do not share factors (e.g. outer 4, inner 3).
 */
function randomCoprimeNestedSubdiv(rand: () => number): Subdiv {
  const split = randInt(rand, 2, MAX_SPLIT)
  let inner = randInt(rand, 2, MAX_SPLIT)
  while (gcd(split, inner) !== 1) inner = randInt(rand, 2, MAX_SPLIT) // always terminates: split+/-1 is always coprime and in range
  const idx = randInt(rand, 0, split - 1)
  const children: (SubdivL2 | null)[] = new Array(split).fill(null)
  children[idx] = { split: inner }
  return { split, children }
}

/** One column's `Subdiv`, weighted to hit the shapes named in the review finding. */
function randomColumnSubdiv(rand: () => number): Subdiv {
  const kind = rand()
  if (kind < 0.15) return { split: 1 } // an explicit no-op column
  if (kind < 0.35) return randomBothEndsSubdiv(rand)
  if (kind < 0.55) return randomCoprimeNestedSubdiv(rand)
  return randomSubdiv(rand)
}

/**
 * A random v1 corpus entry: 1-4 columns, sometimes contiguous (so adjacent-column
 * restore suppression — risky shape #2 — gets exercised, including a no-op second
 * column) and sometimes scattered, starting from a column that may be negative.
 */
function randomSubdivMap(rand: () => number): Map<number, Subdiv> {
  const map = new Map<number, Subdiv>()
  const contiguous = rand() < 0.6
  let col = randInt(rand, -10, 10)
  const count = randInt(rand, 1, 4)
  for (let i = 0; i < count; i++) {
    map.set(col, randomColumnSubdiv(rand))
    col += contiguous ? 1 : randInt(rand, 1, 3)
  }
  return map
}

describe('subdivsToRegions property test', () => {
  it('preserves enumerated slot starts across a seeded random corpus of v1 maps', () => {
    // Fixed seed: deterministic and reproducible, never an unseeded Math.random() flake.
    const rand = mulberry32(0xc0ffee)
    const TRIALS = 300
    for (let trial = 0; trial < TRIALS; trial++) {
      const subdivs = randomSubdivMap(rand)
      const regions = subdivsToRegions(subdivs)
      for (const [col, sd] of subdivs) {
        expect(
          v2Starts(regions, col),
          `trial ${trial}: col=${col} sd=${JSON.stringify(sd)} map=${JSON.stringify([...subdivs])}`,
        ).toEqual(v1Starts(col, sd))
      }
    }
  })

  it('covers the two risky shapes named in the review finding explicitly', () => {
    // Shape 1: a column nesting a child at BOTH index 0 and index split - 1.
    const bothEnds: Subdiv = { split: 5, children: [{ split: 3 }, null, null, null, { split: 7 }] }
    // Shape 2: adjacent columns where the second column's own entry is a no-op.
    const subdivs = new Map<number, Subdiv>([
      [0, bothEnds],
      [1, { split: 1 }],
    ])
    const regions = subdivsToRegions(subdivs)
    for (const [col, sd] of subdivs) {
      expect(v2Starts(regions, col), `col=${col} sd=${JSON.stringify(sd)}`).toEqual(v1Starts(col, sd))
    }
  })
})
