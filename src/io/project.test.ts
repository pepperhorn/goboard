import { describe, expect, it } from 'vitest'
import type { Layer, Note, Project, Subdiv } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import {
  PROJECT_FILE_EXT,
  createEmptyProject,
  deserializeProject,
  loadProject,
  projectFromString,
  projectToBlobString,
  serializeProject,
} from './project'

/** The §3.2 worked example: 16ths with triplet 32nds on the last 16th. */
const WORKED: Subdiv = { split: 4, children: [null, null, null, { split: 3 }] }

function mkLayer(over: Partial<Layer> & Pick<Layer, 'id'>): Layer {
  return {
    name: over.id,
    color: '#4f8cff',
    instrumentId: 'ph-piano-1',
    channel: 0,
    audible: true,
    visible: true,
    defaultVel: 96,
    colVel: new Map(),
    subdivs: new Map(),
    order: 0,
    ...over,
  }
}

/**
 * A project that exercises every feature the format has to carry: three layers, notes
 * at negative columns, an off-quarter onset, a nested subdivision, out-of-order map
 * entries, a velocity override and a loop region.
 */
const FIXTURE: Project = {
  version: 1,
  name: 'Fixture',
  tempoMap: [
    { pos: pos(0), bpm: 120 },
    { pos: pos(16, 1, 3), bpm: 90 },
  ],
  layers: [
    mkLayer({
      id: 'L1',
      // Deliberately inserted high-to-low: serialization must sort, not preserve.
      colVel: new Map([
        [4, 110],
        [-2, 40],
        [0, 96],
      ]),
      subdivs: new Map<number, Subdiv>([
        [3, { split: 5 }],
        [-1, WORKED],
      ]),
    }),
    mkLayer({ id: 'L2', color: '#27ae60', channel: 2, audible: false, order: 1 }),
    mkLayer({ id: 'L3', color: '#eb5757', channel: 9, visible: false, order: 2 }),
  ],
  notes: [
    { id: 'n1', layerId: 'L1', pos: pos(-4, 1, 12), dur: frac(1, 12), pitch: 48 },
    { id: 'n2', layerId: 'L1', pos: pos(5), dur: frac(4), pitch: 60, vel: 127 },
    { id: 'n3', layerId: 'L2', pos: pos(-1, 3, 4), dur: frac(1, 4), pitch: 36, vel: 0 },
  ],
  activeLayerId: 'L1',
  loop: { start: pos(-4), end: pos(8, 1, 2) },
}

/** A deep-cloned serialization of `FIXTURE` with one field broken. */
function corrupt(mutate: (raw: any) => void): unknown {
  const raw = JSON.parse(projectToBlobString(FIXTURE))
  mutate(raw)
  return raw
}

/** Every rejection must be a `RangeError` whose message names the offending path. */
function expectReject(raw: unknown, names: RegExp): void {
  expect(() => deserializeProject(raw)).toThrow(RangeError)
  expect(() => deserializeProject(raw)).toThrow(names)
}

describe('round trip', () => {
  it('restores a non-trivial project exactly, Maps included', () => {
    const back = deserializeProject(serializeProject(FIXTURE))
    expect(back).toEqual(FIXTURE)
    expect(back.layers[0]!.colVel).toBeInstanceOf(Map)
    expect(back.layers[0]!.colVel.get(-2)).toBe(40)
    expect(back.layers[0]!.subdivs.get(-1)).toEqual(WORKED)
    expect(back.notes[0]!.pos).toEqual(pos(-4, 1, 12))
    expect(back.loop).toEqual({ start: pos(-4), end: pos(8, 1, 2) })
  })

  it('re-serializes byte-for-byte after a round trip', () => {
    const once = projectToBlobString(FIXTURE)
    const twice = projectToBlobString(deserializeProject(JSON.parse(once)))
    expect(twice).toBe(once)
    expect(projectToBlobString(projectFromString(twice))).toBe(once)
  })

  it('sorts map entries by column, so insertion order cannot change the bytes', () => {
    const ascending: Project = {
      ...FIXTURE,
      layers: FIXTURE.layers.map((l, i) =>
        i === 0
          ? {
              ...l,
              colVel: new Map([
                [-2, 40],
                [0, 96],
                [4, 110],
              ]),
              subdivs: new Map<number, Subdiv>([
                [-1, WORKED],
                [3, { split: 5 }],
              ]),
            }
          : l,
      ),
    }
    expect(projectToBlobString(ascending)).toBe(projectToBlobString(FIXTURE))
    const raw = serializeProject(FIXTURE) as any
    expect(raw.layers[0].colVel).toEqual([
      [-2, 40],
      [0, 96],
      [4, 110],
    ])
    expect(raw.layers[0].subdivs.map((e: [number, unknown]) => e[0])).toEqual([-1, 3])
  })

  it('omits absent optionals rather than writing nulls', () => {
    const { loop: _loop, ...noLoop } = FIXTURE
    const raw = serializeProject(noLoop) as any
    expect('loop' in raw).toBe(false)
    expect('vel' in raw.notes[0]).toBe(false)
    expect(raw.notes[1].vel).toBe(127)
    expect(deserializeProject(raw).loop).toBeUndefined()
  })

  it('drops properties the schema does not define', () => {
    const raw = corrupt((r) => {
      r.nope = 1
      r.notes[0].nope = 1
      r.layers[0].nope = 1
    })
    expect(deserializeProject(raw)).toEqual(FIXTURE)
  })

  it('writes JSON that survives a string round trip through the file extension', () => {
    expect(PROJECT_FILE_EXT).toBe('.go.json')
    expect(projectFromString(projectToBlobString(FIXTURE))).toEqual(FIXTURE)
    expect(() => projectFromString('{ not json')).toThrow()
  })
})

describe('deserializeProject rejections', () => {
  it('rejects a non-object root', () => {
    expectReject(null, /Project: root/)
    expectReject([], /Project: root/)
    expectReject('{}', /Project: root/)
  })

  it('rejects any version but 1', () => {
    expectReject(
      corrupt((r) => (r.version = 2)),
      /version/,
    )
    expectReject(
      corrupt((r) => delete r.version),
      /version/,
    )
  })

  it('rejects a non-string name or activeLayerId', () => {
    expectReject(
      corrupt((r) => (r.name = 7)),
      /name/,
    )
    expectReject(
      corrupt((r) => (r.activeLayerId = null)),
      /activeLayerId/,
    )
  })

  it('rejects duplicate layer ids', () => {
    expectReject(
      corrupt((r) => (r.layers[1].id = 'L1')),
      /layers\[1\]\.id.*L1|duplicate/i,
    )
  })

  it('rejects an activeLayerId with no matching layer', () => {
    expectReject(
      corrupt((r) => (r.activeLayerId = 'ghost')),
      /activeLayerId/,
    )
  })

  it('rejects a note whose layerId matches no layer', () => {
    expectReject(
      corrupt((r) => (r.notes[2].layerId = 'ghost')),
      /notes\[2\]\.layerId/,
    )
  })

  it('rejects duplicate note ids', () => {
    expectReject(
      corrupt((r) => (r.notes[1].id = 'n1')),
      /notes\[1\]\.id/,
    )
  })

  it('rejects a pitch outside 0..127 or non-integer', () => {
    expectReject(
      corrupt((r) => (r.notes[0].pitch = 128)),
      /notes\[0\]\.pitch/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].pitch = -1)),
      /notes\[0\]\.pitch/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].pitch = 60.5)),
      /notes\[0\]\.pitch/,
    )
  })

  it('rejects a present-but-invalid vel, and accepts an absent one', () => {
    expectReject(
      corrupt((r) => (r.notes[1].vel = 128)),
      /notes\[1\]\.vel/,
    )
    expectReject(
      corrupt((r) => (r.notes[1].vel = 96.5)),
      /notes\[1\]\.vel/,
    )
    expectReject(
      corrupt((r) => (r.notes[1].vel = null)),
      /notes\[1\]\.vel/,
    )
    expect(deserializeProject(corrupt((r) => delete r.notes[1].vel)).notes[1]!.vel).toBeUndefined()
  })

  it('rejects a defaultVel outside 0..127', () => {
    expectReject(
      corrupt((r) => (r.layers[0].defaultVel = 200)),
      /layers\[0\]\.defaultVel/,
    )
  })

  it('rejects a channel outside 0..15', () => {
    expectReject(
      corrupt((r) => (r.layers[2].channel = 16)),
      /layers\[2\]\.channel/,
    )
    expectReject(
      corrupt((r) => (r.layers[2].channel = -1)),
      /layers\[2\]\.channel/,
    )
  })

  it('rejects a non-integer order', () => {
    expectReject(
      corrupt((r) => (r.layers[1].order = 1.5)),
      /layers\[1\]\.order/,
    )
  })

  it('rejects non-string or non-boolean layer fields', () => {
    expectReject(
      corrupt((r) => (r.layers[0].color = 0x4f8cff)),
      /layers\[0\]\.color/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].instrumentId = null)),
      /layers\[0\]\.instrumentId/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].audible = 1)),
      /layers\[0\]\.audible/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].visible = 'yes')),
      /layers\[0\]\.visible/,
    )
  })

  it('rejects an unnormalized Frac rather than reducing it', () => {
    expectReject(
      corrupt((r) => (r.notes[0].dur = { n: 2, d: 24 })),
      /notes\[0\]\.dur.*normalized/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].pos.frac = { n: -1, d: -12 })),
      /notes\[0\]\.pos\.frac.*normalized/,
    )
    expectReject(
      corrupt((r) => (r.notes[1].dur = { n: 0, d: 5 })),
      /notes\[1\]\.dur.*normalized/,
    )
  })

  it('rejects a Frac outside the denominator lattice or with a zero denominator', () => {
    expectReject(
      corrupt((r) => (r.notes[0].dur = { n: 1, d: 0 })),
      /notes\[0\]\.dur/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].dur = { n: 1, d: 519437318401 })),
      /notes\[0\]\.dur/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].dur = { n: 1.5, d: 2 })),
      /notes\[0\]\.dur\.n/,
    )
  })

  it('rejects a non-canonical pos instead of silently canonicalizing it', () => {
    // {col: 0, frac: 5/4} is the same instant as {col: 1, frac: 1/4}, and both would
    // key and sort differently — §3.1 says storage carries exactly one of them.
    const raw = corrupt((r) => (r.notes[0].pos = { col: 0, frac: { n: 5, d: 4 } }))
    expectReject(raw, /notes\[0\]\.pos.*canonical/)
    expectReject(
      corrupt((r) => (r.notes[0].pos = { col: 0, frac: { n: -1, d: 4 } })),
      /notes\[0\]\.pos.*canonical/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].pos.col = 1.5)),
      /notes\[0\]\.pos\.col/,
    )
    expectReject(
      corrupt((r) => (r.loop.end = { col: 0, frac: { n: 3, d: 2 } })),
      /loop\.end.*canonical/,
    )
  })

  it('rejects a non-positive duration', () => {
    expectReject(
      corrupt((r) => (r.notes[0].dur = { n: 0, d: 1 })),
      /notes\[0\]\.dur.*positive/,
    )
    expectReject(
      corrupt((r) => (r.notes[0].dur = { n: -1, d: 4 })),
      /notes\[0\]\.dur.*positive/,
    )
  })

  it('rejects a malformed subdivision through validateSubdiv', () => {
    expectReject(
      corrupt((r) => (r.layers[0].subdivs[1][1] = { split: 5, children: [null, null] })),
      /layers\[0\]\.subdivs\[3\]/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].subdivs[0][1] = { split: 17 })),
      /layers\[0\]\.subdivs\[-1\]/,
    )
    expectReject(
      corrupt(
        (r) =>
          (r.layers[0].subdivs[0][1] = {
            split: 1,
            children: [{ split: 2, children: [null, null] }],
          }),
      ),
      /layers\[0\]\.subdivs\[-1\]/,
    )
  })

  it('rejects malformed map entries and duplicate columns', () => {
    expectReject(
      corrupt((r) => (r.layers[0].colVel = { '0': 96 })),
      /layers\[0\]\.colVel/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].colVel[0] = [0])),
      /layers\[0\]\.colVel entry 0/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].colVel[0][1] = 200)),
      /layers\[0\]\.colVel\[-2\]/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].colVel[0][0] = 1.5)),
      /layers\[0\]\.colVel/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].colVel[1][0] = -2)),
      /layers\[0\]\.colVel.*-2/,
    )
    expectReject(
      corrupt((r) => (r.layers[0].subdivs[1][0] = -1)),
      /layers\[0\]\.subdivs.*-1/,
    )
  })

  it('rejects a loop whose start is not before its end', () => {
    expectReject(
      corrupt((r) => (r.loop.end = r.loop.start)),
      /loop/,
    )
    expectReject(
      corrupt((r) => (r.loop = { start: { col: 4, frac: { n: 0, d: 1 } }, end: r.loop.start })),
      /loop/,
    )
    expectReject(
      corrupt((r) => delete r.loop.end),
      /loop\.end/,
    )
  })

  it('rejects a tempo map with a bad bpm, a bad pos or events out of order', () => {
    expectReject(
      corrupt((r) => (r.tempoMap[1].bpm = 0)),
      /tempoMap/,
    )
    expectReject(
      corrupt((r) => (r.tempoMap[1].bpm = 'fast')),
      /tempoMap\[1\]\.bpm/,
    )
    expectReject(
      corrupt((r) => (r.tempoMap[1].pos.col = -8)),
      /tempoMap/,
    )
    expectReject(
      corrupt((r) => (r.tempoMap[0].pos = { col: 0, frac: { n: 4, d: 3 } })),
      /tempoMap\[0\]\.pos.*canonical/,
    )
  })

  it('rejects non-array collections', () => {
    expectReject(
      corrupt((r) => (r.layers = {})),
      /layers/,
    )
    expectReject(
      corrupt((r) => (r.notes = null)),
      /notes/,
    )
    expectReject(
      corrupt((r) => (r.tempoMap = 'none')),
      /tempoMap/,
    )
  })

  it('never returns a half-built project when a late field is malformed', () => {
    // The failure is in the last note; nothing earlier may leak out.
    const raw = corrupt((r) => (r.notes[2].pitch = 999))
    let built: unknown = 'untouched'
    expect(() => (built = deserializeProject(raw))).toThrow(RangeError)
    expect(built).toBe('untouched')
    // ...and the input is not mutated on the way through.
    expect((raw as any).notes[2].pitch).toBe(999)
  })
})

describe('loadProject', () => {
  it('rebuilds the note index, finding a long note at its far column', () => {
    const { project, index } = loadProject(serializeProject(FIXTURE))
    expect(project).toEqual(FIXTURE)
    expect(index.byId.size).toBe(3)
    // n2 spans cols 5..8 inclusive but is indexed at col 5 alone (§4.1).
    expect(index.queryRange('L1', 8, 9).map((n) => n.id)).toEqual(['n2'])
    expect(index.hitCandidates('L1', 8, 60).map((n) => n.id)).toEqual(['n2'])
    expect(index.findExact('L1', 48, pos(-4, 1, 12))?.id).toBe('n1')
    expect(index.notesByLayer.get('L1')!.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(index.maxDurQuarters.get('L1')).toBe(4)
  })

  it('indexes the deserialized notes, not the raw input', () => {
    const { project, index } = loadProject(serializeProject(FIXTURE))
    expect(index.byId.get('n1')).toBe(project.notes[0])
  })

  it('propagates a validation failure instead of indexing junk', () => {
    expect(() => loadProject(corrupt((r) => (r.notes[0].pitch = -1)))).toThrow(RangeError)
  })
})

describe('createEmptyProject', () => {
  it('passes its own validator and survives a round trip', () => {
    const p = createEmptyProject()
    expect(deserializeProject(serializeProject(p))).toEqual(p)
    expect(projectToBlobString(deserializeProject(serializeProject(p)))).toBe(
      projectToBlobString(p),
    )
  })

  it('starts with the four §9.4 layers on distinct channels and colors', () => {
    const p = createEmptyProject()
    expect(p.layers.map((l) => l.name)).toEqual(['Piano', 'Guitar', 'Bass', 'Drums'])
    expect(p.layers.map((l) => l.channel)).toEqual([0, 1, 2, 9])
    expect(new Set(p.layers.map((l) => l.color)).size).toBe(4)
    expect(new Set(p.layers.map((l) => l.id)).size).toBe(4)
    expect(p.layers.map((l) => l.order)).toEqual([0, 1, 2, 3])
    expect(p.layers.every((l) => l.defaultVel === 96)).toBe(true)
    expect(p.layers.every((l) => l.audible && l.visible)).toBe(true)
    expect(p.layers.every((l) => l.colVel.size === 0 && l.subdivs.size === 0)).toBe(true)
  })

  it('starts empty, at 120 BPM from col 0, with Piano active and no loop', () => {
    const p = createEmptyProject()
    expect(p.version).toBe(1)
    expect(p.notes).toEqual([])
    expect(p.tempoMap).toEqual([{ pos: pos(0), bpm: 120 }])
    expect(p.activeLayerId).toBe(p.layers[0]!.id)
    expect(p.layers[0]!.name).toBe('Piano')
    expect(p.loop).toBeUndefined()
  })

  it('hands back independent Maps and arrays on every call', () => {
    const a = createEmptyProject()
    const b = createEmptyProject()
    a.layers[0]!.colVel.set(0, 10)
    expect(b.layers[0]!.colVel.size).toBe(0)
    expect(loadProject(serializeProject(b)).index.byId.size).toBe(0)
  })

  it('is a valid starting point for a note on any of its layers', () => {
    const p = createEmptyProject()
    const notes: Note[] = p.layers.map((l, i) => ({
      id: `n${i}`,
      layerId: l.id,
      pos: pos(i, 1, 3),
      dur: frac(1, 3),
      pitch: 48 + i,
    }))
    expect(deserializeProject(serializeProject({ ...p, notes }))).toEqual({ ...p, notes })
  })
})
