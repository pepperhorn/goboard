import { Midi } from '@tonejs/midi'
import type { Layer, Note, Pos, Project } from '../core/types'
import { gcd, lcm } from '../core/frac'
import { add as posAdd } from '../core/pos'
import { effectiveVelocity } from '../audio/scheduler'
import type { InstrumentManifest } from '../audio/manifest'
import { isKit } from '../audio/manifest'

/**
 * SMF type 1 export. See go-spec.md §10.
 *
 * The whole file turns on one number, the PPQ, and §10 spends its length on why:
 *
 * - **The ceiling is 32767, not 960.** SMF division is a 16-bit field whose bit 15
 *   selects SMPTE timing, so the largest legal tick-per-quarter is `0x7FFF`. 960 is a
 *   convention, and a bad one here: 960 = 2^6·3·5 is exact for none of the app's
 *   headline tuplets — a plain 9-tuplet already isn't.
 * - **Pick the PPQ from the project, not from a constant.** `L`, the lcm of every
 *   denominator in the file, is what exactness requires the PPQ to be a multiple of.
 *   A project mixing 16ths, triplets, 11s and 13s has `L = 6864` and exports exactly.
 * - **Round absolute ticks, then difference them.** Rounding deltas lets a 0.45-tick
 *   error accumulate — about half a quarter note over 1000 events. Absolute rounding
 *   bounds the error at half a tick forever. (`@tonejs/midi` takes absolute ticks and
 *   computes the deltas itself, so this is a matter of what we hand it: an exact
 *   `col*ppq + n*(ppq/d)` whenever `d` divides the PPQ, and a rounded product only
 *   when it does not.)
 *
 * Quantization at export is the sole place in the app where it is permitted, and it
 * lands in duration rather than onset: at a too-small PPQ the shortest legal slot
 * (1/256 quarter) rounds by ~7%, while the onset moves by a quarter of a millisecond.
 */

/** SMF's division field is 16-bit with bit 15 reserved for SMPTE timing. */
export const MAX_PPQ = 32767

/**
 * §10's fallback when no divisor of `L` fits: 2^5·3^3·5·7. Exact for every split the
 * app allows except 11 and 13.
 */
export const FALLBACK_PPQ = 30240

/**
 * The primes the §3.1 denominator lattice is built from. A denominator outside them is
 * unreachable through the editor, but an imported file could still carry one, so the
 * factorization below reports the leftover rather than assuming it away.
 */
const LATTICE_PRIMES = [2, 3, 5, 7, 11, 13] as const

/** Slowest tempo an SMF can express: µs-per-quarter is a 24-bit field. */
export const MIDI_MIN_BPM = 60_000_000 / 0xff_ff_ff

export type PpqChoice = {
  readonly ppq: number
  /** `lcm` of every denominator in the project — what exactness needs `ppq` to divide by. */
  readonly lcm: number
  /** True when `lcm` divides `ppq`, i.e. every onset and duration lands on a tick. */
  readonly exact: boolean
}

export type MidiExportOptions = {
  /** Defaults to `chooseTicksPerQuarter(project).ppq`. Clamped to 1…32767. */
  readonly ppq?: number
  /**
   * Manifests by instrument id, for the program change and the channel-10 rule (§10).
   * Absent entries fall back to the layer's own `channel` and program 0.
   */
  readonly instruments?: ReadonlyMap<string, InstrumentManifest>
  /**
   * Whether muted layers export. Default `true`: mute is a monitoring state, and a
   * silent track still carries the notes the user wrote.
   */
  readonly includeMuted?: boolean
}

// ---------------------------------------------------------------------------
// PPQ selection
// ---------------------------------------------------------------------------

/**
 * Every denominator that has to divide the PPQ for the export to be exact: onsets,
 * durations, the ends they add up to, and the tempo positions.
 *
 * The ends matter independently. A note at 1/3 lasting 1/4 ends at 7/12, and a PPQ
 * exact for both 3 and 4 is exact for 12 anyway — but the lcm is taken over the ends
 * too, because `dur` alone cannot show that a *tempo* landed mid-note.
 */
function denominators(project: Project): number[] {
  const ds: number[] = [1]
  for (const note of project.notes) {
    ds.push(note.pos.frac.d, note.dur.d, posAdd(note.pos, note.dur).frac.d)
  }
  for (const t of project.tempoMap) ds.push(t.pos.frac.d)
  return ds
}

/** Factor over the §3.1 primes. `rest` is what is left when the lattice is escaped. */
function factorize(n: number): { readonly exponents: number[]; readonly rest: number } {
  const exponents: number[] = []
  let rest = n
  for (const p of LATTICE_PRIMES) {
    let e = 0
    while (rest % p === 0) {
      rest /= p
      e++
    }
    exponents.push(e)
  }
  return { exponents, rest }
}

/**
 * The largest divisor of `n` that is `<= MAX_PPQ`, or `undefined` if `n` has a prime
 * factor outside the lattice (in which case its divisors cannot be enumerated cheaply
 * and §10's fallback takes over).
 *
 * Enumerating rather than searching downward from 32767 is what keeps this fast: the
 * lattice bound has 9·5·3·3·3·3 = 3645 divisors, and most projects have far fewer.
 */
function largestDivisorWithin(n: number, limit: number): number | undefined {
  const { exponents, rest } = factorize(n)
  if (rest !== 1) return undefined

  let divisors = [1]
  for (let i = 0; i < LATTICE_PRIMES.length; i++) {
    const p = LATTICE_PRIMES[i]!
    const max = exponents[i]!
    const next: number[] = []
    for (const d of divisors) {
      let v = d
      for (let e = 0; e <= max; e++) {
        if (v > limit) break
        next.push(v)
        v *= p
      }
    }
    divisors = next
  }
  return divisors.reduce((best, d) => (d <= limit && d > best ? d : best), 1)
}

/**
 * §10's PPQ formula. `L <= 32767` is the common case and gets the *largest multiple*
 * of `L` that still fits — exact and at maximum resolution, so the rounding below is
 * a no-op and later editors see clean numbers.
 */
export function chooseTicksPerQuarter(project: Project): PpqChoice {
  const L = denominators(project).reduce((a, b) => lcm(a, b), 1)

  if (L <= MAX_PPQ) {
    const ppq = L * Math.floor(MAX_PPQ / L)
    return { ppq, lcm: L, exact: true }
  }

  // Below this line the PPQ *divides* L instead of being a multiple of it, so nothing
  // is exact — `exact` asks whether every denominator lands on a tick, which needs
  // `L | ppq`, and `L` no longer fits. The flag stays computed rather than hardcoded
  // `false` so the export dialog reads one rule in both branches.
  const divisor = largestDivisorWithin(L, MAX_PPQ)
  const ppq = divisor ?? FALLBACK_PPQ
  return { ppq, lcm: L, exact: ppq % L === 0 }
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

/**
 * Absolute tick for a position. Exact whenever the denominator divides the PPQ, which
 * is the whole point of choosing the PPQ from the project.
 *
 * The exact branch also keeps the arithmetic inside 2^53: `n * ppq` with a lattice-sized
 * denominator would not be, but `n * (ppq / d)` with `n < d` is bounded by the PPQ.
 */
export function tickOf(p: Pos, ppq: number): number {
  const { n, d } = p.frac
  const base = p.col * ppq
  if (n === 0) return base
  if (ppq % d === 0) return base + n * (ppq / d)
  // Reduce before dividing so the ratio stays well inside double precision; the
  // remaining error is ~1e-11 ticks, far from flipping a `round`.
  const g = gcd(ppq, d)
  return base + Math.round((n * (ppq / g)) / (d / g))
}

/**
 * Note velocities are 0–127 in the model but 0–1 in `@tonejs/midi`, which re-quantizes
 * with `Math.floor(velocity * 127)`. A bare `v / 127` loses notes to that floor —
 * `111 / 127 * 127` is `110.99999999999999` — so aim at the middle of the bucket.
 */
function toNormalizedVelocity(vel: number): number {
  const clamped = Math.min(127, Math.max(0, Math.round(vel)))
  return (clamped + 0.5) / 127
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** GM channel 10 (0-indexed 9) is the percussion channel — §10's kit rule. */
const DRUM_CHANNEL = 9

function channelFor(layer: Layer, manifest: InstrumentManifest | undefined): number {
  if (manifest && isKit(manifest)) return DRUM_CHANNEL
  const c = Math.trunc(layer.channel)
  return c >= 0 && c <= 15 ? c : 0
}

function programFor(manifest: InstrumentManifest | undefined): number {
  return manifest && !isKit(manifest) ? manifest.gmProgram : 0
}

/** Notes of one layer, in `ticks` order — the order `addNote` would sort them into anyway. */
function notesOf(project: Project, layerId: string): Note[] {
  return project.notes.filter((n) => n.layerId === layerId)
}

export function exportMidi(project: Project, options: MidiExportOptions = {}): Uint8Array {
  const { instruments, includeMuted = true } = options
  const ppq = Math.min(MAX_PPQ, Math.max(1, Math.trunc(options.ppq ?? chooseTicksPerQuarter(project).ppq)))

  const midi = new Midi()
  midi.header.fromJSON({
    name: project.name,
    ppq,
    meta: [],
    // §10: the µs-per-quarter meta event is a 24-bit field, so a tempo below
    // ~3.5763 BPM would wrap rather than clip. The model's own floor (3.576) is a
    // rounded version of the same bound and sits a hair below it.
    tempos: project.tempoMap.map((t) => ({
      ticks: tickOf(t.pos, ppq),
      bpm: Math.max(MIDI_MIN_BPM, t.bpm),
    })),
    // v1 has no meter (§11), and an empty array here would leave the file without the
    // 4/4 default every DAW assumes anyway. Writing it explicitly costs one event.
    timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    keySignatures: [],
  })

  const layers = [...project.layers]
    .sort((a, b) => a.order - b.order)
    .filter((l) => includeMuted || l.audible)

  for (const layer of layers) {
    const manifest = instruments?.get(layer.instrumentId)
    const track = midi.addTrack()
    track.name = layer.name
    track.channel = channelFor(layer, manifest)
    track.instrument.number = programFor(manifest)

    for (const note of notesOf(project, layer.id)) {
      const startTicks = tickOf(note.pos, ppq)
      const endTicks = tickOf(posAdd(note.pos, note.dur), ppq)
      track.addNote({
        midi: note.pitch,
        ticks: startTicks,
        // Difference of two *rounded absolutes* (§10). A note shorter than a tick still
        // has to sound, so it keeps one — a zero-length note is a dropped note.
        durationTicks: Math.max(1, endTicks - startTicks),
        velocity: toNormalizedVelocity(effectiveVelocity(note, layer)),
      })
    }
  }

  return midi.toArray()
}

/** Suggested filename for a project export, e.g. `My Piece.mid`. */
export function midiFileName(project: Project): string {
  const base = project.name.trim().replace(/[/\\:*?"<>|]/g, '-') || 'Untitled'
  return `${base}.mid`
}

/** Re-exported so the export dialog can show what a chosen PPQ costs. */
export function isExactAt(project: Project, ppq: number): boolean {
  const L = denominators(project).reduce((a: number, b: number) => lcm(a, b), 1)
  return ppq % L === 0
}
