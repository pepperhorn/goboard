/**
 * The scheduler's tick source. See go-spec.md §8.1.
 *
 * The 25 ms interval runs **inside a Web Worker**, and that is not a nicety: a playing
 * tab escapes Chrome's intensive throttling only because it "made noises in the past
 * 30 seconds", so a silent stretch over 30 s — a long rest, a muted passage — or
 * starting playback while the tab is in the background drops a main-thread
 * `setInterval` to one tick per second. A 100 ms lookahead window cannot survive that:
 * every note between ticks is scheduled in the past and never sounds. A worker timer is
 * not throttled the same way, so the tick keeps arriving and the main thread only has
 * to answer it.
 *
 * The worker is built from a Blob URL rather than a separate entry file so there is
 * nothing to register in `vite.config.ts` and nothing to get wrong in a production
 * build. If `Worker`, `Blob` or `URL.createObjectURL` is unavailable — a headless test
 * runner, a CSP that forbids `blob:` workers — construction falls back to a plain
 * `setInterval` on this thread, which is correct but throttleable.
 */

export type Ticker = {
  /** Begin ticking. Idempotent. */
  start(): void
  /** Stop ticking. The ticker can be started again. */
  stop(): void
  /** Stop and release the worker and its Blob URL. The ticker is unusable afterwards. */
  dispose(): void
}

/** The shape `createScheduler` injects, so a test can drive ticks by hand. */
export type CreateTicker = (intervalMs: number, onTick: () => void) => Ticker

/**
 * The worker body, as source text.
 *
 * It owns the interval so that the timer itself lives off the main thread; the main
 * thread only ever receives `'tick'`. `start` while already running replaces the
 * interval rather than stacking a second one.
 */
const WORKER_SOURCE = `
let handle = null
self.onmessage = function (event) {
  const message = event.data
  if (!message) return
  if (message.type === 'start') {
    if (handle !== null) clearInterval(handle)
    handle = setInterval(function () { self.postMessage('tick') }, message.intervalMs)
  } else if (message.type === 'stop') {
    if (handle !== null) { clearInterval(handle); handle = null }
  }
}
`

/** Build the worker, or return `undefined` when the environment cannot host one. */
function spawnWorker(): { worker: Worker; url: string } | undefined {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return undefined
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
  let url: string | undefined
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
    return { worker: new Worker(url), url }
  } catch {
    // A CSP without `worker-src blob:` throws here. Fall back rather than fail.
    if (url !== undefined) URL.revokeObjectURL(url)
    return undefined
  }
}

/**
 * A ticker firing `onTick` every `intervalMs`, worker-backed where possible.
 *
 * `onTick` runs on the main thread either way — the worker carries the clock, not the
 * work. Exceptions thrown by `onTick` are left to propagate: a throwing scheduler tick
 * is a bug, and swallowing it here would turn it into silence.
 */
export function createTicker(intervalMs: number, onTick: () => void): Ticker {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`createTicker: intervalMs must be positive, got ${intervalMs}`)
  }

  const spawned = spawnWorker()
  let running = false
  let disposed = false
  /** Only used on the fallback path. */
  let handle: ReturnType<typeof setInterval> | null = null

  if (spawned !== undefined) {
    spawned.worker.onmessage = (): void => {
      if (running) onTick()
    }
  }

  const start = (): void => {
    if (disposed || running) return
    running = true
    if (spawned !== undefined) spawned.worker.postMessage({ type: 'start', intervalMs })
    else handle = setInterval(onTick, intervalMs)
  }

  const stop = (): void => {
    if (!running) return
    running = false
    if (spawned !== undefined) spawned.worker.postMessage({ type: 'stop' })
    else if (handle !== null) {
      clearInterval(handle)
      handle = null
    }
  }

  const dispose = (): void => {
    stop()
    disposed = true
    if (spawned !== undefined) {
      spawned.worker.onmessage = null
      spawned.worker.terminate()
      URL.revokeObjectURL(spawned.url)
    }
  }

  return { start, stop, dispose }
}
