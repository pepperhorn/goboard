/**
 * Instrument manifests. See go-spec.md §9.1 (pitched), §9.2 (kits), §9.3 (board).
 *
 * One JSON per instrument, self-hosted under `/instruments/<id>/manifest.json`, plus a
 * flat `/instruments/index.json` listing what exists. The manifest is the **single
 * source of truth for both sound and board semantics** (§9.2): the same file that tells
 * smplr which samples to fetch tells the gutter which rows are playable and what to
 * call them.
 *
 * Three details of the format are load-bearing rather than stylistic:
 *
 * 1. **Sample names carry no extension.** They are fed to smplr's *preset* path, whose
 *    loader builds `` `${baseUrl}/${map[name] ?? name}.${format}` ``. A name of
 *    `"C3.wav"` would therefore fetch `C3.wav.wav`. Validation rejects a dot in a
 *    sample name outright, because the failure mode is a silent 404 → a silent note.
 * 2. **Every pitched key is a MIDI number**, so smplr spreads the sampled pitches
 *    across key ranges itself (§9.1) — zone/stretch stays its job.
 * 3. **Kit rows are real GM MIDI numbers**, not array indices (§9.2). `pieces[]` order
 *    is presentation only; nothing here or downstream may derive a pitch from it.
 *
 * Rejections are `RangeError`s naming the failing path (`ph-kit-1: pieces[2].midi …`),
 * matching `src/io/project.ts`. A manifest is arbitrary remote input; it is rebuilt
 * field by field here rather than cast, and rejected rather than repaired.
 */

/** MIDI 7-bit range, shared by pitched sample keys and kit piece rows. */
const MIDI_MAX = 127

/** Where the manifests live when no override is given. */
export const INSTRUMENTS_BASE_URL = '/instruments'

/** One entry of `/instruments/index.json` — enough to populate a picker without fetching every manifest. */
export type InstrumentIndexEntry = {
  readonly id: string
  readonly name: string
  readonly kind: InstrumentKind
}

export type InstrumentKind = 'pitched' | 'kit'

/** §9.1. `samples` maps a MIDI number (as a string key) to an **extension-less** sample name. */
export type PitchedManifest = {
  readonly id: string
  readonly name: string
  readonly kind: 'pitched'
  /** MIDI export program (§9.4). Never used for playback. */
  readonly gmProgram: number
  readonly samples: ReadonlyMap<number, string>
  readonly baseUrl: string
  /** Format preference order; smplr picks the first the browser can decode. */
  readonly formats: readonly string[]
}

/** One drum row (§9.2). `midi` is a real GM drum number, never an index. */
export type KitPiece = {
  readonly midi: number
  readonly label: string
  readonly sample: string
}

/** §9.2. */
export type KitManifest = {
  readonly id: string
  readonly name: string
  readonly kind: 'kit'
  /** Rows follow GM drum-map numbering. Absent in JSON means `true`. */
  readonly gmBasis: boolean
  readonly baseUrl: string
  readonly formats: readonly string[]
  /** Presentation order as authored; `kitPitches` is the sorted view. */
  readonly pieces: readonly KitPiece[]
}

export type InstrumentManifest = PitchedManifest | KitManifest

/** Narrowing for every `kind`-dependent branch — §9.3's gutter, board, and export. */
export function isKit(m: InstrumentManifest): m is KitManifest {
  return m.kind === 'kit'
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(where: string, why: string): never {
  throw new RangeError(`Manifest: ${where} ${why}`)
}

/** What a value looks like in an error message: `null` and arrays beat bare `object`. */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
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
  if (v.length === 0) fail(where, 'must not be empty')
  return v
}

function requireMidi(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    fail(where, `must be an integer, got ${describe(v) === 'number' ? String(v) : describe(v)}`)
  }
  if (v < 0 || v > MIDI_MAX) fail(where, `must be a MIDI number 0–${MIDI_MAX}, got ${v}`)
  return v
}

/**
 * A sample name as the preset loader will use it: no extension, no path escape.
 *
 * The dot check is the important one (see the module header). The separator check keeps
 * a manifest from reaching outside its own `baseUrl` directory.
 */
function requireSampleName(v: unknown, where: string): string {
  const name = requireString(v, where)
  if (name.includes('.')) {
    fail(where, `must be extension-less, got "${name}" (smplr appends the format itself)`)
  }
  if (name.includes('/') || name.includes('\\')) fail(where, `must not contain a path separator, got "${name}"`)
  return name
}

function requireFormats(v: unknown, where: string): readonly string[] {
  const raw = requireArray(v, where)
  if (raw.length === 0) fail(where, 'must list at least one format')
  return raw.map((f, i) => {
    const format = requireString(f, `${where}[${i}]`)
    if (format.startsWith('.')) fail(`${where}[${i}]`, `must not start with a dot, got "${format}"`)
    return format
  })
}

function requireKind(v: unknown, where: string): InstrumentKind {
  const kind = requireString(v, where)
  if (kind !== 'pitched' && kind !== 'kit') {
    fail(where, `must be "pitched" or "kit", got "${kind}"`)
  }
  return kind
}

/**
 * Parse and validate one manifest.
 *
 * `expectId`, when given, is the id the caller fetched under; a manifest whose own `id`
 * disagrees is rejected rather than trusted, because every later lookup (layer →
 * instrument, MIDI export, cache key) goes through that id and a mismatch would make
 * one directory answer to two names.
 */
export function parseManifest(value: unknown, expectId?: string): InstrumentManifest {
  const root = requireObject(value, expectId ?? 'manifest')
  const id = requireString(root.id, `${expectId ?? 'manifest'}.id`)
  const where = id
  if (expectId !== undefined && id !== expectId) {
    fail(`${expectId}.id`, `must match the instrument it is served as, got "${id}"`)
  }

  const name = requireString(root.name, `${where}.name`)
  const kind = requireKind(root.kind, `${where}.kind`)
  const baseUrl = requireString(root.baseUrl, `${where}.baseUrl`)
  const formats = requireFormats(root.formats, `${where}.formats`)

  if (kind === 'pitched') {
    const rawSamples = requireObject(root.samples, `${where}.samples`)
    const entries = Object.entries(rawSamples)
    if (entries.length === 0) fail(`${where}.samples`, 'must map at least one MIDI number to a sample')

    const samples = new Map<number, string>()
    for (const [key, raw] of entries) {
      // JSON object keys are strings; the model wants the number they denote, and
      // "60.0"/" 60"/"C4" must not slip through as 60.
      if (!/^(0|[1-9][0-9]*)$/.test(key)) {
        fail(`${where}.samples["${key}"]`, 'key must be a plain MIDI number')
      }
      const midi = requireMidi(Number(key), `${where}.samples["${key}"]`)
      samples.set(midi, requireSampleName(raw, `${where}.samples["${key}"]`))
    }

    const gmProgram = requireMidi(root.gmProgram, `${where}.gmProgram`)
    return { id, name, kind, gmProgram, samples, baseUrl, formats }
  }

  const rawPieces = requireArray(root.pieces, `${where}.pieces`)
  if (rawPieces.length === 0) fail(`${where}.pieces`, 'must list at least one piece')

  const seen = new Set<number>()
  const pieces: KitPiece[] = rawPieces.map((raw, i) => {
    const piece = requireObject(raw, `${where}.pieces[${i}]`)
    const midi = requireMidi(piece.midi, `${where}.pieces[${i}].midi`)
    if (seen.has(midi)) fail(`${where}.pieces[${i}].midi`, `duplicates row ${midi}`)
    seen.add(midi)
    return {
      midi,
      label: requireString(piece.label, `${where}.pieces[${i}].label`),
      sample: requireSampleName(piece.sample, `${where}.pieces[${i}].sample`),
    }
  })

  let gmBasis = true
  if (root.gmBasis !== undefined) {
    if (typeof root.gmBasis !== 'boolean') {
      fail(`${where}.gmBasis`, `must be a boolean, got ${describe(root.gmBasis)}`)
    }
    gmBasis = root.gmBasis
  }

  return { id, name, kind, gmBasis, baseUrl, formats, pieces }
}

/** Parse and validate `/instruments/index.json`. */
export function parseManifestIndex(value: unknown): readonly InstrumentIndexEntry[] {
  const raw = requireArray(value, 'index')
  const seen = new Set<string>()
  return raw.map((entry, i) => {
    const obj = requireObject(entry, `index[${i}]`)
    const id = requireString(obj.id, `index[${i}].id`)
    if (seen.has(id)) fail(`index[${i}].id`, `duplicates "${id}"`)
    seen.add(id)
    return {
      id,
      name: requireString(obj.name, `index[${i}].name`),
      kind: requireKind(obj.kind, `index[${i}].kind`),
    }
  })
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Injection seam: tests and the node-side tooling pass their own fetch/base. */
export type ManifestSource = {
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
}

async function fetchJson(url: string, source: ManifestSource | undefined): Promise<unknown> {
  const doFetch = source?.fetch ?? globalThis.fetch
  const response = await doFetch(url)
  if (!response.ok) {
    throw new RangeError(`Manifest: ${url} returned HTTP ${response.status}`)
  }
  try {
    return (await response.json()) as unknown
  } catch (err) {
    throw new RangeError(`Manifest: ${url} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function loadManifestIndex(source?: ManifestSource): Promise<readonly InstrumentIndexEntry[]> {
  const base = source?.baseUrl ?? INSTRUMENTS_BASE_URL
  return parseManifestIndex(await fetchJson(`${base}/index.json`, source))
}

export async function loadManifest(id: string, source?: ManifestSource): Promise<InstrumentManifest> {
  const base = source?.baseUrl ?? INSTRUMENTS_BASE_URL
  return parseManifest(await fetchJson(`${base}/${id}/manifest.json`, source), id)
}

// ---------------------------------------------------------------------------
// Board semantics (§9.3)
// ---------------------------------------------------------------------------

/**
 * The gutter label for a row, or `null` when the row takes no stone.
 *
 * Pitched manifests always return `null` — the gutter falls back to pitch names for
 * them (§9.3), and "no piece label" is exactly what that means. Kit rows without a
 * mapped piece return `null` too, which is what dims them and rejects placement.
 * Adapts directly to `src/board/gutter.ts`'s `LabelFor`.
 */
export function kitLabelFor(manifest: InstrumentManifest, pitch: number): string | null {
  if (!isKit(manifest)) return null
  for (const piece of manifest.pieces) {
    if (piece.midi === pitch) return piece.label
  }
  return null
}

/**
 * The playable rows of a kit, ascending. Empty for a pitched manifest.
 *
 * Sorted rather than authored-order because the board draws bottom-up by pitch, and
 * §9.2 forbids deriving anything from `pieces[]` order.
 */
export function kitPitches(manifest: InstrumentManifest): number[] {
  if (!isKit(manifest)) return []
  return manifest.pieces.map((p) => p.midi).sort((a, b) => a - b)
}
