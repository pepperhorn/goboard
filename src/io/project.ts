import type { Frac, Layer, LayerId, Note, Pos, Project, Subdiv, TempoEvent } from '../core/types'
import { isPositive, normalize } from '../core/frac'
import { canonicalize, cmp as pcmp, lt as plt, pos as mkPos } from '../core/pos'
import { validateSubdiv } from '../core/subdiv'
import { DEFAULT_METER } from '../core/meter'
import type { GridRegion } from '../core/grid'
import { validateGridValue } from '../core/gridValue'
import { subdivsToRegions } from './gridMigrate'
import { buildTempoMap } from '../core/tempo'
import { NoteIndex } from '../core/noteIndex'

/**
 * `.go.json` project files. See go-spec.md §10 (and §4 for the shape).
 *
 * Two invariants make this module more than `JSON.stringify`:
 *
 * 1. **Deterministic bytes.** `Map` has no JSON form, so `colVel` becomes a
 *    `[[col, value], ...]` entry array — sorted by column, never left in insertion
 *    order. `grid` is already a sorted, deduplicated list (§3.8), so it is written
 *    in list order instead: sorting it would hide a caller bug (§3.2 §3.8 note in
 *    `writeGrid`). Autosave (§10) diffs the serialized string to
 *    decide whether anything changed, so two projects that are equal must serialize
 *    identically; otherwise dragging a note back where it came from writes a new
 *    revision. Every object is rebuilt key-by-key here for the same reason: JSON key
 *    order follows insertion order, and a `{d, n}` fraction from elsewhere would
 *    otherwise emit different bytes than a `{n, d}` one.
 *
 * 2. **Nothing enters the model unvalidated.** Imported JSON is arbitrary input:
 *    `Pos` may be non-canonical, a `Frac` unreduced or off the §3.1 lattice, a
 *    `Subdiv` three levels deep. All of those are unrepresentable in the types but
 *    perfectly expressible in JSON, and each one corrupts a different invariant
 *    downstream (index keys, ordering, the 256-slot bound). `deserializeProject`
 *    therefore *rebuilds* the project from the raw value rather than casting it, and
 *    rejects rather than repairs — silently canonicalizing an imported position would
 *    move the user's note without telling them.
 *
 * Every rejection is a `RangeError` naming the path that failed (`notes[2].pos.frac`),
 * including the ones that are strictly type errors: a caller catching a bad import has
 * no use for the distinction, and one error class keeps the import boundary uniform.
 * Because the project is built into locals and returned only at the very end, a
 * malformed file leaves nothing half-built behind.
 */

/** Extension for exported project files (§10). */
export const PROJECT_FILE_EXT = '.go.json'

/** The current schema version. v1 files are read via a migration (§3.2 -> §3.8). */
const VERSION = 2

/** The oldest schema version this module still reads. */
const MIN_READABLE_VERSION = 1

/** MIDI 7-bit range, shared by `pitch`, `vel`, `defaultVel` and `colVel` values. */
const MIDI_MAX = 127

/** MIDI channels are 0-indexed in the model: the spec's "channel 10" is 9 here (§4). */
const MAX_CHANNEL = 15

/** Layer-wide velocity a fresh layer starts at (§4). */
const INIT_VEL = 96

/** Starting tempo when a project has never been edited (§3.3). */
const INIT_BPM = 120

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function writeFrac(f: Frac): unknown {
  return { n: f.n, d: f.d }
}

function writePos(p: Pos): unknown {
  return { col: p.col, frac: writeFrac(p.frac) }
}

function writeGridRegion(r: GridRegion): unknown {
  return { start: writePos(r.start), value: writeFrac(r.value) }
}

/**
 * A layer's `grid` is already canonical (§3.2): sorted by `start`, no duplicate
 * starts, every value on the §3.1 lattice and in the §3.1 range. Writing therefore
 * only asserts those invariants rather than repairing them — a caller that hands in
 * an unsorted list, or a value `readGrid` would reject, has a bug. Silently sorting
 * would hide the first; skipping the value check would let an unopenable file reach
 * disk, since autosave writes without ever reading the bytes back (§10) — the write
 * that produced it would look like it succeeded right up until the next reload.
 */
function writeGrid(regions: readonly GridRegion[], where: string): unknown[] {
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!
    validateGridValue(region.value, `${where}[${i}].value`)
    if (i > 0 && pcmp(regions[i - 1]!.start, region.start) >= 0) {
      throw new Error(`Project: ${where} is not sorted into canonical order — this is a bug`)
    }
  }
  return regions.map(writeGridRegion)
}

/** A `Map` as column-sorted `[[col, value], ...]` — the §10 entry-array form. */
function writeMap<V>(m: ReadonlyMap<number, V>, writeValue: (v: V) => unknown): unknown[] {
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([col, value]) => [col, writeValue(value)])
}

function writeNote(n: Note): unknown {
  const out: Record<string, unknown> = {
    id: n.id,
    layerId: n.layerId,
    pos: writePos(n.pos),
    dur: writeFrac(n.dur),
    pitch: n.pitch,
  }
  // `undefined` disappears from JSON anyway; omitting it keeps the intent explicit —
  // absent `vel` means "inherit" (§6), and is not the same as any stored number.
  if (n.vel !== undefined) out.vel = n.vel
  return out
}

function writeLayer(l: Layer): unknown {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    instrumentId: l.instrumentId,
    channel: l.channel,
    audible: l.audible,
    visible: l.visible,
    defaultVel: l.defaultVel,
    colVel: writeMap(l.colVel, (v) => v),
    grid: writeGrid(l.grid, `layer "${l.id}" grid`),
    order: l.order,
  }
}

/** JSON-ready form of a project. Maps become column-sorted entry arrays. */
export function serializeProject(p: Project): unknown {
  const out: Record<string, unknown> = {
    version: p.version,
    name: p.name,
    tempoMap: p.tempoMap.map((e) => ({ pos: writePos(e.pos), bpm: e.bpm })),
    layers: p.layers.map(writeLayer),
    notes: p.notes.map(writeNote),
    activeLayerId: p.activeLayerId,
  }
  if (p.loop !== undefined) {
    out.loop = { start: writePos(p.loop.start), end: writePos(p.loop.end) }
  }
  return out
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function fail(where: string, why: string): never {
  throw new RangeError(`Project: ${where} ${why}`)
}

/** What a value looks like in an error message: `null` and arrays beat bare `object`. */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/** Run a core validator, re-reporting its failure under this module's path prefix. */
function guard<T>(where: string, what: string, run: () => T): T {
  try {
    return run()
  } catch (err) {
    fail(where, `${what} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

function requireObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(where, `must be an object, got ${describe(v)}`)
  }
  return v as Record<string, unknown>
}

function requireArray(v: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(v)) fail(where, `must be an array, got ${describe(v)}`)
  return v as readonly unknown[]
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string') fail(where, `must be a string, got ${describe(v)}`)
  return v
}

function requireBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') fail(where, `must be a boolean, got ${describe(v)}`)
  return v
}

function requireInt(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    fail(where, `must be a safe integer, got ${typeof v === 'number' ? v : describe(v)}`)
  }
  return v
}

function requireIntInRange(v: unknown, where: string, lo: number, hi: number): number {
  const n = requireInt(v, where)
  if (n < lo || n > hi) fail(where, `must be in ${lo}..${hi}, got ${n}`)
  return n
}

/**
 * A `Frac` that is already in lowest terms with `d > 0` and inside the §3.1 lattice.
 *
 * The check is a round-trip through `normalize`: `{n:2,d:4}` and `{n:1,d:2}` are the
 * same number but different objects, and `frac.eq` — which the whole engine compares
 * with — is component-wise, so an unreduced import would sit in the model comparing
 * unequal to itself.
 */
function readFrac(v: unknown, where: string): Frac {
  const o = requireObject(v, where)
  const n = requireInt(o.n, `${where}.n`)
  const d = requireInt(o.d, `${where}.d`)
  const norm = guard(where, `is not a usable rational (${n}/${d})`, () => normalize(n, d))
  if (norm.n !== n || norm.d !== d) {
    fail(where, `is not normalized: ${n}/${d} reduces to ${norm.n}/${norm.d}`)
  }
  return norm
}

/**
 * A `Pos` in canonical form (`0 <= frac < 1`).
 *
 * Re-canonicalizing must be a no-op. `{col:0, frac:5/4}` and `{col:1, frac:1/4}` are
 * the same instant, but they produce different `notesByCell` keys and sort differently
 * (§4.1), so the same note would be findable at two columns.
 */
function readPos(v: unknown, where: string): Pos {
  const o = requireObject(v, where)
  const col = requireInt(o.col, `${where}.col`)
  const f = readFrac(o.frac, `${where}.frac`)
  const canon = guard(where, 'has an unusable column', () => canonicalize(col, f))
  if (canon.col !== col || canon.frac.n !== f.n || canon.frac.d !== f.d) {
    const was = `col ${col} + ${f.n}/${f.d}`
    fail(where, `is not canonical: ${was} is col ${canon.col} + ${canon.frac.n}/${canon.frac.d}`)
  }
  return canon
}

/** A positive `Frac` — zero-length notes and tempo segments are not representable. */
function readDur(v: unknown, where: string): Frac {
  const d = readFrac(v, where)
  if (!isPositive(d)) fail(where, `must be positive, got ${d.n}/${d.d}`)
  return d
}

/**
 * `[[col, value], ...]` back into a `Map`.
 *
 * Duplicate columns are rejected rather than resolved last-wins: a file carrying two
 * velocities for one column is ambiguous, and quietly picking one would round-trip to
 * different bytes than it arrived as.
 */
function readMap<V>(
  v: unknown,
  where: string,
  readValue: (raw: unknown, at: string) => V,
): Map<number, V> {
  const entries = requireArray(v, where)
  const out = new Map<number, V>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail(`${where} entry ${i}`, `must be a [col, value] pair, got ${describe(entry)}`)
    }
    const col = requireInt((entry as readonly unknown[])[0], `${where} entry ${i} key`)
    if (out.has(col)) fail(where, `has a duplicate column ${col}`)
    out.set(col, readValue((entry as readonly unknown[])[1], `${where}[${col}]`))
  }
  return out
}

function readSubdiv(v: unknown, where: string): Subdiv {
  // `validateSubdiv` is the §3.2 depth/width guard; it just doesn't know the column.
  return guard(where, 'is not a valid subdivision', () => validateSubdiv(v))
}

/**
 * `[{start, value}, ...]` back into a `GridRegion[]` (§3.8).
 *
 * Regions must already be canonical on disk: sorted by `start`, with no two regions
 * sharing a start. Both are rejected here rather than repaired, for the same reason
 * `readPos` rejects a non-canonical position — silently reordering or dropping one
 * would move the user's grid without telling them.
 */
function readGrid(v: unknown, where: string): GridRegion[] {
  const raw = requireArray(v, where)
  const out: GridRegion[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = requireObject(raw[i], `${where}[${i}]`)
    const start = readPos(o.start, `${where}[${i}].start`)
    const value = validateGridValue(o.value, `${where}[${i}].value`)
    const prev = out[out.length - 1]
    if (prev !== undefined) {
      const order = pcmp(prev.start, start)
      if (order === 0) fail(`${where}[${i}].start`, 'duplicates the previous region\'s start')
      if (order > 0) fail(`${where}[${i}].start`, 'is out of order relative to the previous region')
    }
    out.push({ start, value })
  }
  return out
}

/** Fields shared by every `.go.json` version. */
function readLayerCommon(o: Record<string, unknown>, where: string) {
  return {
    id: requireString(o.id, `${where}.id`),
    name: requireString(o.name, `${where}.name`),
    color: requireString(o.color, `${where}.color`),
    instrumentId: requireString(o.instrumentId, `${where}.instrumentId`),
    channel: requireIntInRange(o.channel, `${where}.channel`, 0, MAX_CHANNEL),
    audible: requireBoolean(o.audible, `${where}.audible`),
    visible: requireBoolean(o.visible, `${where}.visible`),
    defaultVel: requireIntInRange(o.defaultVel, `${where}.defaultVel`, 0, MIDI_MAX),
    colVel: readMap(o.colVel, `${where}.colVel`, (raw, at) =>
      requireIntInRange(raw, at, 0, MIDI_MAX),
    ),
    order: requireInt(o.order, `${where}.order`),
  }
}

/** v2 layer: `grid` is read directly. */
function readLayerV2(v: unknown, where: string): Layer {
  const o = requireObject(v, where)
  return { ...readLayerCommon(o, where), grid: readGrid(o.grid, `${where}.grid`) }
}

/** v1 layer: `subdivs` is read the old way, then migrated to regions (§3.2 -> §3.8). */
function readLayerV1(v: unknown, where: string): Layer {
  const o = requireObject(v, where)
  const subdivs = readMap(o.subdivs, `${where}.subdivs`, readSubdiv)
  return { ...readLayerCommon(o, where), grid: subdivsToRegions(subdivs) }
}

function readNote(v: unknown, where: string, layerIds: ReadonlySet<LayerId>): Note {
  const o = requireObject(v, where)
  const layerId = requireString(o.layerId, `${where}.layerId`)
  if (!layerIds.has(layerId)) fail(`${where}.layerId`, `references no layer: "${layerId}"`)
  const note: Note = {
    id: requireString(o.id, `${where}.id`),
    layerId,
    pos: readPos(o.pos, `${where}.pos`),
    dur: readDur(o.dur, `${where}.dur`),
    pitch: requireIntInRange(o.pitch, `${where}.pitch`, 0, MIDI_MAX),
  }
  // Absent `vel` inherits (§6); `null` is not a legal spelling of absent.
  if (o.vel === undefined) return note
  return { ...note, vel: requireIntInRange(o.vel, `${where}.vel`, 0, MIDI_MAX) }
}

function readTempoEvent(v: unknown, where: string): TempoEvent {
  const o = requireObject(v, where)
  const bpm = o.bpm
  if (typeof bpm !== 'number' || !Number.isFinite(bpm)) {
    fail(`${where}.bpm`, `must be a finite number, got ${describe(bpm)}`)
  }
  return { pos: readPos(o.pos, `${where}.pos`), bpm }
}

/**
 * Validate arbitrary parsed JSON into a `Project`, or throw a `RangeError` naming the
 * offending path. The result shares no structure with the input.
 */
export function deserializeProject(raw: unknown): Project {
  const o = requireObject(raw, 'root')
  if (o.version !== VERSION && o.version !== MIN_READABLE_VERSION) {
    const got = typeof o.version === 'number' ? o.version : describe(o.version)
    fail('version', `must be ${MIN_READABLE_VERSION} or ${VERSION}, got ${got}`)
  }
  const readLayer = o.version === MIN_READABLE_VERSION ? readLayerV1 : readLayerV2
  const name = requireString(o.name, 'name')
  const activeLayerId = requireString(o.activeLayerId, 'activeLayerId')

  const layers: Layer[] = []
  const layerIds = new Set<LayerId>()
  const rawLayers = requireArray(o.layers, 'layers')
  for (let i = 0; i < rawLayers.length; i++) {
    const layer = readLayer(rawLayers[i], `layers[${i}]`)
    if (layerIds.has(layer.id)) {
      fail(`layers[${i}].id`, `duplicates an earlier layer id: "${layer.id}"`)
    }
    layerIds.add(layer.id)
    layers.push(layer)
  }
  if (!layerIds.has(activeLayerId)) {
    fail('activeLayerId', `references no layer: "${activeLayerId}"`)
  }

  const notes: Note[] = []
  const noteIds = new Set<string>()
  const rawNotes = requireArray(o.notes, 'notes')
  for (let i = 0; i < rawNotes.length; i++) {
    const note = readNote(rawNotes[i], `notes[${i}]`, layerIds)
    // `NoteIndex.insert` rejects duplicates too, but only once loaded — catching it
    // here keeps the file the thing that is reported as broken.
    if (noteIds.has(note.id)) fail(`notes[${i}].id`, `duplicates an earlier note id: "${note.id}"`)
    noteIds.add(note.id)
    notes.push(note)
  }

  const rawTempo = requireArray(o.tempoMap, 'tempoMap')
  const tempoMap = rawTempo.map((e, i) => readTempoEvent(e, `tempoMap[${i}]`))
  // Ordering, the BPM range and coincident events are `buildTempoMap`'s rules (§3.3);
  // the built map is discarded because §4.1 says runtime structures are not persisted.
  guard('tempoMap', 'is not a valid tempo map', () => buildTempoMap(tempoMap))

  // `meterMap` is not yet part of the `.go.json` format — reading and writing it is
  // Task 12's work. Every project gets the implicit one-4/4-at-the-origin default
  // (design §3.7) until then, so `Project` stays fully constructed here.
  const meterMap = [DEFAULT_METER]

  if (o.loop === undefined) {
    return { version: VERSION, name, tempoMap, layers, notes, activeLayerId, meterMap }
  }

  const loopRaw = requireObject(o.loop, 'loop')
  const loop = {
    start: readPos(loopRaw.start, 'loop.start'),
    end: readPos(loopRaw.end, 'loop.end'),
  }
  // An empty or inverted loop would spin the scheduler (§8.1) with nothing to play.
  if (!plt(loop.start, loop.end)) {
    fail('loop', `start must be before end, got col ${loop.start.col} .. col ${loop.end.col}`)
  }
  return { version: VERSION, name, tempoMap, layers, notes, activeLayerId, meterMap, loop }
}

/**
 * Import: validate, then build the runtime note index.
 *
 * §4.1 keeps no index in the file — they rebuild on load — so this is the one call
 * every importer should use, rather than deserializing and forgetting the index.
 */
export function loadProject(raw: unknown): { project: Project; index: NoteIndex } {
  const project = deserializeProject(raw)
  return { project, index: NoteIndex.build(project.notes) }
}

/** The text of a `.go.json` file. Indented, because these end up in diffs. */
export function projectToBlobString(p: Project): string {
  return JSON.stringify(serializeProject(p), null, 2)
}

/** Parse and validate the text of a `.go.json` file. */
export function projectFromString(s: string): Project {
  return deserializeProject(JSON.parse(s) as unknown)
}

// ---------------------------------------------------------------------------
// New projects
// ---------------------------------------------------------------------------

/** The §9.4 starter layers. Channels are 0-indexed, so the drum kit's "10" is 9. */
const STARTER_LAYERS: readonly {
  id: LayerId
  name: string
  color: string
  instrumentId: string
  channel: number
}[] = [
  { id: 'piano', name: 'Piano', color: '#4f8cff', instrumentId: 'ph-piano-1', channel: 0 },
  { id: 'guitar', name: 'Guitar', color: '#f2994a', instrumentId: 'ph-guitar-1', channel: 1 },
  { id: 'bass', name: 'Bass', color: '#27ae60', instrumentId: 'ph-bass-1', channel: 2 },
  { id: 'drums', name: 'Drums', color: '#eb5757', instrumentId: 'ph-kit-1', channel: 9 },
]

/**
 * A new, empty project: the four §9.4 starter layers, 120 BPM from col 0, no notes.
 *
 * Every call builds fresh `Map`s and arrays — the returned project is the live model,
 * and two projects sharing one `colVel` map would edit each other.
 */
export function createEmptyProject(): Project {
  return {
    version: VERSION,
    name: 'Untitled',
    tempoMap: [{ pos: mkPos(0), bpm: INIT_BPM }],
    layers: STARTER_LAYERS.map((l, order) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      instrumentId: l.instrumentId,
      channel: l.channel,
      audible: true,
      visible: true,
      defaultVel: INIT_VEL,
      colVel: new Map<number, number>(),
      grid: [],
      order,
    })),
    notes: [],
    activeLayerId: STARTER_LAYERS[0]!.id,
    meterMap: [DEFAULT_METER],
  }
}
