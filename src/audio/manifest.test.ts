import { describe, expect, it } from 'vitest'
import {
  INSTRUMENTS_BASE_URL,
  isKit,
  kitLabelFor,
  kitPitches,
  loadManifest,
  loadManifestIndex,
  parseManifest,
  parseManifestIndex,
} from './manifest'
import type { InstrumentManifest, KitManifest, PitchedManifest } from './manifest'
import { AUDITION_AMP_ATTACK_SECONDS, manifestToPreset } from './instruments'

/**
 * Manifest parsing, validated against the **real files on disk** rather than fixtures.
 *
 * `scripts/gen-samples.mjs` writes both the manifests and the `.wav` files they name.
 * A fixture copy here would let the generator and the parser drift apart silently — the
 * exact failure §9 warns about, where a manifest still parses but names a sample that
 * was never written, and the note is simply silent at runtime. So these tests read the
 * live `public/instruments/**` tree — every JSON file and every file name in it —
 * cross-check every sample name against the files that actually exist, and break the
 * moment either side moves.
 *
 * The tree is read through `import.meta.glob` rather than `node:fs` only because the
 * project ships no `@types/node`; the glob is resolved from the same directory at run
 * time, so the drift it catches is identical.
 *
 * The rejection paths are the other half: a manifest is remote input, and each bad
 * shape below corrupts something different downstream (a `.wav` suffix becomes a
 * `.wav.wav` 404, a non-GM kit row plays the wrong piece).
 */

const PUBLIC_INSTRUMENTS = '../../public/instruments'

/** Every JSON file under `public/instruments`, parsed, keyed by its path. */
const jsonFiles = import.meta.glob('../../public/instruments/**/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

/** Every file under `public/instruments`, samples included. Keys only — nothing is imported. */
const allFiles = Object.keys(import.meta.glob('../../public/instruments/**/*'))

function readJson(...segments: string[]): unknown {
  const key = [PUBLIC_INSTRUMENTS, ...segments].join('/')
  const value = jsonFiles[key]
  if (value === undefined) throw new Error(`no such file on disk: ${key}`)
  return value
}

/** File names directly inside `public/instruments/<dir>`. */
function filesIn(dir: string): string[] {
  const prefix = `${PUBLIC_INSTRUMENTS}/${dir}/`
  return allFiles.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
}

/** Directory names directly under `public/instruments`. */
function directories(): string[] {
  const prefix = `${PUBLIC_INSTRUMENTS}/`
  const seen = new Set<string>()
  for (const file of allFiles) {
    const rest = file.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) seen.add(rest.slice(0, slash))
  }
  return [...seen].sort()
}

const indexEntries = parseManifestIndex(readJson('index.json'))

/** Every manifest on disk, parsed — the input to the table-driven cases below. */
const onDisk: { id: string; manifest: InstrumentManifest }[] = indexEntries.map((entry) => ({
  id: entry.id,
  manifest: parseManifest(readJson(entry.id, 'manifest.json'), entry.id),
}))

// ---------------------------------------------------------------------------
// The real files
// ---------------------------------------------------------------------------

describe('the generated manifests on disk', () => {
  it('lists the four §9.4 starter instruments in index.json', () => {
    expect(indexEntries.map((e) => e.id)).toEqual([
      'ph-piano-1',
      'ph-guitar-1',
      'ph-bass-1',
      'ph-kit-1',
    ])
    expect(indexEntries.filter((e) => e.kind === 'kit')).toHaveLength(1)
  })

  it('has a directory for every index entry and an index entry for every directory', () => {
    expect(directories()).toEqual([...indexEntries.map((e) => e.id)].sort())
  })

  it.each(onDisk)('parses $id', ({ id, manifest }) => {
    expect(manifest.id).toBe(id)
    expect(manifest.name.length).toBeGreaterThan(0)
    expect(manifest.formats.length).toBeGreaterThan(0)
    // The preset path builds `${baseUrl}/${sample}.${format}`, so a trailing slash or a
    // trailing dot on the format would produce a double separator.
    expect(manifest.baseUrl.endsWith('/')).toBe(false)
    for (const format of manifest.formats) expect(format.startsWith('.')).toBe(false)
  })

  it('agrees with index.json on kind and name', () => {
    for (const entry of indexEntries) {
      const found = onDisk.find((m) => m.id === entry.id)
      expect(found?.manifest.kind).toBe(entry.kind)
      expect(found?.manifest.name).toBe(entry.name)
    }
  })

  it.each(onDisk)('names only samples that exist on disk for $id', ({ id, manifest }) => {
    const files = new Set(filesIn(id))
    const names = isKit(manifest)
      ? manifest.pieces.map((p) => p.sample)
      : [...manifest.samples.values()]
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      // Extension-less in the manifest; smplr appends the format itself (§9.1).
      expect(name).not.toContain('.')
      const found = manifest.formats.some((format) => files.has(`${name}.${format}`))
      expect(found, `${id}: no file for sample "${name}" in formats ${manifest.formats.join(',')}`).toBe(true)
    }
  })

  it.each(onDisk)('serves $id from its own directory', ({ id, manifest }) => {
    expect(manifest.baseUrl).toBe(`${INSTRUMENTS_BASE_URL}/${id}`)
  })

  it('maps pitched samples to MIDI numbers, ascending and in range', () => {
    for (const { manifest } of onDisk) {
      if (isKit(manifest)) continue
      const keys = [...manifest.samples.keys()]
      expect(keys.length).toBeGreaterThan(0)
      for (const midi of keys) {
        expect(Number.isInteger(midi)).toBe(true)
        expect(midi).toBeGreaterThanOrEqual(0)
        expect(midi).toBeLessThanOrEqual(127)
      }
      expect(manifest.gmProgram).toBeGreaterThanOrEqual(0)
      expect(manifest.gmProgram).toBeLessThanOrEqual(127)
    }
  })

  it('keys the kit by real GM drum numbers, not by array index', () => {
    const kit = onDisk.find((m) => isKit(m.manifest))?.manifest as KitManifest
    expect(kit.gmBasis).toBe(true)
    // The §9.2 trap: DrumMachine would map midi = 36 + indexInSamplesArray. If these
    // ever coincide with that formula the manifest has lost its GM basis.
    expect(kit.pieces.map((p) => p.midi)).toEqual([36, 38, 41, 42, 45, 46, 48, 49])
    expect(kit.pieces.map((p) => p.midi)).not.toEqual(kit.pieces.map((_, i) => 36 + i))
    // GM: 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash.
    expect(kitLabelFor(kit, 36)).toBe('Kick')
    expect(kitLabelFor(kit, 38)).toBe('Snare')
    expect(kitLabelFor(kit, 42)).toBe('HH Cl')
  })
})

// ---------------------------------------------------------------------------
// §9.3 board semantics
// ---------------------------------------------------------------------------

describe('kitLabelFor / kitPitches (§9.3)', () => {
  const kit = onDisk.find((m) => isKit(m.manifest))!.manifest as KitManifest
  const pitched = onDisk.find((m) => !isKit(m.manifest))!.manifest as PitchedManifest

  it('returns the piece label for a mapped row', () => {
    for (const piece of kit.pieces) {
      expect(kitLabelFor(kit, piece.midi)).toBe(piece.label)
    }
  })

  it('returns null for an unmapped row, which is what dims it and rejects placement', () => {
    expect(kitLabelFor(kit, 37)).toBeNull()
    expect(kitLabelFor(kit, 60)).toBeNull()
    expect(kitLabelFor(kit, 0)).toBeNull()
    expect(kitLabelFor(kit, 127)).toBeNull()
  })

  it('returns null for every row of a pitched instrument, so the gutter uses pitch names', () => {
    expect(kitLabelFor(pitched, 60)).toBeNull()
    expect(kitLabelFor(pitched, 36)).toBeNull()
  })

  it('adapts to the gutter LabelFor signature', () => {
    const labelFor: (pitch: number) => string | null = (pitch) => kitLabelFor(kit, pitch)
    expect(labelFor(36)).toBe('Kick')
    expect(labelFor(37)).toBeNull()
  })

  it('lists kit rows ascending regardless of authored order', () => {
    const shuffled: KitManifest = {
      ...kit,
      pieces: [
        { midi: 49, label: 'Crash', sample: 'crash' },
        { midi: 36, label: 'Kick', sample: 'kick' },
        { midi: 42, label: 'HH Cl', sample: 'hh-closed' },
      ],
    }
    expect(kitPitches(shuffled)).toEqual([36, 42, 49])
  })

  it('returns the disk kit rows ascending', () => {
    expect(kitPitches(kit)).toEqual([36, 38, 41, 42, 45, 46, 48, 49])
  })

  it('returns an empty row list for a pitched instrument', () => {
    expect(kitPitches(pitched)).toEqual([])
  })

  it('narrows with isKit', () => {
    const m: InstrumentManifest = kit
    expect(isKit(m)).toBe(true)
    expect(isKit(pitched)).toBe(false)
    if (isKit(m)) expect(m.pieces.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

/** A minimal valid pitched manifest, spread-and-overridden by the cases below. */
function pitchedRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-1',
    name: 'Test',
    kind: 'pitched',
    gmProgram: 0,
    samples: { '60': 'C4' },
    baseUrl: '/instruments/test-1',
    formats: ['wav'],
    ...overrides,
  }
}

function kitRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-kit',
    name: 'Test Kit',
    kind: 'kit',
    gmBasis: true,
    baseUrl: '/instruments/test-kit',
    formats: ['wav'],
    pieces: [{ midi: 36, label: 'Kick', sample: 'kick' }],
    ...overrides,
  }
}

describe('parseManifest accepts hand-built valid shapes', () => {
  it('accepts a minimal pitched manifest', () => {
    const m = parseManifest(pitchedRaw())
    expect(isKit(m)).toBe(false)
    expect((m as PitchedManifest).samples.get(60)).toBe('C4')
  })

  it('accepts a minimal kit manifest', () => {
    const m = parseManifest(kitRaw())
    expect(isKit(m)).toBe(true)
    expect(kitPitches(m)).toEqual([36])
  })

  it('defaults gmBasis to true when the key is absent', () => {
    const raw = kitRaw()
    delete raw.gmBasis
    expect((parseManifest(raw) as KitManifest).gmBasis).toBe(true)
  })

  it('accepts gmBasis: false without inventing a default', () => {
    expect((parseManifest(kitRaw({ gmBasis: false })) as KitManifest).gmBasis).toBe(false)
  })

  it('accepts the boundary MIDI keys 0 and 127', () => {
    const m = parseManifest(pitchedRaw({ samples: { '0': 'lo', '127': 'hi' } })) as PitchedManifest
    expect([...m.samples.keys()]).toEqual([0, 127])
  })

  it('accepts a multi-format preference list', () => {
    expect(parseManifest(pitchedRaw({ formats: ['ogg', 'm4a'] })).formats).toEqual(['ogg', 'm4a'])
  })
})

describe('parseManifest rejects', () => {
  const cases: [name: string, value: unknown, match: RegExp][] = [
    ['a non-object', 42, /must be an object, got number/],
    ['null', null, /must be an object, got null/],
    ['an array', [], /must be an object, got an array/],
    ['a missing id', { name: 'x' }, /\.id must be a string, got undefined/],
    ['an empty id', pitchedRaw({ id: '' }), /\.id must not be empty/],
    ['a non-string name', pitchedRaw({ name: 7 }), /name must be a string, got number/],
    ['an empty name', pitchedRaw({ name: '' }), /name must not be empty/],
    ['an unknown kind', pitchedRaw({ kind: 'drums' }), /kind must be "pitched" or "kit", got "drums"/],
    ['a missing kind', pitchedRaw({ kind: undefined }), /kind must be a string, got undefined/],
    ['a missing baseUrl', pitchedRaw({ baseUrl: undefined }), /baseUrl must be a string/],
    ['an empty baseUrl', pitchedRaw({ baseUrl: '' }), /baseUrl must not be empty/],
    ['formats that are not an array', pitchedRaw({ formats: 'wav' }), /formats must be an array, got string/],
    ['an empty formats list', pitchedRaw({ formats: [] }), /formats must list at least one format/],
    ['a non-string format', pitchedRaw({ formats: [1] }), /formats\[0\] must be a string, got number/],
    ['a dotted format', pitchedRaw({ formats: ['.wav'] }), /formats\[0\] must not start with a dot/],
    // Pitched
    ['a missing samples map', pitchedRaw({ samples: undefined }), /samples must be an object, got undefined/],
    ['an empty samples map', pitchedRaw({ samples: {} }), /samples must map at least one MIDI number/],
    ['a samples array', pitchedRaw({ samples: [] }), /samples must be an object, got an array/],
    ['a note-name sample key', pitchedRaw({ samples: { C4: 'C4' } }), /samples\["C4"\] key must be a plain MIDI number/],
    ['a float sample key', pitchedRaw({ samples: { '60.0': 'C4' } }), /samples\["60\.0"\] key must be a plain MIDI number/],
    ['a padded sample key', pitchedRaw({ samples: { ' 60': 'C4' } }), /key must be a plain MIDI number/],
    ['a negative sample key', pitchedRaw({ samples: { '-1': 'C4' } }), /key must be a plain MIDI number/],
    ['an out-of-range sample key', pitchedRaw({ samples: { '128': 'C4' } }), /must be a MIDI number 0–127, got 128/],
    // The §9.1 trap: the preset path appends the extension, so "C4.wav" fetches C4.wav.wav.
    ['an extension on a sample name', pitchedRaw({ samples: { '60': 'C4.wav' } }), /must be extension-less, got "C4\.wav"/],
    ['a path in a sample name', pitchedRaw({ samples: { '60': 'sub/C4' } }), /must not contain a path separator/],
    ['an empty sample name', pitchedRaw({ samples: { '60': '' } }), /samples\["60"\] must not be empty/],
    ['a non-string sample name', pitchedRaw({ samples: { '60': 3 } }), /samples\["60"\] must be a string, got number/],
    ['a missing gmProgram', pitchedRaw({ gmProgram: undefined }), /gmProgram must be an integer, got undefined/],
    ['a fractional gmProgram', pitchedRaw({ gmProgram: 1.5 }), /gmProgram must be an integer, got 1\.5/],
    ['an out-of-range gmProgram', pitchedRaw({ gmProgram: 200 }), /gmProgram must be a MIDI number 0–127, got 200/],
    // Kit
    ['missing pieces', kitRaw({ pieces: undefined }), /pieces must be an array, got undefined/],
    ['an empty pieces list', kitRaw({ pieces: [] }), /pieces must list at least one piece/],
    ['a non-object piece', kitRaw({ pieces: ['kick'] }), /pieces\[0\] must be an object, got string/],
    ['a piece without a midi row', kitRaw({ pieces: [{ label: 'Kick', sample: 'kick' }] }), /pieces\[0\]\.midi must be an integer/],
    ['a fractional midi row', kitRaw({ pieces: [{ midi: 36.5, label: 'K', sample: 'kick' }] }), /pieces\[0\]\.midi must be an integer, got 36\.5/],
    ['an out-of-range midi row', kitRaw({ pieces: [{ midi: 200, label: 'K', sample: 'kick' }] }), /pieces\[0\]\.midi must be a MIDI number 0–127, got 200/],
    [
      'a duplicated midi row',
      kitRaw({
        pieces: [
          { midi: 36, label: 'Kick', sample: 'kick' },
          { midi: 36, label: 'Kick 2', sample: 'kick2' },
        ],
      }),
      /pieces\[1\]\.midi duplicates row 36/,
    ],
    ['a piece without a label', kitRaw({ pieces: [{ midi: 36, sample: 'kick' }] }), /pieces\[0\]\.label must be a string/],
    ['an empty piece label', kitRaw({ pieces: [{ midi: 36, label: '', sample: 'kick' }] }), /pieces\[0\]\.label must not be empty/],
    ['a piece without a sample', kitRaw({ pieces: [{ midi: 36, label: 'K' }] }), /pieces\[0\]\.sample must be a string/],
    [
      'an extension on a piece sample',
      kitRaw({ pieces: [{ midi: 36, label: 'K', sample: 'kick.wav' }] }),
      /pieces\[0\]\.sample must be extension-less/,
    ],
    ['a non-boolean gmBasis', kitRaw({ gmBasis: 'yes' }), /gmBasis must be a boolean, got string/],
  ]

  it.each(cases)('%s', (_name, value, match) => {
    expect(() => parseManifest(value)).toThrowError(RangeError)
    expect(() => parseManifest(value)).toThrowError(match)
  })

  it('rejects a manifest whose id disagrees with the id it was served as', () => {
    expect(() => parseManifest(pitchedRaw({ id: 'other' }), 'test-1')).toThrowError(
      /test-1\.id must match the instrument it is served as, got "other"/,
    )
  })

  it('accepts a manifest whose id matches the id it was served as', () => {
    expect(parseManifest(pitchedRaw(), 'test-1').id).toBe('test-1')
  })

  it('names the failing path even before the id is known', () => {
    expect(() => parseManifest({}, 'ph-piano-1')).toThrowError(/ph-piano-1\.id must be a string/)
  })
})

describe('parseManifestIndex rejects', () => {
  it('a non-array', () => {
    expect(() => parseManifestIndex({})).toThrowError(/index must be an array, got object/)
  })

  it('a non-object entry', () => {
    expect(() => parseManifestIndex(['ph-piano-1'])).toThrowError(/index\[0\] must be an object, got string/)
  })

  it('an entry without an id', () => {
    expect(() => parseManifestIndex([{ name: 'x', kind: 'pitched' }])).toThrowError(/index\[0\]\.id must be a string/)
  })

  it('an entry without a name', () => {
    expect(() => parseManifestIndex([{ id: 'a', kind: 'pitched' }])).toThrowError(/index\[0\]\.name must be a string/)
  })

  it('an entry with an unknown kind', () => {
    expect(() => parseManifestIndex([{ id: 'a', name: 'A', kind: 'sfz' }])).toThrowError(
      /index\[0\]\.kind must be "pitched" or "kit", got "sfz"/,
    )
  })

  it('a duplicated id', () => {
    const entry = { id: 'a', name: 'A', kind: 'pitched' }
    expect(() => parseManifestIndex([entry, entry])).toThrowError(/index\[1\]\.id duplicates "a"/)
  })

  it('accepts an empty index — no instruments is not an error', () => {
    expect(parseManifestIndex([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** A `fetch` that serves the real `public/instruments` tree over the real URL shapes. */
function diskFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const rel = String(input).replace(`${INSTRUMENTS_BASE_URL}/`, '')
    const body = jsonFiles[`${PUBLIC_INSTRUMENTS}/${rel}`]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }) as unknown as typeof globalThis.fetch
}

describe('loadManifestIndex / loadManifest', () => {
  const source = { fetch: diskFetch() }

  it('fetches and validates the real index', async () => {
    await expect(loadManifestIndex(source)).resolves.toEqual(indexEntries)
  })

  it('fetches each instrument from /instruments/<id>/manifest.json', async () => {
    for (const entry of indexEntries) {
      const m = await loadManifest(entry.id, source)
      expect(m.id).toBe(entry.id)
      expect(m.kind).toBe(entry.kind)
    }
  })

  it('reports the HTTP status when a manifest is missing', async () => {
    await expect(loadManifest('nope', source)).rejects.toThrowError(
      /\/instruments\/nope\/manifest\.json returned HTTP 404/,
    )
  })

  it('reports unparsable JSON as a manifest error, not a raw SyntaxError', async () => {
    const badFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })) as unknown as typeof globalThis.fetch
    await expect(loadManifest('ph-piano-1', { fetch: badFetch })).rejects.toThrowError(
      /is not valid JSON — Unexpected token </,
    )
  })

  it('honours a baseUrl override so manifests can move to a CDN', async () => {
    const seen: string[] = []
    const recording = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return { ok: true, status: 200, json: async () => readJson('ph-piano-1', 'manifest.json') }
    }) as unknown as typeof globalThis.fetch
    await loadManifest('ph-piano-1', { baseUrl: 'https://cdn.example/i', fetch: recording })
    expect(seen).toEqual(['https://cdn.example/i/ph-piano-1/manifest.json'])
  })

  it('rejects a manifest served under the wrong id', async () => {
    const wrong = (async () => ({
      ok: true,
      status: 200,
      json: async () => readJson('ph-piano-1', 'manifest.json'),
    })) as unknown as typeof globalThis.fetch
    await expect(loadManifest('ph-guitar-1', { fetch: wrong })).rejects.toThrowError(
      /ph-guitar-1\.id must match the instrument it is served as, got "ph-piano-1"/,
    )
  })
})

// ---------------------------------------------------------------------------
// The URL contract with smplr
// ---------------------------------------------------------------------------

/**
 * `manifestToPreset` is the seam where a manifest becomes sample URLs, and it is pure —
 * no `AudioContext`, so it is testable here while the `Sampler` binding around it is
 * not. What is asserted is exactly the §9.1/§9.2 contract: smplr's preset loader builds
 * `${baseUrl}/${sample}.${format}`, and kit rows must key by GM number rather than by
 * position in an array.
 */
describe('manifestToPreset', () => {
  const kit = onDisk.find((m) => isKit(m.manifest))!.manifest as KitManifest
  const piano = onDisk.find((m) => m.id === 'ph-piano-1')!.manifest as PitchedManifest

  /** What smplr's SampleLoader will fetch for a preset. */
  function urls(preset: ReturnType<typeof manifestToPreset>): string[] {
    const { baseUrl, formats, map } = preset.samples
    const format = formats[0]
    return preset.groups
      .flatMap((g) => g.regions)
      .map((r) => `${baseUrl}/${map?.[r.sample] ?? r.sample}.${format}`)
  }

  it('builds URLs that resolve to real files for every instrument', () => {
    for (const { id, manifest } of onDisk) {
      const files = new Set(filesIn(id))
      for (const url of urls(manifestToPreset(manifest))) {
        expect(url.startsWith(`${INSTRUMENTS_BASE_URL}/${id}/`)).toBe(true)
        expect(files.has(url.slice(`${INSTRUMENTS_BASE_URL}/${id}/`.length))).toBe(true)
      }
    }
  })

  it('never doubles the extension', () => {
    for (const { manifest } of onDisk) {
      for (const url of urls(manifestToPreset(manifest))) {
        expect(url.endsWith('.wav.wav')).toBe(false)
      }
    }
  })

  it('pins each kit row to its own GM number with no pitch shifting', () => {
    const regions = manifestToPreset(kit).groups[0]!.regions
    expect(regions.map((r) => r.key)).toEqual(kitPitches(kit))
    // `key` sets keyLow = keyHigh = pitch, so row 38 can only ever play the snare —
    // the §9.2 failure DrumMachine's index-based mapping would introduce.
    for (const region of regions) expect(region.keyRange).toBeUndefined()
    expect(regions.find((r) => r.key === 38)?.sample).toBe('snare')
  })

  it('spreads pitched samples across contiguous key ranges covering 0–127', () => {
    const regions = manifestToPreset(piano).groups[0]!.regions
    const ranges = regions.map((r) => r.keyRange!)
    expect(ranges[0]![0]).toBe(0)
    expect(ranges[ranges.length - 1]![1]).toBe(127)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1)
    }
    // Each sample keeps its own recorded pitch, so smplr detunes by the difference.
    expect(regions.map((r) => r.pitch)).toEqual([...piano.samples.keys()].sort((a, b) => a - b))
  })

  it('carries the audition attack only when asked for it (§8.2)', () => {
    expect(manifestToPreset(piano).defaults).toBeUndefined()
    expect(manifestToPreset(piano, AUDITION_AMP_ATTACK_SECONDS).defaults?.ampAttack).toBe(0.003)
  })
})
