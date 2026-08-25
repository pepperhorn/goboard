import { describe, expect, it } from 'vitest'
import { serializeProject } from '../io/project'
import { NoteIndex } from '../core/noteIndex'
import { countInWindow, createBenchProject } from './fixture'

describe('createBenchProject (§5.3)', () => {
  it('fills any screen-sized window in the head with ~5k notes', () => {
    const p = createBenchProject()
    const rows = { from: 12, to: 95 }

    // 53 columns is a 1280 px board at the 24 px/quarter minimum. The count has to
    // hold anywhere in the head, not just at column 0 — the pan sweep moves.
    for (const from of [0, 40, 100, 140]) {
      const n = countInWindow(p, { from, to: from + 52 }, rows)
      expect(n, `window at col ${from}`).toBeGreaterThan(4500)
      expect(n, `window at col ${from}`).toBeLessThan(5600)
    }
  })

  it('holds the requested total and spreads the tail past the head', () => {
    const p = createBenchProject({ total: 20_000, perCol: 10, denseCols: 50, tailCols: 400 })
    expect(p.notes).toHaveLength(20_000)

    const tailCols = new Set(p.notes.slice(500).map((n) => n.pos.col))
    expect(Math.min(...tailCols)).toBeGreaterThanOrEqual(50)
    expect(tailCols.size).toBeGreaterThan(300)
  })

  it('covers every row in its pitch band', () => {
    const p = createBenchProject({ total: 4_000, perCol: 20, denseCols: 20, pitchLo: 12, pitchSpan: 84 })
    const pitches = new Set(p.notes.map((n) => n.pitch))
    // A stride sharing a factor with the span would visit a twelfth of these.
    expect(pitches.size).toBe(84)
    expect(Math.min(...pitches)).toBe(12)
    expect(Math.max(...pitches)).toBe(95)
  })

  it('builds a project the real loader and index accept', () => {
    const p = createBenchProject({ total: 300, perCol: 10, denseCols: 10 })
    expect(() => serializeProject(p)).not.toThrow()
    expect(() => NoteIndex.build(p.notes)).not.toThrow()
  })

  it('uses several denominators and subdivided columns', () => {
    const p = createBenchProject({ total: 400, perCol: 20, denseCols: 10 })
    expect(new Set(p.notes.map((n) => n.pos.frac.d)).size).toBeGreaterThan(3)
    expect([...p.layers[0]!.subdivs.values()].length).toBeGreaterThan(0)
  })

  it('rejects a fixture with no head to draw', () => {
    expect(() => createBenchProject({ total: 0 })).toThrow(RangeError)
    expect(() => createBenchProject({ perCol: 0 })).toThrow(RangeError)
  })
})
