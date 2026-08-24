import type { LayerId, Note, NoteId, Pos } from '../core/types'
import type { TempoMap } from '../core/tempo'
import type { CreateTicker, Ticker } from './workerTimer'
import { lowerBoundByPos } from '../core/noteIndex'
import { ORIGIN, cmp as pcmp } from '../core/pos'
import { durationSeconds, secondsToPos, toSeconds } from '../core/tempo'
import { createTicker as createWorkerTicker } from './workerTimer'

/**
 * The lookahead scheduler. See go-spec.md §8.1.
 *
 * Chris Wilson's "A Tale of Two Clocks": a coarse timer (§8.1's worker ticker) wakes us
 * every 25 ms, and each wake commits every onset falling in `[now, now + 0.1 s)` to the
 * audio graph with an exact `time`. Nothing here ever plays a note "now" — it only
 * books the future, which is why timer jitter is inaudible.
 *
 * Everything the scheduler touches is injected: the clock (`AudioContext.currentTime`),
 * the ticker, and a `VoiceSink`. No `AudioContext`, no smplr, no DOM — so the whole
 * engine runs headlessly against a fake clock that a test steps by hand, and the
 * assertions are on exact onset seconds rather than on whether something was audible.
 *
 * Two invariants carry most of the correctness:
 *
 *  - **The per-layer cursor is a `Pos`, not an array index.** Editing during playback is
 *    a first-class gesture (§7), and `notesByLayer` is a sorted array that splices:
 *    inserting before an index shifts every later element (the note under the cursor
 *    fires twice) and deleting the element at the index skips the next one. A `Pos`
 *    cursor plus a binary search per tick is O(log n) — free at 25 ms — and immune to
 *    both.
 *  - **Ids scheduled at the cursor position are remembered.** The cursor alone cannot
 *    separate "already committed" from "newly inserted" among notes sharing one instant
 *    (a chord), so a note already handed to the audio graph can never be re-fired.
 */

/** Called to release a sounding voice early. Returned by `VoiceSink.start`. */
export type StopFn = () => void

/**
 * One scheduled note, in absolute `AudioContext` seconds.
 *
 * `stopId` is **mandatory**, not an optimization: smplr defaults it to the note number,
 * so stopping one C4 would stop every sounding C4 — and a repeated pitch on a grid is
 * the common case, not an edge case. `layerId` rides along so the binding can route to
 * that layer's instrument; nothing in this module reads it.
 */
export type VoiceRequest = {
  readonly layerId: LayerId
  readonly pitch: number
  readonly velocity: number
  /** Absolute onset, on the injected clock's timeline. */
  readonly time: number
  /** Elapsed seconds, tempo-map exact and loop-truncated. */
  readonly duration: number
  readonly stopId: NoteId
}

/**
 * What the scheduler needs from an instrument, and all it may assume.
 *
 * The smplr binding (a separate module) implements this. Deliberately not
 * `instrument.stop()`: smplr runs its own 200 ms internal lookahead and notes queued
 * beyond it are not drained by `stop()`, so this interface makes the per-voice stop
 * handle the only way to silence anything.
 */
export type VoiceSink = {
  start(request: VoiceRequest): StopFn
}

/** The `Layer` fields velocity resolution reads (§6.1). A full §4 `Layer` satisfies it. */
export type VelocityLayer = {
  readonly defaultVel: number
  readonly colVel: ReadonlyMap<number, number>
}

/** The `Layer` fields the scheduler reads. A full §4 `Layer` satisfies it. */
export type SchedulerLayer = VelocityLayer & {
  readonly id: LayerId
  /** `false` = muted. Muted layers are skipped entirely — not scheduled silently. */
  readonly audible: boolean
}

/** `end` is **exclusive** (§8.1). */
export type LoopRegion = { readonly start: Pos; readonly end: Pos }

export type SchedulerOptions = {
  /** `AudioContext.currentTime`, or a fake clock in tests. */
  readonly now: () => number
  readonly voice: VoiceSink
  /**
   * Read fresh each tick. Tempo is not editable in v1, which is also what makes the
   * per-pass loop length a constant (§8.1) — revisit both together.
   */
  readonly tempoMap: () => TempoMap
  /** Read fresh each tick, so mute/unmute during playback takes effect immediately. */
  readonly layers: () => readonly SchedulerLayer[]
  /** The live, `pos`-sorted `notesByLayer` array for a layer (§4.1). May be edited mid-playback. */
  readonly notes: (layerId: LayerId) => readonly Note[]
  /** Read fresh each tick. `undefined`, or a degenerate region, means no looping. */
  readonly loop?: () => LoopRegion | undefined
  /** `outputLatency + baseLatency`, plus the user's offset (§8.1). Only affects `currentPos`. */
  readonly outputLatency?: number
  /** Injected for tests; defaults to the worker-backed ticker. */
  readonly createTicker?: CreateTicker
  readonly lookaheadSeconds?: number
  readonly tickIntervalMs?: number
}

export type Scheduler = {
  readonly isPlaying: boolean
  /** Start from `fromPos`, or from the last `seek`/`play` position. */
  play(fromPos?: Pos): void
  /** Halt the ticker and release **every** voice this run started. */
  stop(): void
  /** Move the playhead; rebuilds the cursors by binary search. Safe while playing. */
  seek(to: Pos): void
  /** The playhead position for `nowSeconds`, latency-compensated. */
  currentPos(nowSeconds: number): Pos
  /** Update the latency compensation without restarting playback. */
  setOutputLatency(seconds: number): void
  /** Stop and release the ticker. */
  dispose(): void
}

/** §8.1's window: every onset inside `[now, now + this)` is committed on each tick. */
export const LOOKAHEAD_SECONDS = 0.1

/** §8.1's tick period. Four ticks per lookahead window, so a missed tick is survivable. */
export const TICK_INTERVAL_MS = 25

/**
 * Effective velocity (§6.1): `note.vel` → `layer.colVel[col]` → `layer.defaultVel`.
 *
 * Pure and standalone because the velocity lane (M5) resolves the same three levels to
 * draw its bars and its ghost bars, and a second implementation there would drift.
 *
 * Resolved at *schedule* time, which is why a `colVel` edit cannot alter the ≤100 ms
 * already committed to the graph — correct behaviour, not a compromise.
 */
export function effectiveVelocity(note: Note, layer: VelocityLayer): number {
  return note.vel ?? layer.colVel.get(note.pos.col) ?? layer.defaultVel
}

/** A voice this run started, kept so `stop` can release it (§8.1). */
type LiveVoice = { readonly stop: StopFn; readonly endTime: number }

/** Per-layer scheduling state. */
type Cursor = {
  /**
   * The next position to schedule from. Everything strictly before it is committed;
   * at exactly this position, `done` says which ids are.
   */
  pos: Pos
  /** Ids already committed *at* `pos` — the chord case. Cleared when `pos` advances. */
  done: Set<NoteId>
  /**
   * Clock reading at which this cursor joined a pass already in progress — a layer
   * unmuted or added mid-playback. Onsets earlier than this are stepped over rather
   * than fired late; `undefined` once the cursor has caught up.
   */
  joinedAt: number | undefined
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const lookahead = options.lookaheadSeconds ?? LOOKAHEAD_SECONDS
  const tickMs = options.tickIntervalMs ?? TICK_INTERVAL_MS
  const makeTicker = options.createTicker ?? createWorkerTicker

  let outputLatency = options.outputLatency ?? 0
  let playing = false
  /** Where `play` (or the last `seek`) put the playhead. */
  let anchor: Pos = ORIGIN
  /**
   * `audioTime = toSeconds(pos) + timeOffset` for the pass currently being scheduled.
   * A loop wrap advances it by one loop length; `baseOffset` keeps the first pass's
   * value, which is what `currentPos` inverts against.
   */
  let timeOffset = 0
  let baseOffset = 0
  /** Where a lazily-seeded cursor starts: the play/seek anchor, or the loop start after a wrap. */
  let cursorAnchor: Pos = anchor
  const cursors = new Map<LayerId, Cursor>()
  const voices: LiveVoice[] = []

  const ticker: Ticker = makeTicker(tickMs, () => {
    tick()
  })

  /** The loop region, or `undefined` when absent or degenerate (§8.1's spin guard). */
  const activeLoop = (map: TempoMap): { region: LoopRegion; startSec: number; endSec: number; length: number } | undefined => {
    const region = options.loop?.()
    if (region === undefined) return undefined
    // A zero-length or inverted region would make the `while` below spin forever.
    if (pcmp(region.start, region.end) >= 0) return undefined
    const startSec = toSeconds(map, region.start)
    const endSec = toSeconds(map, region.end)
    const length = endSec - startSec
    if (!(length > 0)) return undefined
    return { region, startSec, endSec, length }
  }

  /**
   * Drop every cursor and re-seed at `to`.
   *
   * Seeding is lazy so that a layer added (or unmuted) mid-playback picks up the
   * current pass's start rather than being missed until the next wrap.
   */
  const resetCursors = (to: Pos): void => {
    cursors.clear()
    cursorAnchor = to
  }

  /** `joinedAt` is only set for a cursor created after this pass's start (see `Cursor`). */
  const cursorFor = (layerId: LayerId, now: number): Cursor => {
    let cursor = cursors.get(layerId)
    if (cursor === undefined) {
      cursor = { pos: cursorAnchor, done: new Set(), joinedAt: playing ? now : undefined }
      cursors.set(layerId, cursor)
    }
    return cursor
  }

  /**
   * Commit every onset in `[cursor, untilSec)` on every audible layer.
   *
   * Requests are collected and sorted by `time` before they reach the sink, so a chord
   * spread over several layers arrives in time order rather than layer order.
   */
  const schedulePass = (map: TempoMap, now: number, untilSec: number, loopEnd: Pos | undefined): void => {
    const batch: { request: VoiceRequest; order: number }[] = []
    const layers = options.layers()

    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l]!
      if (!layer.audible) continue

      const notes = options.notes(layer.id)
      const cursor = cursorFor(layer.id, now)

      // The binary search — not a retained index — is what survives an edit mid-tick.
      for (let i = lowerBoundByPos(notes, cursor.pos); i < notes.length; i++) {
        const note = notes[i]!
        // `loop.end` is exclusive: an onset exactly on it belongs to the next pass.
        if (loopEnd !== undefined && pcmp(note.pos, loopEnd) >= 0) break

        const time = toSeconds(map, note.pos) + timeOffset
        if (time >= untilSec) break

        if (pcmp(note.pos, cursor.pos) > 0) {
          cursor.pos = note.pos
          cursor.done.clear()
        }
        // An edit cannot re-fire what the graph already holds.
        if (cursor.done.has(note.id)) continue
        cursor.done.add(note.id)

        // A layer that joined mid-pass starts at the playhead, not at the pass start.
        if (cursor.joinedAt !== undefined && time < cursor.joinedAt) continue

        let duration = durationSeconds(map, note.pos, note.dur)
        if (loopEnd !== undefined) {
          // A note whose tail crosses the loop point is truncated at it (§8.1).
          const room = toSeconds(map, loopEnd) - toSeconds(map, note.pos)
          if (duration > room) duration = room
        }
        if (duration < 0) duration = 0

        batch.push({
          order: l,
          request: {
            layerId: layer.id,
            pitch: note.pitch,
            velocity: effectiveVelocity(note, layer),
            time,
            duration,
            stopId: note.id,
          },
        })
      }
      cursor.joinedAt = undefined
    }

    batch.sort((a, b) => a.request.time - b.request.time || a.order - b.order)
    for (const entry of batch) {
      voices.push({
        stop: options.voice.start(entry.request),
        endTime: entry.request.time + entry.request.duration,
      })
    }
  }

  /**
   * Drop stop handles for voices that have already finished.
   *
   * Retaining every handle for the length of a session is what §8.1 asks for, but a
   * voice whose tail is in the past cannot be stopped in any meaningful sense, so
   * dropping it changes nothing audible and keeps the array bounded.
   */
  const pruneVoices = (now: number): void => {
    let keep = 0
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i]!
      if (voice.endTime > now) voices[keep++] = voice
    }
    voices.length = keep
  }

  const tick = (): void => {
    if (!playing) return
    const now = options.now()
    const windowEnd = now + lookahead
    const map = options.tempoMap()
    pruneVoices(now)

    const loop = activeLoop(map)
    if (loop === undefined) {
      schedulePass(map, now, windowEnd, undefined)
      return
    }

    // Passes that ended before `now` are unreachable — a starved tick, or a seek to
    // somewhere past `loop.end`. Skipping them arithmetically keeps the `while` below
    // from grinding through thousands of empty passes to reach the present.
    const behind = now - (loop.endSec + timeOffset)
    if (behind > 0) {
      timeOffset += (Math.floor(behind / loop.length) + 1) * loop.length
      resetCursors(loop.region.start)
    }

    // A `while`, not an `if`: a loop shorter than the lookahead must emit several
    // passes in one tick. `loop.length > 0` is what guarantees this terminates.
    while (windowEnd > loop.endSec + timeOffset) {
      schedulePass(map, now, loop.endSec + timeOffset, loop.region.end)
      resetCursors(loop.region.start)
      timeOffset += loop.length
    }
    schedulePass(map, now, windowEnd, loop.region.end)
  }

  /** Release every retained handle. Never `instrument.stop()` — see `VoiceSink`. */
  const releaseVoices = (): void => {
    for (const voice of voices) voice.stop()
    voices.length = 0
  }

  const play = (fromPos?: Pos): void => {
    if (playing) stop()
    if (fromPos !== undefined) anchor = fromPos
    const map = options.tempoMap()
    timeOffset = options.now() - toSeconds(map, anchor)
    baseOffset = timeOffset
    resetCursors(anchor)
    playing = true
    // Fill the first window now rather than 25 ms from now, or the opening note of a
    // piece is already behind the lookahead by the time the first tick lands.
    tick()
    ticker.start()
  }

  const stop = (): void => {
    playing = false
    ticker.stop()
    releaseVoices()
    // The anchor is left where playback started, so stop -> play repeats the same
    // passage. Moving the playhead is `seek`'s job, not `stop`'s.
    resetCursors(anchor)
    timeOffset = baseOffset
  }

  const seek = (to: Pos): void => {
    anchor = to
    if (!playing) {
      resetCursors(to)
      return
    }
    // Whatever is sounding belongs to the old position.
    releaseVoices()
    const map = options.tempoMap()
    timeOffset = options.now() - toSeconds(map, to)
    baseOffset = timeOffset
    resetCursors(to)
    tick()
  }

  /**
   * The playhead, inverted from the clock — never from timer callbacks (§8.1).
   *
   * `nowSeconds` is what the graph has *rendered*, not what is audible, so the output
   * latency comes off first; without it the playhead leads the sound by tens of ms on
   * speakers and 100–300 ms over Bluetooth.
   *
   * The loop wrap is undone arithmetically rather than by reading `timeOffset`, because
   * `timeOffset` has already advanced into the passes being *scheduled* — up to 100 ms
   * (and a whole extra pass, on a short loop) ahead of what is being heard.
   */
  const currentPos = (nowSeconds: number): Pos => {
    if (!playing) return anchor
    const map = options.tempoMap()
    const t = nowSeconds - outputLatency
    let seconds = t - baseOffset

    const loop = activeLoop(map)
    if (loop !== undefined && seconds >= loop.endSec) {
      const passes = Math.floor((seconds - loop.endSec) / loop.length) + 1
      seconds -= passes * loop.length
      // Playback that began before `loop.start` has a first pass longer than the loop;
      // the subtraction can then undershoot.
      if (seconds < loop.startSec) seconds = loop.startSec
    }
    return secondsToPos(map, seconds)
  }

  return {
    get isPlaying(): boolean {
      return playing
    },
    play,
    stop,
    seek,
    currentPos,
    setOutputLatency: (seconds: number): void => {
      outputLatency = seconds
    },
    dispose: (): void => {
      stop()
      ticker.dispose()
    },
  }
}
