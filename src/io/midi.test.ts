import { describe, expect, it } from 'vitest'
import { Midi } from '@tonejs/midi'
import type { Layer, Note, Project, TempoEvent } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import type { InstrumentManifest } from '../audio/manifest'
import {
  FALLBACK_PPQ,
  MAX_PPQ,
  MIDI_MIN_BPM,
  chooseTicksPerQuarter,
  exportMidi,
  midiFileName,
  tickOf,
} from './midi'

// --- fixtures --------------------------------------------------------------

function layer(over: Partial<Layer> = {}): Layer {
  return {
    id: 'l1',
    name: 'Lead',
    color: '#fff',
    instrumentId: 'ph-piano-1',
    channel: 0,
    audible: true,
    visible: true,
    defaultVel: 96,
    colVel: new Map(),
    grid: [],
    order: 0,
    ...over,
  }
}

let nextId = 0
function note(over: Partial<Note> & Pick<Note, 'pos'>): Note {
  return {
    id: `n${nextId++}`,
    layerId: 'l1',
    dur: frac(1),
    pitch: 60,
    ...over,
  }
}

function project(over: Partial<Project> = {}): Project {
  return {
    version: 2,
    name: 'Test',
    tempoMap: [{ pos: pos(0), bpm: 120 }],
    layers: [layer()],
    notes: [],
    activeLayerId: 'l1',
    ...over,
  }
}

const pitched: InstrumentManifest = {
  id: 'ph-piano-1',
  name: 'Piano',
  kind: 'pitched',
  gmProgram: 4,
  samples: new Map([[60, 'C4']]),
  baseUrl: '/instruments/ph-piano-1',
  formats: ['wav'],
}

const kit: InstrumentManifest = {
  id: 'ph-kit-1',
  name: 'Kit',
  kind: 'kit',
  gmBasis: true,
  baseUrl: '/instruments/ph-kit-1',
  formats: ['wav'],
  pieces: [{ midi: 36, label: 'Kick', sample: 'kick' }],
}

// ---------------------------------------------------------------------------

describe('chooseTicksPerQuarter (§10)', () => {
  it('takes the largest multiple of L that fits when L is small', () => {
    // Only quarters: L = 1, so the PPQ is the ceiling itself.
    expect(chooseTicksPerQuarter(project())).toEqual({ ppq: MAX_PPQ, lcm: 1, exact: true })
  })

  it('is exact for the spec’s 16ths + triplets + 11s + 13s project', () => {
    const notes = [
      note({ pos: pos(0, 1, 16), dur: frac(1, 16) }),
      note({ pos: pos(1, 1, 3), dur: frac(1, 3) }),
      note({ pos: pos(2, 5, 11), dur: frac(1, 11) }),
      note({ pos: pos(3, 7, 13), dur: frac(1, 13) }),
    ]
    const choice = chooseTicksPerQuarter(project({ notes }))
    expect(choice.lcm).toBe(6864) // 2^4 * 3 * 11 * 13
    expect(choice.exact).toBe(true)
    expect(choice.ppq).toBe(6864 * Math.floor(MAX_PPQ / 6864))
    expect(choice.ppq).toBeLessThanOrEqual(MAX_PPQ)
  })

  it('falls back to the largest divisor of L when L overflows the ceiling', () => {
    const notes = [
      note({ pos: pos(0, 1, 256), dur: frac(1, 256) }),
      note({ pos: pos(1, 1, 9), dur: frac(1, 9) }),
      note({ pos: pos(2, 1, 11), dur: frac(1, 11) }),
      note({ pos: pos(3, 1, 13), dur: frac(1, 13) }),
    ]
    const choice = chooseTicksPerQuarter(project({ notes }))
    expect(choice.lcm).toBe(329472) // 2^8 * 3^2 * 11 * 13
    expect(choice.ppq).toBe(29952) // 329472 / 11
    expect(choice.exact).toBe(false)
    expect(choice.lcm % choice.ppq).toBe(0)
  })

  it('uses the 30240 fallback when L escapes the lattice primes', () => {
    // 17 is not reachable through the editor, but an imported file could carry it.
    const notes = [
      note({ pos: pos(0, 1, 17), dur: frac(1, 17) }),
      note({ pos: pos(1, 1, 2048), dur: frac(1, 2048) }),
    ]
    const choice = chooseTicksPerQuarter(project({ notes }))
    expect(choice.lcm).toBe(34816)
    expect(choice.ppq).toBe(FALLBACK_PPQ)
    expect(choice.exact).toBe(false)
  })

  it('counts note ends and tempo positions, not just onsets', () => {
    const notes = [note({ pos: pos(0, 1, 3), dur: frac(1, 4) })] // ends at 7/12
    const tempoMap: TempoEvent[] = [
      { pos: pos(0), bpm: 120 },
      { pos: pos(4, 1, 5), bpm: 90 },
    ]
    expect(chooseTicksPerQuarter(project({ notes, tempoMap })).lcm).toBe(60)
  })
})

describe('tickOf', () => {
  it('is exact when the denominator divides the PPQ', () => {
    expect(tickOf(pos(2, 1, 4), 960)).toBe(2 * 960 + 240)
    expect(tickOf(pos(0, 3, 8), 6864 * 4)).toBe((3 * 6864 * 4) / 8)
  })

  it('rounds to nearest when it does not', () => {
    // 1/3 of 960 is 320 exactly; 1/7 is 137.14... -> 137.
    expect(tickOf(pos(0, 1, 3), 960)).toBe(320)
    expect(tickOf(pos(0, 1, 7), 960)).toBe(137)
  })

  it('handles negative columns', () => {
    expect(tickOf(pos(-2, 1, 2), 480)).toBe(-960 + 240)
  })

  it('does not accumulate error across many events (§10)', () => {
    // Absolute rounding: event k sits within half a tick of k/7 quarters, forever.
    const ppq = 960
    for (let k = 0; k < 1000; k++) {
      const p = pos(Math.floor(k / 7), k % 7, 7)
      expect(Math.abs(tickOf(p, ppq) - (k / 7) * ppq)).toBeLessThanOrEqual(0.5)
    }
  })
})

describe('exportMidi', () => {
  const parse = (bytes: Uint8Array) => new Midi(bytes)

  it('writes an SMF type 1 file with the chosen PPQ and one track per layer', () => {
    const p = project({
      layers: [layer(), layer({ id: 'l2', name: 'Drums', instrumentId: 'ph-kit-1', order: 1 })],
      notes: [note({ pos: pos(0) }), note({ id: 'k', layerId: 'l2', pos: pos(0), pitch: 36 })],
    })
    const midi = parse(exportMidi(p, { ppq: 480 }))

    expect(midi.header.ppq).toBe(480)
    expect(midi.tracks).toHaveLength(2)
    expect(midi.tracks.map((t) => t.name)).toEqual(['Lead', 'Drums'])
  })

  it('sends kit layers to channel 10 and pitched layers to their program', () => {
    const p = project({
      layers: [layer(), layer({ id: 'l2', instrumentId: 'ph-kit-1', channel: 3, order: 1 })],
      notes: [note({ pos: pos(0) }), note({ id: 'k', layerId: 'l2', pos: pos(0), pitch: 36 })],
    })
    const instruments = new Map<string, InstrumentManifest>([
      ['ph-piano-1', pitched],
      ['ph-kit-1', kit],
    ])
    const midi = parse(exportMidi(p, { ppq: 480, instruments }))

    expect(midi.tracks[0]!.channel).toBe(0)
    expect(midi.tracks[0]!.instrument.number).toBe(4)
    expect(midi.tracks[1]!.channel).toBe(9) // GM channel 10, 0-indexed
  })

  it('orders tracks by layer order, not array order', () => {
    const p = project({
      layers: [layer({ id: 'b', name: 'B', order: 2 }), layer({ id: 'a', name: 'A', order: 1 })],
      notes: [],
    })
    expect(parse(exportMidi(p)).tracks.map((t) => t.name)).toEqual(['A', 'B'])
  })

  it('round-trips onsets and durations exactly at the chosen PPQ', () => {
    const notes = [
      note({ pos: pos(0, 1, 4), dur: frac(1, 4), pitch: 60 }),
      note({ pos: pos(1, 1, 3), dur: frac(2, 3), pitch: 64 }),
      note({ pos: pos(2, 5, 11), dur: frac(1, 11), pitch: 67 }),
    ]
    const p = project({ notes })
    const { ppq, exact } = chooseTicksPerQuarter(p)
    expect(exact).toBe(true)

    const track = parse(exportMidi(p, { ppq })).tracks[0]!
    const expected = notes.map((n) => ({
      ticks: tickOf(n.pos, ppq),
      durationTicks: Math.round(((n.dur.n / n.dur.d) * ppq)),
    }))
    expect(track.notes.map((n) => ({ ticks: n.ticks, durationTicks: n.durationTicks }))).toEqual(
      expected,
    )
  })

  it('round-trips every note within half a tick, even at a lossy PPQ (§12/M7)', () => {
    // A deliberately awkward mix: 7s and 13s against a PPQ that divides neither.
    const dens = [2, 3, 4, 5, 7, 11, 13, 16]
    const notes = dens.flatMap((d, i) =>
      [1, d - 1].map((n) =>
        note({ pos: pos(i, n, d), dur: frac(1, d), pitch: 48 + i, vel: 30 + i }),
      ),
    )
    const p = project({ notes })
    const ppq = 960 // the conventional value §10 warns about — exact for almost none of these
    const track = parse(exportMidi(p, { ppq })).tracks[0]!

    expect(track.notes).toHaveLength(notes.length)
    for (const [i, n] of notes.entries()) {
      const written = track.notes[i]!
      const onsetQuarters = n.pos.col + n.pos.frac.n / n.pos.frac.d
      const durQuarters = n.dur.n / n.dur.d
      expect(Math.abs(written.ticks / ppq - onsetQuarters)).toBeLessThanOrEqual(0.5 / ppq)
      // Duration is a difference of two rounded absolutes, so it can be off by a
      // whole tick — §10's point that the damage lands in duration, not onset.
      expect(Math.abs(written.durationTicks / ppq - durQuarters)).toBeLessThanOrEqual(1 / ppq)
      expect(written.midi).toBe(n.pitch)
    }
  })

  it('resolves velocity through §6.1 and survives the 0–1 round-trip', () => {
    const l = layer({ defaultVel: 40, colVel: new Map([[1, 111]]) })
    const p = project({
      layers: [l],
      notes: [
        note({ pos: pos(0) }), // layer default
        note({ pos: pos(1) }), // column velocity
        note({ pos: pos(2), vel: 1 }), // per-note override
      ],
    })
    const track = parse(exportMidi(p, { ppq: 480 })).tracks[0]!
    expect(track.notes.map((n) => Math.round(n.velocity * 127))).toEqual([40, 111, 1])
  })

  it('gives a sub-tick note one tick rather than dropping it', () => {
    const p = project({ notes: [note({ pos: pos(0), dur: frac(1, 256) })] })
    const track = parse(exportMidi(p, { ppq: 4 })).tracks[0]!
    expect(track.notes[0]!.durationTicks).toBe(1)
  })

  it('writes the tempo map as meta events and clamps below the 24-bit floor', () => {
    const tempoMap: TempoEvent[] = [
      { pos: pos(0), bpm: 120 },
      { pos: pos(4), bpm: 90 },
      { pos: pos(8), bpm: 3.576 }, // below the µs-per-quarter floor
    ]
    const midi = parse(exportMidi(project({ tempoMap }), { ppq: 480 }))

    expect(midi.header.tempos.map((t) => t.ticks)).toEqual([0, 1920, 3840])
    expect(midi.header.tempos[0]!.bpm).toBeCloseTo(120, 3)
    expect(midi.header.tempos[1]!.bpm).toBeCloseTo(90, 3)
    // Clamped up to the slowest tempo a 24-bit field can hold.
    expect(midi.header.tempos[2]!.bpm).toBeCloseTo(MIDI_MIN_BPM, 5)
    expect(60_000_000 / midi.header.tempos[2]!.bpm).toBeLessThanOrEqual(0xff_ff_ff)
  })

  it('exports muted layers by default and skips them on request', () => {
    const p = project({
      layers: [layer({ audible: false }), layer({ id: 'l2', name: 'On', order: 1 })],
    })
    expect(parse(exportMidi(p)).tracks).toHaveLength(2)
    expect(parse(exportMidi(p, { includeMuted: false })).tracks.map((t) => t.name)).toEqual(['On'])
  })

  it('clamps a caller-supplied PPQ into the legal 16-bit range', () => {
    expect(parse(exportMidi(project(), { ppq: 99_999 })).header.ppq).toBe(MAX_PPQ)
    expect(parse(exportMidi(project(), { ppq: 0 })).header.ppq).toBe(1)
  })
})

describe('midiFileName', () => {
  it('strips path-hostile characters and falls back to Untitled', () => {
    expect(midiFileName(project({ name: 'My Piece' }))).toBe('My Piece.mid')
    expect(midiFileName(project({ name: 'a/b:c' }))).toBe('a-b-c.mid')
    expect(midiFileName(project({ name: '   ' }))).toBe('Untitled.mid')
  })
})
