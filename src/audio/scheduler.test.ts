import { describe, expect, it } from 'vitest'
import type { Frac, LayerId, Note, NoteId, Pos } from '../core/types'
import type { TempoMap } from '../core/tempo'
import type { LoopRegion, SchedulerLayer, VoiceRequest } from './scheduler'
import { NoteIndex } from '../core/noteIndex'
import { ONE, frac } from '../core/frac'
import { pos } from '../core/pos'
import { buildTempoMap } from '../core/tempo'
import { LOOKAHEAD_SECONDS, TICK_INTERVAL_MS, createScheduler, effectiveVelocity } from './scheduler'

/**
 * Scheduler tests. See go-spec.md §8.1.
 *
 * Everything runs against a fake clock and a fake ticker driven by hand: `runFor`
 * advances the clock in exact 25 ms steps and fires one tick per step, so onset seconds
 * are asserted exactly rather than waited for. No timers, no AudioContext, no smplr.
 *
 * At the default 120 BPM one quarter is 0.5 s, so col N is at N/2 seconds.
 */

/** 120 BPM everywhere. */
const flat = buildTempoMap([])

/** 120 BPM to col 4, then 60 BPM: col 4 -> 2 s, and a quarter after it costs 1 s. */
const stepped = buildTempoMap([{ pos: pos(4), bpm: 60 }])

const EMPTY: readonly Note[] = []

type NoteSpec = {
  readonly id: NoteId
  readonly at: Pos
  readonly dur?: Frac
  readonly pitch?: number
  readonly vel?: number
  readonly layerId?: LayerId
}

/** `vel` is only set when supplied — `exactOptionalPropertyTypes` forbids `vel: undefined`. */
function note(spec: NoteSpec): Note {
  const base = {
    id: spec.id,
    layerId: spec.layerId ?? 'L1',
    pos: spec.at,
    dur: spec.dur ?? ONE,
    pitch: spec.pitch ?? 60,
  }
  return spec.vel === undefined ? base : { ...base, vel: spec.vel }
}

function layer(id: LayerId, over: Partial<SchedulerLayer> = {}): SchedulerLayer {
  return {
    id,
    audible: true,
    defaultVel: 96,
    colVel: new Map<number, number>(),
    ...over,
  }
}

type HarnessConfig = {
  readonly notes?: readonly Note[]
  readonly layers?: readonly SchedulerLayer[]
  readonly tempo?: TempoMap
  readonly loop?: LoopRegion
  readonly lookahead?: number
  readonly outputLatency?: number
}

function makeHarness(config: HarnessConfig = {}) {
  const index = NoteIndex.build(config.notes ?? [])
  const tempo = config.tempo ?? flat
  let layers: readonly SchedulerLayer[] = config.layers ?? [layer('L1')]
  let loop: LoopRegion | undefined = config.loop
  let now = 0
  let steps = 0

  const started: VoiceRequest[] = []
  const stopped: NoteId[] = []
  const ticker = { starts: 0, stops: 0, disposes: 0, running: false }
  let onTick: (() => void) | undefined

  const scheduler = createScheduler({
    now: () => now,
    voice: {
      start(request) {
        started.push(request)
        return () => {
          stopped.push(request.stopId)
        }
      },
    },
    tempoMap: () => tempo,
    layers: () => layers,
    notes: (layerId) => index.notesByLayer.get(layerId) ?? EMPTY,
    loop: () => loop,
    outputLatency: config.outputLatency ?? 0,
    createTicker: (_intervalMs, callback) => {
      onTick = callback
      return {
        start: () => {
          ticker.starts++
          ticker.running = true
        },
        stop: () => {
          ticker.stops++
          ticker.running = false
        },
        dispose: () => {
          ticker.disposes++
          ticker.running = false
        },
      }
    },
    ...(config.lookahead === undefined ? {} : { lookaheadSeconds: config.lookahead }),
  })

  /** One tick at the current clock reading, without moving the clock. */
  const tick = (): void => {
    if (ticker.running) onTick?.()
  }

  /** Advance the clock in exact 25 ms steps, firing a tick at each. */
  const runFor = (seconds: number): void => {
    const count = Math.round((seconds * 1000) / TICK_INTERVAL_MS)
    for (let i = 0; i < count; i++) {
      steps++
      now = (steps * TICK_INTERVAL_MS) / 1000
      tick()
    }
  }

  /** Jump the clock without ticking — for `currentPos` assertions. */
  const setNow = (seconds: number): void => {
    now = seconds
    steps = Math.round((seconds * 1000) / TICK_INTERVAL_MS)
  }

  return {
    scheduler,
    index,
    started,
    stopped,
    ticker,
    tick,
    runFor,
    setNow,
    now: () => now,
    ids: (): NoteId[] => started.map((r) => r.stopId),
    times: (): number[] => started.map((r) => r.time),
    setLoop: (next: LoopRegion | undefined): void => {
      loop = next
    },
    setLayers: (next: readonly SchedulerLayer[]): void => {
      layers = next
    },
  }
}

describe('effectiveVelocity (§6.1)', () => {
  const withCol = layer('L1', { defaultVel: 96, colVel: new Map([[2, 40]]) })

  it('prefers the per-note override', () => {
    expect(effectiveVelocity(note({ id: 'a', at: pos(2), vel: 111 }), withCol)).toBe(111)
  })

  it('falls back to the column velocity of the note’s own column', () => {
    expect(effectiveVelocity(note({ id: 'a', at: pos(2) }), withCol)).toBe(40)
    expect(effectiveVelocity(note({ id: 'b', at: pos(2, 3, 4) }), withCol)).toBe(40)
  })

  it('falls back to the layer default when the column has no entry', () => {
    expect(effectiveVelocity(note({ id: 'a', at: pos(3) }), withCol)).toBe(96)
  })

  it('treats an explicit vel of 0 as an override, not as absent', () => {
    expect(effectiveVelocity(note({ id: 'a', at: pos(2), vel: 0 }), withCol)).toBe(0)
  })
})

describe('scheduling', () => {
  it('schedules every note exactly once, in time order, at exact onset seconds', () => {
    const h = makeHarness({
      notes: [
        note({ id: 'a', at: pos(0) }),
        note({ id: 'b', at: pos(1, 1, 2) }),
        note({ id: 'c', at: pos(3) }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(2)

    expect(h.ids()).toEqual(['a', 'b', 'c'])
    expect(h.times()[0]).toBeCloseTo(0, 12)
    expect(h.times()[1]).toBeCloseTo(0.75, 12)
    expect(h.times()[2]).toBeCloseTo(1.5, 12)
  })

  it('never schedules beyond the lookahead window', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(1) })] })
    h.scheduler.play(pos(0))
    // b sits at 0.5 s. The window is half-open, so at now = 0.4 it is exactly excluded.
    expect(h.ids()).toEqual(['a'])

    h.runFor(0.4)
    expect(h.now()).toBeCloseTo(0.4, 12)
    expect(h.ids()).toEqual(['a'])

    h.runFor(TICK_INTERVAL_MS / 1000)
    expect(h.ids()).toEqual(['a', 'b'])
    expect(h.times()[1]).toBeCloseTo(0.5, 12)
  })

  it('orders onsets across layers by time, not by layer', () => {
    const h = makeHarness({
      layers: [layer('L1'), layer('L2')],
      notes: [
        note({ id: 'late-1', at: pos(0, 1, 2), layerId: 'L1' }),
        note({ id: 'early-2', at: pos(0), layerId: 'L2' }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(0.5)
    expect(h.ids()).toEqual(['early-2', 'late-1'])
  })

  it('resolves velocity at schedule time through all three levels', () => {
    const h = makeHarness({
      layers: [layer('L1', { defaultVel: 96, colVel: new Map([[1, 40]]) })],
      notes: [
        note({ id: 'default', at: pos(0) }),
        note({ id: 'column', at: pos(1) }),
        note({ id: 'override', at: pos(2), vel: 127 }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(1.5)
    expect(h.started.map((r) => r.velocity)).toEqual([96, 40, 127])
  })

  it('emits pitch, stopId and layerId on every request', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0), pitch: 48 })] })
    h.scheduler.play(pos(0))
    expect(h.started[0]).toMatchObject({ layerId: 'L1', pitch: 48, stopId: 'a', velocity: 96 })
  })

  it('starts from the play position rather than the beginning', () => {
    const h = makeHarness({
      notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(4) })],
    })
    h.scheduler.play(pos(4))
    // Playing from col 4 anchors that position at the current clock reading.
    expect(h.ids()).toEqual(['b'])
    expect(h.times()[0]).toBeCloseTo(0, 12)
  })

  it('starts and stops the ticker with the transport', () => {
    const h = makeHarness()
    expect(h.scheduler.isPlaying).toBe(false)
    h.scheduler.play(pos(0))
    expect(h.scheduler.isPlaying).toBe(true)
    expect(h.ticker.starts).toBe(1)
    h.scheduler.stop()
    expect(h.scheduler.isPlaying).toBe(false)
    expect(h.ticker.stops).toBe(1)
    h.scheduler.dispose()
    expect(h.ticker.disposes).toBe(1)
  })
})

describe('tick robustness', () => {
  it('schedules nothing twice when a tick repeats at the same clock reading', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(0) })] })
    h.scheduler.play(pos(0))
    h.tick()
    h.tick()
    expect(h.ids()).toEqual(['a', 'b'])
  })

  it('catches up after a starved tick without dropping or duplicating notes', () => {
    const h = makeHarness({
      notes: [
        note({ id: 'a', at: pos(0) }),
        note({ id: 'b', at: pos(1) }),
        note({ id: 'c', at: pos(2) }),
      ],
    })
    h.scheduler.play(pos(0))
    // One tick a full second later — the throttling §8.1's worker exists to prevent.
    h.setNow(1)
    h.tick()
    expect(h.ids()).toEqual(['a', 'b', 'c'])
    expect(h.times()[2]).toBeCloseTo(1, 12)
  })
})

describe('duration in seconds', () => {
  it('converts a plain duration through the tempo map', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0), dur: frac(3, 2) })] })
    h.scheduler.play(pos(0))
    expect(h.started[0]?.duration).toBeCloseTo(0.75, 12)
  })

  it('gives a note spanning a tempo change its true elapsed seconds', () => {
    // col 3 -> col 5 crosses the 120 -> 60 change at col 4: 0.5 s + 1 s, not 2 x 0.5 s.
    const h = makeHarness({
      tempo: stepped,
      notes: [note({ id: 'a', at: pos(3), dur: frac(2) })],
    })
    h.scheduler.play(pos(3))
    expect(h.started).toHaveLength(1)
    expect(h.started[0]?.duration).toBeCloseTo(1.5, 12)
  })
})

describe('loop (§8.1)', () => {
  const region = (startCol: number, endCol: number): LoopRegion => ({
    start: pos(startCol),
    end: pos(endCol),
  })

  it('wraps, emitting the right onsets over several passes', () => {
    const h = makeHarness({
      loop: region(0, 2),
      notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(1) })],
    })
    h.scheduler.play(pos(0))
    h.runFor(2.5)

    expect(h.ids()).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
    const times = h.times()
    expect(times[0]).toBeCloseTo(0, 9)
    expect(times[1]).toBeCloseTo(0.5, 9)
    expect(times[2]).toBeCloseTo(1, 9)
    expect(times[3]).toBeCloseTo(1.5, 9)
    expect(times[4]).toBeCloseTo(2, 9)
    expect(times[5]).toBeCloseTo(2.5, 9)
  })

  it('emits several passes in a single tick when the loop is shorter than the lookahead', () => {
    // 1/10 quarter = 50 ms at 120 BPM: half the 100 ms lookahead.
    const h = makeHarness({
      loop: { start: pos(0), end: pos(0, 1, 10) },
      notes: [note({ id: 'a', at: pos(0) })],
    })
    h.scheduler.play(pos(0))

    // One tick, before the clock has moved at all.
    expect(h.ids()).toEqual(['a', 'a'])
    expect(h.times()[0]).toBeCloseTo(0, 12)
    expect(h.times()[1]).toBeCloseTo(0.05, 12)
  })

  it('treats loop.end as exclusive', () => {
    const h = makeHarness({
      loop: region(0, 2),
      notes: [note({ id: 'inside', at: pos(1) }), note({ id: 'onEnd', at: pos(2) })],
    })
    h.scheduler.play(pos(0))
    h.runFor(3)
    expect(new Set(h.ids())).toEqual(new Set(['inside']))
    expect(h.ids().length).toBeGreaterThan(1)
  })

  it('truncates a note whose duration crosses the loop end', () => {
    const h = makeHarness({
      loop: region(0, 2),
      notes: [note({ id: 'long', at: pos(1), dur: frac(4) })],
    })
    h.scheduler.play(pos(0))
    h.runFor(0.6)
    // dur 4 quarters = 2 s, but only one quarter (0.5 s) remains before the loop point.
    expect(h.started[0]?.duration).toBeCloseTo(0.5, 12)
  })

  it('ignores a degenerate region instead of spinning', () => {
    const h = makeHarness({
      loop: { start: pos(2), end: pos(2) },
      notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(4) })],
    })
    h.scheduler.play(pos(0))
    h.runFor(2)
    expect(h.ids()).toEqual(['a', 'b'])
  })

  it('picks up a loop enabled mid-playback', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) })] })
    h.scheduler.play(pos(0))
    expect(h.ids()).toEqual(['a'])
    h.setLoop(region(0, 2))
    h.runFor(1.5)
    expect(h.ids()).toEqual(['a', 'a'])
    expect(h.times()[1]).toBeCloseTo(1, 9)
  })
})

describe('stop (§8.1)', () => {
  it('invokes every retained StopFn, including a note committed 250 ms ahead', () => {
    const h = makeHarness({
      lookahead: 0.3,
      notes: [
        note({ id: 'now', at: pos(0), dur: frac(4) }),
        note({ id: 'ahead', at: pos(0, 1, 2), dur: frac(4) }),
      ],
    })
    h.scheduler.play(pos(0))
    expect(h.times()[1]).toBeCloseTo(0.25, 12)

    h.scheduler.stop()
    expect(h.stopped).toEqual(['now', 'ahead'])
  })

  it('does not resume where it left off: stop then play repeats the passage', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) })] })
    h.scheduler.play(pos(0))
    h.runFor(0.5)
    h.scheduler.stop()
    h.scheduler.play()
    expect(h.ids()).toEqual(['a', 'a'])
  })

  it('stops nothing twice and schedules nothing after stopping', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(2) })] })
    h.scheduler.play(pos(0))
    h.scheduler.stop()
    h.runFor(2)
    expect(h.ids()).toEqual(['a'])
    expect(h.stopped).toEqual(['a'])
  })
})

describe('editing during playback (§8.1 regression)', () => {
  it('does not re-fire a committed note when one is inserted before the cursor', () => {
    const h = makeHarness({
      notes: [
        note({ id: 'a', at: pos(0) }),
        note({ id: 'b', at: pos(1) }),
        note({ id: 'c', at: pos(2) }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(0.45)
    expect(h.ids()).toEqual(['a', 'b'])

    // The user drops a stone behind the playhead. An array-index cursor would shift and
    // re-read `b`, double-triggering it; a `Pos` cursor never looks back.
    h.index.insert(note({ id: 'inserted', at: pos(0, 1, 2) }))
    h.runFor(2)

    expect(h.ids()).toEqual(['a', 'b', 'c'])
  })

  it('does not skip the next note when the note at the cursor is deleted', () => {
    const h = makeHarness({
      notes: [
        note({ id: 'a', at: pos(0) }),
        note({ id: 'b', at: pos(1) }),
        note({ id: 'c', at: pos(2) }),
      ],
    })
    h.scheduler.play(pos(0))
    expect(h.ids()).toEqual(['a'])

    // Deleting the note the cursor sits on shifts every later element down one; an
    // index cursor would step over `b` entirely.
    h.index.remove('a')
    h.runFor(2)

    expect(h.ids()).toEqual(['a', 'b', 'c'])
    expect(h.times()[1]).toBeCloseTo(0.5, 12)
    expect(h.times()[2]).toBeCloseTo(1, 12)
  })

  it('does not re-fire chord members already committed when a sibling is added', () => {
    const h = makeHarness({
      notes: [
        note({ id: 'root', at: pos(0), pitch: 60 }),
        note({ id: 'third', at: pos(0), pitch: 64 }),
      ],
    })
    h.scheduler.play(pos(0))
    expect(h.ids()).toEqual(['root', 'third'])

    h.index.insert(note({ id: 'fifth', at: pos(0), pitch: 67 }))
    h.runFor(0.5)

    expect(h.ids().filter((id) => id === 'root')).toHaveLength(1)
    expect(h.ids().filter((id) => id === 'third')).toHaveLength(1)
  })

  it('picks up a note inserted ahead of the playhead', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) })] })
    h.scheduler.play(pos(0))
    h.index.insert(note({ id: 'later', at: pos(2) }))
    h.runFor(1.5)
    expect(h.ids()).toEqual(['a', 'later'])
    expect(h.times()[1]).toBeCloseTo(1, 12)
  })

  it('does not fire a note deleted before the window reached it', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(2) })] })
    h.scheduler.play(pos(0))
    h.index.remove('b')
    h.runFor(2)
    expect(h.ids()).toEqual(['a'])
  })
})

describe('audible layers only', () => {
  it('skips muted layers', () => {
    const h = makeHarness({
      layers: [layer('L1'), layer('L2', { audible: false })],
      notes: [
        note({ id: 'heard', at: pos(0), layerId: 'L1' }),
        note({ id: 'muted', at: pos(0), layerId: 'L2' }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(1)
    expect(h.ids()).toEqual(['heard'])
  })

  it('starts scheduling a layer unmuted mid-playback, from the current position', () => {
    const h = makeHarness({
      layers: [layer('L1'), layer('L2', { audible: false })],
      notes: [
        note({ id: 'early', at: pos(0), layerId: 'L2' }),
        note({ id: 'late', at: pos(3), layerId: 'L2' }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(0.5)
    expect(h.ids()).toEqual([])

    h.setLayers([layer('L1'), layer('L2')])
    h.runFor(2)
    expect(h.ids()).toEqual(['late'])
    expect(h.times()[0]).toBeCloseTo(1.5, 12)
  })
})

describe('seek', () => {
  it('lands mid-piece and schedules from there', () => {
    const h = makeHarness({
      notes: [
        note({ id: 'a', at: pos(0) }),
        note({ id: 'b', at: pos(1) }),
        note({ id: 'c', at: pos(4) }),
        note({ id: 'd', at: pos(5) }),
      ],
    })
    h.scheduler.play(pos(0))
    h.runFor(0.3)
    // `b` sits at 0.5 s, still beyond the window at now = 0.3 — the seek pre-empts it.
    expect(h.ids()).toEqual(['a'])

    h.scheduler.seek(pos(4))
    // col 4 is now anchored at the clock reading of the seek (0.3 s).
    expect(h.ids()).toEqual(['a', 'c'])
    expect(h.times()[1]).toBeCloseTo(0.3, 12)

    h.runFor(1)
    expect(h.ids()).toEqual(['a', 'c', 'd'])
    expect(h.times()[2]).toBeCloseTo(0.8, 12)
  })

  it('releases sounding voices, so a seek does not leave the old passage ringing', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0), dur: frac(8) })] })
    h.scheduler.play(pos(0))
    h.scheduler.seek(pos(4))
    expect(h.stopped).toEqual(['a'])
  })

  it('while stopped, sets where the next play begins', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(2) })] })
    h.scheduler.seek(pos(2))
    h.scheduler.play()
    h.runFor(0.5)
    expect(h.ids()).toEqual(['b'])
  })

  it('does not replay notes between the old and new position when seeking backwards', () => {
    const h = makeHarness({ notes: [note({ id: 'a', at: pos(0) }), note({ id: 'b', at: pos(1) })] })
    h.scheduler.play(pos(1))
    expect(h.ids()).toEqual(['b'])
    h.scheduler.seek(pos(0))
    h.runFor(0.6)
    expect(h.ids()).toEqual(['b', 'a', 'b'])
  })
})

describe('currentPos', () => {
  it('inverts the tempo map against the clock', () => {
    const h = makeHarness()
    h.scheduler.play(pos(0))
    expect(h.scheduler.currentPos(1)).toEqual(pos(2))
    expect(h.scheduler.currentPos(1.25)).toEqual(pos(2, 1, 2))
  })

  it('subtracts output latency, so the playhead does not lead the sound', () => {
    const h = makeHarness({ outputLatency: 0.25 })
    h.scheduler.play(pos(0))
    expect(h.scheduler.currentPos(1)).toEqual(pos(1, 1, 2))

    h.scheduler.setOutputLatency(0.5)
    expect(h.scheduler.currentPos(1)).toEqual(pos(1))
  })

  it('accounts for the play position and a non-zero start time', () => {
    const h = makeHarness()
    h.setNow(10)
    h.scheduler.play(pos(4))
    expect(h.scheduler.currentPos(11)).toEqual(pos(6))
  })

  it('folds the loop wrap back into the region', () => {
    const h = makeHarness({ loop: { start: pos(0), end: pos(2) } })
    h.scheduler.play(pos(0))
    // A 1 s loop: 2.25 s of wall clock is a quarter of the way into the third pass.
    expect(h.scheduler.currentPos(2.25)).toEqual(pos(0, 1, 2))
    expect(h.scheduler.currentPos(1.5)).toEqual(pos(1))
  })

  it('folds a loop entered from before its start', () => {
    const h = makeHarness({ loop: { start: pos(2), end: pos(4) } })
    h.scheduler.play(pos(0))
    // 0 -> col 4 takes 2 s; the first wrap lands on col 2 and each pass is 1 s.
    expect(h.scheduler.currentPos(1.5)).toEqual(pos(3))
    expect(h.scheduler.currentPos(2.5)).toEqual(pos(3))
  })

  it('returns the anchor while stopped', () => {
    const h = makeHarness()
    expect(h.scheduler.currentPos(5)).toEqual(pos(0))
    h.scheduler.seek(pos(7))
    expect(h.scheduler.currentPos(5)).toEqual(pos(7))
    h.scheduler.play()
    h.scheduler.stop()
    expect(h.scheduler.currentPos(99)).toEqual(pos(7))
  })
})

describe('defaults', () => {
  it('uses the §8.1 window and tick period', () => {
    expect(LOOKAHEAD_SECONDS).toBe(0.1)
    expect(TICK_INTERVAL_MS).toBe(25)
  })
})
