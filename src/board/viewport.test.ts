import { describe, expect, it } from 'vitest'
import { pos } from '../core/pos'
import {
  ANCHOR_PITCH, MAX_PITCH, MAX_PX_PER_QUARTER, MIN_PITCH, MIN_PX_PER_QUARTER,
  MIN_PX_PER_SEMITONE, clampVertical, initialViewport, panBy, pitchToCenterY, pitchToY,
  posToX, quartersToX, visibleCols, visiblePitches, xToQuarters, yToPitch, zoomAbout,
} from './viewport'
import type { Size, Viewport } from './viewport'

const SIZE: Size = { width: 1600, height: 900 }
const vp = (over: Partial<Viewport> = {}): Viewport => ({
  xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16, ...over,
})

describe('initialViewport', () => {
  it('puts col 0 at the left edge and C3 vertically centered', () => {
    const v = initialViewport(SIZE)
    expect(v.xQuarters).toBe(0)
    expect(v.pxPerQuarter).toBe(96)
    expect(v.pxPerSemitone).toBe(16)
    expect(yToPitch(v, SIZE.height / 2)).toBe(ANCHOR_PITCH)
  })
})

describe('horizontal transform', () => {
  it('round-trips quarters through pixels', () => {
    const v = vp({ xQuarters: 3.5 })
    for (const q of [-4, 0, 3.5, 12.25]) {
      expect(xToQuarters(v, quartersToX(v, q))).toBeCloseTo(q, 10)
    }
  })

  it('places the left edge at xQuarters', () => {
    expect(quartersToX(vp({ xQuarters: 7 }), 7)).toBe(0)
  })

  it('projects a Pos through its rational position', () => {
    expect(posToX(vp(), pos(2, 1, 2))).toBeCloseTo(2.5 * 96, 10)
    expect(posToX(vp(), pos(-1, 1, 3))).toBeCloseTo((-1 + 1 / 3) * 96, 10)
  })
})

describe('vertical transform', () => {
  it('puts the top-edge pitch at y = 0 and increases pitch upward', () => {
    const v = vp({ yPitch: 60 })
    expect(pitchToY(v, 60)).toBe(0)
    expect(pitchToY(v, 59)).toBe(16)
    expect(pitchToY(v, 61)).toBe(-16)
  })

  it('centers stones within their row', () => {
    expect(pitchToCenterY(vp(), 60)).toBe(8)
  })

  it('yToPitch inverts pitchToY, with the row owning its top edge', () => {
    const v = vp({ yPitch: 60 })
    for (const p of [60, 59, 48, 30]) {
      expect(yToPitch(v, pitchToY(v, p))).toBe(p)
      // Anywhere strictly inside the row maps back to the same pitch.
      expect(yToPitch(v, pitchToY(v, p) + 15.9)).toBe(p)
    }
  })
})

describe('clampVertical', () => {
  it('keeps the visible band inside the MIDI range', () => {
    const rows = SIZE.height / 16
    expect(clampVertical(vp({ yPitch: 500 }), SIZE).yPitch).toBe(MAX_PITCH + 1)
    expect(clampVertical(vp({ yPitch: -500 }), SIZE).yPitch).toBe(MIN_PITCH + rows)
  })

  it('centers rather than jamming when the band is taller than 128 semitones', () => {
    // 900px / 8px = 112 rows, still under 128; force a taller band.
    const tall = clampVertical(vp({ pxPerSemitone: MIN_PX_PER_SEMITONE }), { width: 1600, height: 2000 })
    const rows = 2000 / MIN_PX_PER_SEMITONE
    expect(tall.yPitch).toBe(MIN_PITCH + (128 + rows) / 2)
    // The band is symmetric about the MIDI range.
    expect(tall.yPitch - rows / 2).toBeCloseTo(64, 6)
  })

  it('returns the same object when nothing changes', () => {
    const v = vp({ yPitch: 90 })
    expect(clampVertical(v, SIZE)).toBe(v)
  })
})

describe('visible ranges', () => {
  it('covers the surface and widens by the margin', () => {
    const v = vp({ xQuarters: 2.5 })
    expect(visibleCols(v, SIZE)).toEqual({ start: 2, end: 20 })
    // The margin is ceil(maxDurQuarters), not 1 — see §4.1.
    expect(visibleCols(v, SIZE, 4)).toEqual({ start: -2, end: 24 })
  })

  it('clamps pitches to the MIDI range', () => {
    const r = visiblePitches(vp({ yPitch: 200 }), SIZE)
    expect(r.hi).toBe(MAX_PITCH)
    expect(r.lo).toBeGreaterThanOrEqual(MIN_PITCH)
  })
})

describe('panBy', () => {
  it('moves content with the pointer', () => {
    // Dragging right reveals earlier music, so xQuarters decreases.
    const v = panBy(vp(), 96, 0, SIZE)
    expect(v.xQuarters).toBeCloseTo(-1, 10)
    expect(panBy(vp(), -96, 0, SIZE).xQuarters).toBeCloseTo(1, 10)
  })

  it('moves vertically and stays clamped', () => {
    expect(panBy(vp(), 0, -16, SIZE).yPitch).toBeCloseTo(59, 10)
    expect(panBy(vp(), 0, 1e6, SIZE).yPitch).toBe(MAX_PITCH + 1)
  })
})

describe('zoomAbout', () => {
  it('holds the musical position under the cursor fixed', () => {
    const v = vp({ xQuarters: 3, yPitch: 70 })
    for (const [ax, ay] of [[0, 0], [800, 450], [1599, 899]] as const) {
      const qBefore = xToQuarters(v, ax)
      const pBefore = v.yPitch - ay / v.pxPerSemitone
      const z = zoomAbout(v, ax, ay, 1.5, 1.25, SIZE)
      expect(xToQuarters(z, ax)).toBeCloseTo(qBefore, 8)
      expect(z.yPitch - ay / z.pxPerSemitone).toBeCloseTo(pBefore, 8)
    }
  })

  it('clamps to the zoom bounds', () => {
    const inMost = zoomAbout(vp(), 800, 450, 100, 100, SIZE)
    expect(inMost.pxPerQuarter).toBe(MAX_PX_PER_QUARTER)
    const outMost = zoomAbout(vp(), 800, 450, 0.001, 0.001, SIZE)
    expect(outMost.pxPerQuarter).toBe(MIN_PX_PER_QUARTER)
    expect(outMost.pxPerSemitone).toBe(MIN_PX_PER_SEMITONE)
  })

  it('supports horizontal-only zoom', () => {
    const z = zoomAbout(vp(), 400, 200, 2, 1, SIZE)
    expect(z.pxPerQuarter).toBe(192)
    expect(z.pxPerSemitone).toBe(16)
  })

  it('does not drift over repeated zoom in and out', () => {
    let v = vp({ xQuarters: 1.25, yPitch: 66 })
    const q0 = xToQuarters(v, 700)
    // Stay inside the zoom bounds; clamping is deliberately not reversible.
    for (let i = 0; i < 20; i++) v = zoomAbout(v, 700, 300, 1.02, 1, SIZE)
    for (let i = 0; i < 20; i++) v = zoomAbout(v, 700, 300, 1 / 1.02, 1, SIZE)
    expect(xToQuarters(v, 700)).toBeCloseTo(q0, 6)
    expect(v.pxPerQuarter).toBeCloseTo(96, 6)
  })
})
