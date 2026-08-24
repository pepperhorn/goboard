import type { LayerId } from '../core/types'
import type { StopFn, VoiceRequest, VoiceSink } from './scheduler'
import type { InstrumentManifest } from './manifest'
import type { NoteEvent, SampleLoader as SmplrSampleLoader, SmplrPreset, SmplrRegion } from 'smplr'
import { CacheStorage, SampleLoader, Sampler } from 'smplr'
import { isKit, loadManifest } from './manifest'

/**
 * The smplr binding: manifests in, `VoiceSink` out. See go-spec.md §8.2 and §9.
 *
 * This is the only module in the project that knows smplr exists. The scheduler is
 * injected with the `VoiceSink` below and never sees an `AudioContext`, which is what
 * keeps §8.1's timing tests headless.
 *
 * smplr 1.0.0 has four traps this module exists to contain:
 *
 *  - `Sampler(ctx, opts)` is a **factory**, not a constructor. `new Sampler(...)` still
 *    works but is deprecated.
 *  - The **preset** path (`{ preset: { samples: { baseUrl, formats, map }, groups } }`)
 *    builds `` `${baseUrl}/${map[name] ?? name}.${format}` `` — it appends the extension
 *    itself, which is why §9.1 manifests carry extension-less sample names. The flat
 *    `buffers` path has no `baseUrl` and no format negotiation at all.
 *  - `start()` defaults `stopId` to the note number, so two overlapping C4s would choke
 *    each other. Every call here passes the `NoteId` as an explicit `stopId`.
 *  - The returned `StopFn` is `(time?: number) => void`. Handing it an object throws.
 *
 * And one design trap: kits load as a `Sampler` keyed by real GM numbers, **never**
 * `DrumMachine`, which maps `midi = 36 + indexInSamplesArray` and would silently play
 * the wrong piece for every row (§9.2).
 *
 * Loading is lazy per instrument, off the main thread (fetch + `decodeAudioData`), and
 * every instrument shares one `SampleLoader` built over `CacheStorage()` — so a second
 * layer on the same instrument, and every later reload of the app, is instant (§8.2).
 */

/** §8.2's attack-clipping fix: `currentTime` is already in the past for the next render quantum. */
export const AUDITION_LEAD_SECONDS = 0.005

/** §8.2's ~3 ms attack, applied on the audition path only (see `Entry.audition`). */
export const AUDITION_AMP_ATTACK_SECONDS = 0.003

/** Cache bucket name; bump to invalidate every cached sample at once. */
const CACHE_NAME = 'go-instruments-v1'

const MIDI_MAX = 127

/** Doing nothing is the honest answer for a note whose instrument has not loaded yet. */
const NOOP_STOP: StopFn = () => {}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

/** A snapshot for the §12/M6 load-progress UI. Plain data, safe to put in a store. */
export type InstrumentStatus = {
  readonly id: string
  readonly state: LoadState
  /** Samples decoded so far, and how many there are. `total` is known before fetching starts. */
  readonly loaded: number
  readonly total: number
  readonly error?: Error
}

/** Aggregate across every instrument the pool has been asked for. */
export type PoolProgress = {
  readonly loaded: number
  readonly total: number
  /** How many instruments are still loading. Zero means the pool is quiet. */
  readonly pending: number
}

export type ProgressListener = (status: InstrumentStatus) => void

export type Unsubscribe = () => void

export type InstrumentPoolOptions = {
  /** Injection seam for tests and for pointing at a CDN instead of `/instruments`. */
  readonly fetchManifest?: (id: string) => Promise<InstrumentManifest>
  /** Where instrument output lands. Defaults to `context.destination` at attach time. */
  readonly destination?: AudioNode
}

export type InstrumentPool = VoiceSink & {
  /**
   * Give the pool its `AudioContext`. Idempotent, and safe to call after instruments
   * have already been requested — anything queued before the first user gesture starts
   * loading here (§8.2).
   */
  attach(context: BaseAudioContext): void
  readonly context: BaseAudioContext | undefined

  /** Start loading `id` if it is not already loading. Resolves when it can play. */
  ready(id: string): Promise<void>
  /** The parsed manifest, once loaded. `undefined` while loading or on failure. */
  manifest(id: string): InstrumentManifest | undefined
  status(id: string): InstrumentStatus
  statuses(): readonly InstrumentStatus[]
  progress(): PoolProgress
  /** Fires on every state or byte-count change; returns its own unsubscribe. */
  subscribe(listener: ProgressListener): Unsubscribe

  /** Route a layer to an instrument. Loading starts immediately. */
  bindLayer(layerId: LayerId, instrumentId: string): void
  unbindLayer(layerId: LayerId): void
  instrumentFor(layerId: LayerId): string | undefined

  /** Instant, click-free mute of everything already committed to the graph. */
  setLayerMuted(layerId: LayerId, muted: boolean): void
  /** Linear gain, 0–1. Independent of mute; mute wins while it is on. */
  setLayerGain(layerId: LayerId, gain: number): void

  /** §8.2's placement feedback. Silent (and harmless) until the instrument is loaded. */
  audition(instrumentId: string, pitch: number, velocity: number): StopFn

  dispose(): void
}

// ---------------------------------------------------------------------------
// Manifest → smplr preset
// ---------------------------------------------------------------------------

/**
 * Spread sampled pitches across key ranges, exactly as smplr's own flat-record path
 * does: each sample owns the semitones up to the midpoint of the gap to its neighbour,
 * and the outermost samples own everything beyond. Reproduced here rather than reached
 * for because `samplerToPreset` is internal to the flat `buffers` mode, which §9.1 does
 * not use.
 */
function spreadRegions(samples: ReadonlyMap<number, string>): SmplrRegion[] {
  const sorted = [...samples.entries()].sort((a, b) => a[0] - b[0])
  return sorted.map(([midi, sample], i) => {
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const low = prev === undefined ? 0 : Math.floor((prev[0] + midi) / 2) + 1
    const high = next === undefined ? MIDI_MAX : Math.floor((midi + next[0]) / 2)
    // `pitch` is the sample's own key: smplr detunes by `midi - pitch` semitones.
    return { sample, keyRange: [low, high], pitch: midi }
  })
}

/**
 * A §9.1/§9.2 manifest as an `SmplrPreset`.
 *
 * Kit regions use `key` rather than `keyRange`, which pins keyLow = keyHigh = pitch:
 * a drum row plays its own sample at its own speed and nothing else. That is what makes
 * §9.3's "pitch stays a real GM MIDI number internally" true all the way down.
 *
 * `samples.map` is left out: our sample names *are* the file basenames, so the loader's
 * `map[name] ?? name` fallback is already the identity.
 */
export function manifestToPreset(manifest: InstrumentManifest, ampAttack?: number): SmplrPreset {
  const regions: SmplrRegion[] = isKit(manifest)
    ? manifest.pieces.map((piece) => ({ sample: piece.sample, key: piece.midi }))
    : spreadRegions(manifest.samples)

  const preset: SmplrPreset = {
    meta: { name: manifest.name },
    samples: { baseUrl: manifest.baseUrl, formats: [...manifest.formats] },
    groups: [{ regions }],
  }
  return ampAttack === undefined ? preset : { ...preset, defaults: { ampAttack } }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

type Entry = {
  readonly id: string
  state: LoadState
  loaded: number
  total: number
  error: Error | undefined
  manifest: InstrumentManifest | undefined
  /**
   * The instrument's own fader. §8.2's mute has to be instant, and the ≤100 ms already
   * committed to the graph cannot be un-scheduled — only turned down.
   *
   * One channel per *instrument id*, and layers are bound to it. §9.4's v1 set is one
   * instrument per layer, so that is one fader per layer; two layers sharing an
   * instrument would share a fader, and splitting them means one `Sampler` per layer
   * (cheap — the shared loader makes the second load a cache hit) rather than a change
   * of topology here.
   */
  gain: GainNode | undefined
  sampler: Sampler | undefined
  /** A second `Sampler` over the same (already cached) buffers, with §8.2's audition attack. */
  audition: Sampler | undefined
  muted: boolean
  volume: number
  /** Resolves when `sampler` can play; rejects only if the manifest or samples fail. */
  readonly ready: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
  /** Set once `attach` (or the constructor, if already attached) has kicked the load off. */
  started: boolean
}

export function createInstrumentPool(options: InstrumentPoolOptions = {}): InstrumentPool {
  const fetchManifest = options.fetchManifest ?? ((id: string) => loadManifest(id))

  const entries = new Map<string, Entry>()
  const layerInstrument = new Map<LayerId, string>()
  const listeners = new Set<ProgressListener>()

  let context: BaseAudioContext | undefined
  let master: GainNode | undefined
  let loader: SmplrSampleLoader | undefined
  let auditionSeq = 0
  let disposed = false

  const snapshot = (entry: Entry): InstrumentStatus => {
    const base = { id: entry.id, state: entry.state, loaded: entry.loaded, total: entry.total }
    return entry.error === undefined ? base : { ...base, error: entry.error }
  }

  const notify = (entry: Entry): void => {
    const status = snapshot(entry)
    for (const listener of listeners) listener(status)
  }

  const entryFor = (id: string): Entry => {
    const existing = entries.get(id)
    if (existing !== undefined) return existing

    let resolve: () => void = () => {}
    let reject: (err: Error) => void = () => {}
    const ready = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Nothing may reject before a caller has awaited `ready` — an instrument that fails
    // to load must not take the tab down with an unhandled rejection.
    ready.catch(() => {})

    const entry: Entry = {
      id,
      state: 'idle',
      loaded: 0,
      total: 0,
      error: undefined,
      manifest: undefined,
      gain: undefined,
      sampler: undefined,
      audition: undefined,
      muted: false,
      volume: 1,
      ready,
      resolve,
      reject,
      started: false,
    }
    entries.set(id, entry)
    return entry
  }

  /** The fader, created on demand so an entry requested before `attach` costs no nodes. */
  const gainFor = (entry: Entry, ctx: BaseAudioContext): GainNode => {
    if (entry.gain === undefined) {
      const node = ctx.createGain()
      node.gain.value = entry.muted ? 0 : entry.volume
      node.connect(master ?? ctx.destination)
      entry.gain = node
    }
    return entry.gain
  }

  /**
   * The audition voice: the same buffers with §8.2's ~3 ms attack.
   *
   * smplr's `NoteEvent` has no per-note `ampAttack` (only `ampRelease`), so "on the
   * audition path only" cannot be expressed as a start option — it has to be a second
   * instrument whose preset defaults carry it. Built *after* the main sampler is ready
   * so its load is a `SampleLoader` cache hit rather than a duplicate fetch; until then
   * `audition()` falls back to the main sampler, which merely lacks the attack ramp.
   */
  const buildAuditionSampler = (entry: Entry, ctx: BaseAudioContext, manifest: InstrumentManifest): void => {
    if (disposed || entry.audition !== undefined) return
    const sampler = Sampler(ctx, {
      preset: manifestToPreset(manifest, AUDITION_AMP_ATTACK_SECONDS),
      destination: gainFor(entry, ctx),
      ...(loader === undefined ? {} : { loader }),
    })
    entry.audition = sampler
    sampler.ready.catch(() => {
      // The main sampler already covers auditions; a failure here is not worth surfacing.
      entry.audition = undefined
    })
  }

  /** Fetch the manifest, build the `Sampler`, and report progress. Runs once per entry. */
  const startLoad = (entry: Entry, ctx: BaseAudioContext): void => {
    if (entry.started) return
    entry.started = true
    entry.state = 'loading'
    entry.error = undefined
    notify(entry)

    void (async (): Promise<void> => {
      try {
        const manifest = entry.manifest ?? (await fetchManifest(entry.id))
        if (disposed) return
        entry.manifest = manifest

        const sampler = Sampler(ctx, {
          preset: manifestToPreset(manifest),
          destination: gainFor(entry, ctx),
          // The shared loader carries the storage; a `storage` option would be ignored
          // whenever a `loader` is supplied (smplr uses one or the other, not both).
          ...(loader === undefined ? { storage: CacheStorage(CACHE_NAME) } : { loader }),
          onLoadProgress: (progress) => {
            entry.loaded = progress.loaded
            entry.total = progress.total
            notify(entry)
          },
        })
        entry.sampler = sampler

        await sampler.ready
        if (disposed) return
        entry.state = 'ready'
        notify(entry)
        entry.resolve()
        buildAuditionSampler(entry, ctx, manifest)
      } catch (err) {
        if (disposed) return
        const error = err instanceof Error ? err : new Error(String(err))
        entry.state = 'error'
        entry.error = error
        notify(entry)
        entry.reject(error)
      }
    })()
  }

  const ensure = (id: string): Entry => {
    const entry = entryFor(id)
    // Before the first user gesture there is no context and nothing to load into; the
    // entry simply waits, and `attach` starts it (§8.2).
    if (context !== undefined) startLoad(entry, context)
    return entry
  }

  const applyGain = (entry: Entry): void => {
    if (entry.gain === undefined || context === undefined) return
    const target = entry.muted ? 0 : entry.volume
    // A short ramp rather than a step: an instant jump on a sounding voice clicks.
    const now = context.currentTime
    entry.gain.gain.cancelScheduledValues(now)
    entry.gain.gain.setTargetAtTime(target, now, 0.005)
  }

  const entryForLayer = (layerId: LayerId): Entry | undefined => {
    const id = layerInstrument.get(layerId)
    return id === undefined ? undefined : entries.get(id)
  }

  const clampVelocity = (velocity: number): number => {
    if (!Number.isFinite(velocity)) return 0
    return Math.max(0, Math.min(MIDI_MAX, Math.round(velocity)))
  }

  return {
    attach(ctx: BaseAudioContext): void {
      if (disposed || context !== undefined) return
      context = ctx
      master = ctx.createGain()
      master.connect(options.destination ?? ctx.destination)
      // One loader, one CacheStorage, shared by every instrument (§8.2) — so a sample
      // fetched for one instrument, or on a previous visit, is never fetched twice.
      loader = SampleLoader(ctx, { storage: CacheStorage(CACHE_NAME) })
      for (const entry of entries.values()) startLoad(entry, ctx)
    },

    get context(): BaseAudioContext | undefined {
      return context
    },

    ready(id: string): Promise<void> {
      return ensure(id).ready
    },

    manifest(id: string): InstrumentManifest | undefined {
      return entries.get(id)?.manifest
    },

    status(id: string): InstrumentStatus {
      const entry = entries.get(id)
      return entry === undefined
        ? { id, state: 'idle', loaded: 0, total: 0 }
        : snapshot(entry)
    },

    statuses(): readonly InstrumentStatus[] {
      return [...entries.values()].map(snapshot)
    },

    progress(): PoolProgress {
      let loaded = 0
      let total = 0
      let pending = 0
      for (const entry of entries.values()) {
        loaded += entry.loaded
        total += entry.total
        if (entry.state === 'loading') pending++
      }
      return { loaded, total, pending }
    },

    subscribe(listener: ProgressListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    bindLayer(layerId: LayerId, instrumentId: string): void {
      layerInstrument.set(layerId, instrumentId)
      ensure(instrumentId)
    },

    unbindLayer(layerId: LayerId): void {
      layerInstrument.delete(layerId)
    },

    instrumentFor(layerId: LayerId): string | undefined {
      return layerInstrument.get(layerId)
    },

    setLayerMuted(layerId: LayerId, muted: boolean): void {
      const entry = entryForLayer(layerId)
      if (entry === undefined) return
      entry.muted = muted
      applyGain(entry)
    },

    setLayerGain(layerId: LayerId, gain: number): void {
      const entry = entryForLayer(layerId)
      if (entry === undefined) return
      entry.volume = Math.max(0, Math.min(1, gain))
      applyGain(entry)
    },

    /**
     * §8.1's `VoiceSink`. Never throws and never awaits: the scheduler calls this from a
     * 25 ms tick and a missing instrument must cost a silent note, not a dropped tick.
     */
    start(request: VoiceRequest): StopFn {
      if (disposed) return NOOP_STOP
      const entry = entryForLayer(request.layerId)
      if (entry === undefined || entry.sampler === undefined || entry.manifest === undefined) {
        return NOOP_STOP
      }

      const event: NoteEvent = {
        note: request.pitch,
        velocity: clampVelocity(request.velocity),
        time: request.time,
        // Mandatory: smplr would otherwise default it to the note number, and one C4
        // stopping every sounding C4 is the common case on a grid, not an edge case.
        stopId: request.stopId,
        // Kits are one-shots (§9.3): a grid duration would chop the tail off a crash.
        // Pitched notes get their tempo-map-exact, loop-truncated length.
        ...(isKit(entry.manifest) ? {} : { duration: request.duration }),
      }

      try {
        // smplr's StopFn is `(time?: number) => void`; the scheduler calls it with no
        // arguments, which stops immediately. Passing an object here would throw.
        return entry.sampler.start(event)
      } catch {
        return NOOP_STOP
      }
    },

    audition(instrumentId: string, pitch: number, velocity: number): StopFn {
      if (disposed) return NOOP_STOP
      const entry = ensure(instrumentId)
      const sampler = entry.audition ?? entry.sampler
      if (sampler === undefined || context === undefined) return NOOP_STOP
      try {
        return sampler.start({
          note: pitch,
          velocity: clampVelocity(velocity),
          // §8.2: firing at exactly `currentTime` is already in the past for the next
          // render quantum, so the attack transient is clipped and reads as a click.
          time: context.currentTime + AUDITION_LEAD_SECONDS,
          stopId: `audition:${auditionSeq++}`,
        })
      } catch {
        return NOOP_STOP
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const entry of entries.values()) {
        entry.sampler?.dispose()
        entry.audition?.dispose()
        entry.gain?.disconnect()
      }
      master?.disconnect()
      entries.clear()
      layerInstrument.clear()
      listeners.clear()
      master = undefined
      loader = undefined
      context = undefined
    },
  }
}
