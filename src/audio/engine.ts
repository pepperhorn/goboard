import type { VoiceSink } from './scheduler'
import type { InstrumentPool, InstrumentPoolOptions } from './instruments'
import { createInstrumentPool } from './instruments'

/**
 * The audio facade the UI talks to. See go-spec.md §8.1 and §8.2.
 *
 * Thin on purpose: it owns the `AudioContext` lifecycle and the latency number, and
 * delegates everything else. Two things live here because nothing else may own them.
 *
 * **The context is created on the first user gesture, not at import.** A context built
 * before a gesture starts `suspended` and stays that way, so notes would be scheduled
 * against a clock that is not running — silence with no error. Because that is
 * unavoidable, the transport shows an explicit "click to enable audio" state (§8.2)
 * rather than failing quietly; `isUnlocked()` is what it reads. The pool exists before
 * the gesture and queues whatever the project asks for, so `unlock()` is also when
 * loading starts.
 *
 * **`outputLatency()` is what the playhead subtracts.** `AudioContext.currentTime` is
 * what the graph has *rendered*, not what has reached the speakers; without the
 * correction the playhead leads the sound by tens of ms on speakers and 100–300 ms over
 * Bluetooth (§8.1). `outputLatency` is absent in Safari (and in older Firefox), hence
 * the feature detection rather than a bare `??`.
 */

export type Engine = {
  /**
   * Create and resume the `AudioContext`, then hand it to the pool. Call from a real
   * user gesture. Idempotent, and safe to call again after the browser has suspended
   * the context (tab backgrounded, device change) — it resumes rather than rebuilds.
   */
  unlock(): Promise<AudioContext>
  readonly pool: InstrumentPool
  /** Pass this to `createScheduler({ voice })`. Valid before `unlock`; silent until it. */
  readonly sink: VoiceSink
  /**
   * Seconds between `currentTime` and audibility: `(outputLatency ?? 0) + baseLatency`.
   * `0` before unlock. Add the user's tunable offset (§8.1) on top of this — no formula
   * beats letting them nudge it.
   */
  outputLatency(): number
  /** `AudioContext.currentTime`, or `0` before unlock. Pass as the scheduler's `now`. */
  now(): number
  readonly context: AudioContext | undefined
  isUnlocked(): boolean
  dispose(): void
}

export type EngineOptions = InstrumentPoolOptions & {
  /** Injection seam for tests; defaults to the global `AudioContext`. */
  readonly createContext?: () => AudioContext
}

function defaultCreateContext(): AudioContext {
  // §8.2: 'interactive' asks for the smallest buffer the device will give us. The
  // alternative, 'playback', trades latency for battery and would put ~200 ms between
  // a click and its audition.
  return new AudioContext({ latencyHint: 'interactive' })
}

export function createEngine(options: EngineOptions = {}): Engine {
  const { createContext = defaultCreateContext, ...poolOptions } = options
  const pool = createInstrumentPool(poolOptions)

  let context: AudioContext | undefined
  let disposed = false

  return {
    async unlock(): Promise<AudioContext> {
      if (disposed) throw new Error('Engine: cannot unlock a disposed engine')
      if (context === undefined) {
        context = createContext()
        pool.attach(context)
      }
      // Chrome hands back a `suspended` context whenever the gesture requirement was
      // not met, and suspends a running one when the tab is backgrounded.
      if (context.state !== 'running') await context.resume()
      return context
    },

    pool,
    sink: pool,

    outputLatency(): number {
      if (context === undefined) return 0
      // Both properties are optional in practice: `outputLatency` is missing in Safari,
      // and `baseLatency` has been missing in older WebKit builds.
      const output = typeof context.outputLatency === 'number' ? context.outputLatency : 0
      const base = typeof context.baseLatency === 'number' ? context.baseLatency : 0
      const total = output + base
      return Number.isFinite(total) ? total : 0
    },

    now(): number {
      return context?.currentTime ?? 0
    },

    get context(): AudioContext | undefined {
      return context
    },

    isUnlocked(): boolean {
      return context !== undefined && context.state === 'running'
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      pool.dispose()
      void context?.close()
      context = undefined
    },
  }
}
