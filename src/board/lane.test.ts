import { describe, expect, it } from 'vitest'
import type { Note, Subdiv } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { enumerateSlots } from '../core/subdiv'
import { effectiveVelocity } from '../audio/scheduler'
import type { Viewport } from './viewport'
import {
  LANE_HEIGHT,
  MAX_VELOCITY,
  bucketBySlot,
  ghostVelocity,
  laneSlotAt,
  laneVelocities,
  noteSegments,
  segmentIndexAt,
  slotKey,
  slotSegments,
  velocityAtY,
  velocityToY,
} from './lane'
import type { LaneLayer } from './lane'

/**
 * Headless coverage for the lane's geometry and its velocity resolution (§6.2).
 * Nothing here touches a canvas — the drawing function is a thin consumer of these
 * same helpers, which is why they are exported rather than inlined into the paint.
 */

const vp: Viewport = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }

/** `{split:4}` with the last quarter split into 3 — the nested case of §3.2. */
const NESTED: Subdiv = { split: 4, children: [null, null, null, { split: 3 }] }

const layer = (over: Partial<LaneLayer> = {}): LaneLayer => ({
  id: 'L1',
  color: '#b4562a',
  defaultVel: 80,
  colVel: new Map<number, number>(),
  ...over,
})

let seq = 0
const note = (over: Partial<Note> = {}): Note => ({
  id: `n${seq++}`,
  layerId: 'L1',
  pos: pos(0),
  dur: frac(1, 4),
  pitch: 60,
  ...over,
})

describe('laneSlotAt', () => {
  const flat = () => undefined
  const quarters = (col: number) => (col === 0 ? NESTED : { split: 2 })

  it('resolves an undivided column to its single slot', () => {
    const hit = laneSlotAt(vp, flat, 40)
    expect(hit).toEqual({ col: 0, slotIndex: 0, start: frac(0), dur: frac(1) })
  })

  it('lands on the slot a boundary starts, not the one it ends', () => {
    // Column 0 is split 4: boundaries at x = 0, 24, 48, 72.
    for (const [x, index] of [[0, 0], [24, 1], [48, 2], [72, 3]] as const) {
      expect(laneSlotAt(vp, quarters, x)?.slotIndex).toBe(index)
    }
    // One pixel short of a boundary is still the previous slot.
    expect(laneSlotAt(vp, quarters, 23.999)?.slotIndex).toBe(0)
  })

  it('flattens a nested split into enumerateSlots order', () => {
    const slots = enumerateSlots(NESTED)
    expect(slots).toHaveLength(6)
    // The nested triplet occupies [72, 96) px: 8 px per sub-slot.
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      const x = (slot.start.n / slot.start.d) * vp.pxPerQuarter
      const hit = laneSlotAt(vp, quarters, x)
      expect(hit).toEqual({ col: 0, slotIndex: i, start: slot.start, dur: slot.dur })
    }
  })

  it('keeps nested sub-slot boundaries exact, not float-rounded', () => {
    // 72 + 8 = 80 px is 10/12 of a quarter; the frac must be built from integers.
    expect(laneSlotAt(vp, quarters, 80)).toEqual({
      col: 0,
      slotIndex: 4,
      start: frac(10, 12),
      dur: frac(1, 12),
    })
  })

  it('crosses into the next column with that column own subdivision', () => {
    // Column 1 is split 2: its halves are [96,144) and [144,192).
    expect(laneSlotAt(vp, quarters, 96)).toEqual({
      col: 1,
      slotIndex: 0,
      start: frac(0),
      dur: frac(1, 2),
    })
    expect(laneSlotAt(vp, quarters, 144)).toEqual({
      col: 1,
      slotIndex: 1,
      start: frac(1, 2),
      dur: frac(1, 2),
    })
    expect(laneSlotAt(vp, quarters, 95.999)?.col).toBe(0)
  })

  it('handles negative columns, since the board is boundless', () => {
    const hit = laneSlotAt(vp, quarters, -1)
    expect(hit?.col).toBe(-1)
    expect(hit?.slotIndex).toBe(1)
  })

  it('respects a panned/zoomed viewport rather than deriving its own', () => {
    const panned: Viewport = { ...vp, xQuarters: 3.5, pxPerQuarter: 48 }
    // x = 24 px is 0.5 quarters right of the left edge: col 4, offset 0.
    expect(laneSlotAt(panned, flat, 24)?.col).toBe(4)
  })

  it('returns null only for a non-finite x', () => {
    expect(laneSlotAt(vp, flat, Number.NaN)).toBeNull()
    expect(laneSlotAt(vp, flat, -100000)).not.toBeNull()
  })
})

describe('velocityAtY', () => {
  it('clamps at both ends', () => {
    expect(velocityAtY(LANE_HEIGHT, -50)).toBe(MAX_VELOCITY)
    expect(velocityAtY(LANE_HEIGHT, 0)).toBe(MAX_VELOCITY)
    expect(velocityAtY(LANE_HEIGHT, LANE_HEIGHT)).toBe(0)
    expect(velocityAtY(LANE_HEIGHT, LANE_HEIGHT + 50)).toBe(0)
  })

  it('is half-height at half velocity', () => {
    expect(velocityAtY(LANE_HEIGHT, LANE_HEIGHT / 2)).toBe(64)
  })

  it('round-trips every velocity through velocityToY', () => {
    for (const h of [96, 64, 120, 33]) {
      for (let v = 0; v <= MAX_VELOCITY; v++) {
        expect(velocityAtY(h, velocityToY(h, v))).toBe(v)
      }
    }
  })

  it('never returns a value outside 0-127 for a degenerate lane', () => {
    expect(velocityAtY(0, 10)).toBe(0)
    expect(velocityToY(96, 999)).toBe(0)
    expect(velocityToY(96, -999)).toBe(96)
  })
})

describe('segmentIndexAt', () => {
  it('splits a cell evenly and clamps outside it', () => {
    expect(segmentIndexAt(3, 100, 30, 100)).toBe(0)
    expect(segmentIndexAt(3, 100, 30, 115)).toBe(1)
    expect(segmentIndexAt(3, 100, 30, 129)).toBe(2)
    expect(segmentIndexAt(3, 100, 30, 400)).toBe(2)
    expect(segmentIndexAt(3, 100, 30, -400)).toBe(0)
    expect(segmentIndexAt(1, 100, 30, 400)).toBe(0)
  })
})

describe('slotSegments', () => {
  const l = layer({ defaultVel: 80, colVel: new Map([[2, 100]]) })
  const velOf = (n: Note) => effectiveVelocity(n, l)

  it('is one full segment when every note inherits', () => {
    const chord = [note({ pitch: 60 }), note({ pitch: 64 }), note({ pitch: 67 })]
    const segments = slotSegments(chord, velOf)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.vel).toBe(80)
    expect(segments[0]!.noteIds).toHaveLength(3)
  })

  it('splits per distinct velocity across own, column and default levels', () => {
    // Column 2 carries colVel 100; one note overrides itself to 40.
    const chord = [
      note({ pitch: 60, pos: pos(2) }),
      note({ pitch: 64, pos: pos(2), vel: 40 }),
      note({ pitch: 67, pos: pos(2) }),
    ]
    const segments = slotSegments(chord, velOf)
    expect(segments.map((s) => s.vel)).toEqual([40, 100])
    expect(segments[0]!.noteIds).toEqual([chord[1]!.id])
    expect(segments[1]!.noteIds).toEqual([chord[0]!.id, chord[2]!.id])
  })

  it('orders segments ascending and groups by velocity, not by note', () => {
    const chord = [
      note({ pitch: 72, vel: 120 }),
      note({ pitch: 60, vel: 30 }),
      note({ pitch: 64, vel: 120 }),
      note({ pitch: 62 }),
    ]
    const segments = slotSegments(chord, velOf)
    expect(segments.map((s) => s.vel)).toEqual([30, 80, 120])
    // Within a segment, notes stay in pitch order.
    expect(segments[2]!.noteIds).toEqual([chord[2]!.id, chord[0]!.id])
  })

  it('is empty for an empty slot', () => {
    expect(slotSegments([], velOf)).toEqual([])
  })

  it('gives Alt-drag one segment per note even when velocities tie', () => {
    const chord = [note({ pitch: 67 }), note({ pitch: 60 }), note({ pitch: 64 })]
    const segments = noteSegments(chord, velOf)
    expect(segments).toHaveLength(3)
    expect(segments.map((s) => s.noteIds[0])).toEqual([
      chord[1]!.id,
      chord[2]!.id,
      chord[0]!.id,
    ])
    expect(segments.every((s) => s.vel === 80)).toBe(true)
  })
})

describe('ghost velocity', () => {
  it('is the column override when present, else the layer default', () => {
    const l = layer({ defaultVel: 72, colVel: new Map([[5, 110]]) })
    expect(ghostVelocity(l, 5)).toBe(110)
    expect(ghostVelocity(l, 4)).toBe(72)
    expect(laneVelocities(l).ghostOf(5, 0)).toBe(110)
    expect(laneVelocities(l).ghostOf(4, 0)).toBe(72)
  })

  it('never consults a note velocity — an empty slot has none to consult', () => {
    const l = layer({ defaultVel: 72, colVel: new Map([[5, 110]]) })
    const inCol5 = note({ pos: pos(5), vel: 10 })
    expect(effectiveVelocity(inCol5, l)).toBe(10)
    expect(ghostVelocity(l, 5)).toBe(110)
  })
})

describe('laneVelocities preview', () => {
  const l = layer({ defaultVel: 80, colVel: new Map([[1, 100]]) })

  it('lets a slot drag outrank the stored resolution', () => {
    const v = laneVelocities(l, { slots: new Map([[slotKey(1, 2), 55]]) })
    const n = note({ pos: pos(1) })
    expect(v.velOf(n, 1, 2)).toBe(55)
    expect(v.velOf(n, 1, 3)).toBe(100)
    expect(v.ghostOf(1, 2)).toBe(55)
    expect(v.ghostOf(1, 3)).toBe(100)
  })

  it('lets an Alt-drag note override outrank the slot drag, mirroring §6.1', () => {
    const n = note({ pos: pos(1) })
    const v = laneVelocities(l, {
      slots: new Map([[slotKey(1, 0), 55]]),
      notes: new Map([[n.id, 20]]),
    })
    expect(v.velOf(n, 1, 0)).toBe(20)
  })
})

describe('bucketBySlot', () => {
  it('buckets by flattened slot index, nested splits included', () => {
    const a = note({ pos: pos(0, 0, 1) })
    const b = note({ pos: pos(0, 1, 4) })
    const c = note({ pos: pos(0, 10, 12) })
    const buckets = bucketBySlot(NESTED, [a, b, c])
    expect([...buckets.keys()].sort((x, y) => x - y)).toEqual([0, 1, 4])
    expect(buckets.get(4)).toEqual([c])
  })

  it('keeps an off-grid note in the slot that contains it', () => {
    // 1/5 of a quarter is on no slot of a 4-way split; it sits inside slot 0.
    const off = note({ pos: pos(0, 1, 5) })
    expect(bucketBySlot(NESTED, [off]).get(0)).toEqual([off])
  })

  it('collapses to one bucket when the column has no subdivision', () => {
    const notes = [note({ pos: pos(3, 0, 1) }), note({ pos: pos(3, 1, 3) })]
    const buckets = bucketBySlot(undefined, notes)
    expect(buckets.size).toBe(1)
    expect(buckets.get(0)).toHaveLength(2)
  })
})
