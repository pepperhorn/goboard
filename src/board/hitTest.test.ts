import { describe, expect, it } from 'vitest'
import type { Note, Subdiv } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { enumerateSlots } from '../core/subdiv'
import { NoteIndex } from '../core/noteIndex'
import { pitchToCenterY, quartersToX } from './viewport'
import type { Viewport } from './viewport'
import {
  DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH, RESIZE_ZONE_MIN_STONE_PX, createDragLatch,
  hitNote, noteRect, pointToSlot, resizeZone,
} from './hitTest'
import type { HitLayer } from './hitTest'

const vp = (over: Partial<Viewport> = {}): Viewport => ({
  xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16, ...over,
})

/** C3 — the board's anchor row. At the default viewport it spans y 192..208. */
const P = 48
const rowY = (v: Viewport, pitch = P): number => pitchToCenterY(v, pitch)

/** Terse note constructor: rationals as integer pairs, never floats. */
function mk(
  id: string,
  layerId: string,
  col: number,
  pitch: number,
  dur: readonly [number, number] = [1, 1],
  off: readonly [number, number] = [0, 1],
): Note {
  return { id, layerId, pos: pos(col, off[0], off[1]), dur: frac(dur[0], dur[1]), pitch }
}

const layer = (id: string, order: number, visible = true): HitLayer => ({ id, order, visible })

const never = (): undefined => undefined
const always = (sd: Subdiv) => (): Subdiv => sd

describe('pointToSlot', () => {
  it('resolves an unsubdivided column to the whole quarter', () => {
    const v = vp()
    const hit = pointToSlot(v, never, 50, rowY(v))
    expect(hit).not.toBeNull()
    expect(hit!.pos).toEqual(pos(0, 0, 1))
    expect(hit!.dur).toEqual(frac(1, 1))
    expect(hit!.pitch).toBe(P)
  })

  it('resolves inside a { split: 4 } column to exact quarter fractions', () => {
    const v = vp()
    const sd = always({ split: 4 })
    for (let i = 0; i < 4; i++) {
      // Midpoint of slot i: (i + 0.5) / 4 of a 96 px column.
      const hit = pointToSlot(v, sd, (i + 0.5) * 24, rowY(v))!
      expect(hit.pos).toEqual(pos(0, i, 4))
      expect(hit.dur).toEqual(frac(1, 4))
    }
  })

  it('resolves nested slots exactly, including the denominators', () => {
    const v = vp()
    // 16ths with triplet 32nds on the last 16th — the §3.2 example.
    const sd = always({ split: 4, children: [null, null, null, { split: 3 }] })
    // The last quarter-slot spans x 72..96, split into three 8 px slots.
    expect(pointToSlot(v, sd, 76, rowY(v))!.pos.frac).toEqual(frac(3, 4))
    expect(pointToSlot(v, sd, 84, rowY(v))!.pos.frac).toEqual(frac(5, 6))
    expect(pointToSlot(v, sd, 92, rowY(v))!.pos.frac).toEqual(frac(11, 12))
    expect(pointToSlot(v, sd, 92, rowY(v))!.dur).toEqual(frac(1, 12))
    // Slots before the subdivided one keep their own denominator.
    expect(pointToSlot(v, sd, 4, rowY(v))!.dur).toEqual(frac(1, 4))
  })

  it('treats slot boundaries as half-open — the boundary starts a slot (§3.2)', () => {
    const v = vp()
    const sd = always({ split: 4 })
    expect(pointToSlot(v, sd, 0, rowY(v))!.pos).toEqual(pos(0, 0, 4))
    expect(pointToSlot(v, sd, 24, rowY(v))!.pos).toEqual(pos(0, 1, 4))
    expect(pointToSlot(v, sd, 23.9, rowY(v))!.pos).toEqual(pos(0, 0, 4))
    // The column boundary belongs to the next column.
    expect(pointToSlot(v, sd, 96, rowY(v))!.pos).toEqual(pos(1, 0, 4))
  })

  it('lands on the right side of a boundary that is not exact in binary', () => {
    const v = vp()
    // The second boundary of a quintuplet at 96 px/quarter sits at 19.2 px, and
    // 19.2 / 96 * 5 evaluates to 0.9999999999999999 — a naive floor puts the click in
    // the slot before the one it starts.
    expect(19.2 / 96 * 5).toBeLessThan(1)
    const hit = pointToSlot(v, always({ split: 5 }), 19.2, rowY(v))!
    expect(hit.pos).toEqual(pos(0, 1, 5))
    expect(hit.dur).toEqual(frac(1, 5))
    // …and a click genuinely inside the previous slot still lands there.
    expect(pointToSlot(v, always({ split: 5 }), 19, rowY(v))!.pos).toEqual(pos(0, 0, 5))
  })

  it('agrees with enumerateSlots at every slot start and midpoint', () => {
    const v = vp()
    const tree: Subdiv = { split: 4, children: [null, null, null, { split: 3 }] }
    const slots = enumerateSlots(tree)
    for (const slot of slots) {
      const startQ = slot.start.n / slot.start.d
      const midQ = startQ + slot.dur.n / slot.dur.d / 2
      for (const q of [startQ, midQ]) {
        const hit = pointToSlot(v, always(tree), quartersToX(v, q), rowY(v))!
        expect(hit.pos).toEqual(pos(0, slot.start.n, slot.start.d))
        expect(hit.dur).toEqual(slot.dur)
      }
    }
  })

  it('builds fractions from integers, never from the float pixel position', () => {
    const v = vp({ pxPerQuarter: 100 })
    // 1/7 of a 100 px column is 14.2857… px — a position no float can hold exactly.
    const hit = pointToSlot(v, always({ split: 7 }), 20, rowY(v))!
    expect(hit.pos.frac).toEqual(frac(1, 7))
    expect(hit.dur).toEqual(frac(1, 7))
    expect(hit.pos.frac.d).toBe(7)
  })

  it('handles negative columns and negative x', () => {
    const v = vp()
    expect(pointToSlot(v, never, -10, rowY(v))!.pos).toEqual(pos(-1, 0, 1))
    expect(pointToSlot(v, always({ split: 4 }), -10, rowY(v))!.pos).toEqual(pos(-1, 3, 4))
    expect(pointToSlot(v, always({ split: 4 }), -96, rowY(v))!.pos).toEqual(pos(-1, 0, 4))

    // A viewport panned left of the origin: x = 0 is quarter -2.5.
    const panned = vp({ xQuarters: -2.5 })
    const seen: number[] = []
    const hit = pointToSlot(panned, (col) => {
      seen.push(col)
      return { split: 2 }
    }, 0, rowY(panned))!
    expect(seen).toEqual([-3])
    expect(hit.pos).toEqual(pos(-3, 1, 2))
    expect(hit.dur).toEqual(frac(1, 2))
  })

  it('returns null outside the MIDI range', () => {
    const v = vp()
    expect(pointToSlot(v, never, 10, rowY(v, 127))).not.toBeNull()
    expect(pointToSlot(v, never, 10, rowY(v, 0))).not.toBeNull()
    expect(pointToSlot(v, never, 10, rowY(v, 128))).toBeNull()
    expect(pointToSlot(v, never, 10, rowY(v, -1))).toBeNull()
  })
})

describe('noteRect', () => {
  it('draws a one-slot note as a circle centred in its slot', () => {
    const v = vp()
    const r = 16 * 0.42
    const rect = noteRect(v, mk('n', 'A', 0, P))
    expect(rect.width).toBeCloseTo(2 * r, 9)
    expect(rect.height).toBeCloseTo(2 * r, 9)
    expect(rect.x + rect.width / 2).toBeCloseTo(48, 9)
    expect(rect.y + rect.height / 2).toBeCloseTo(rowY(v), 9)
  })

  it('stretches a longer note into a lozenge without moving its head', () => {
    const v = vp()
    const head = noteRect(v, mk('n', 'A', 0, P))
    const long = noteRect(v, mk('n', 'A', 0, P, [4, 1]))
    expect(long.x).toBeCloseTo(head.x, 9)
    expect(long.height).toBeCloseTo(head.height, 9)
    expect(long.width).toBeCloseTo(head.width + 3 * 96, 9)
  })

  it('honours an explicit slot width so it matches what the renderer drew', () => {
    const v = vp()
    // A one-quarter note in a { split: 4 } column: four 24 px slots.
    const rect = noteRect(v, mk('n', 'A', 0, P), 24)
    const r = 16 * 0.42
    expect(rect.x).toBeCloseTo(12 - r, 9)
    expect(rect.x + rect.width).toBeCloseTo(96 - 12 + r, 9)
  })
})

describe('hitNote', () => {
  const layers = [layer('A', 0), layer('B', 1), layer('C', 2)]

  it('finds a long note when the click lands on the FAR end of its lozenge', () => {
    // The §4.1 / review-B1 regression: the note is indexed at col 0 only, and the
    // click lands three columns to the right of it.
    const v = vp()
    const note = mk('long', 'A', 0, P, [4, 1])
    const index = NoteIndex.build([note])
    const rect = noteRect(v, note)

    expect(hitNote(v, index, layers, 'A', 336, rowY(v))?.id).toBe('long')
    expect(hitNote(v, index, layers, 'A', rect.x + rect.width - 0.5, rowY(v))?.id).toBe('long')
    expect(hitNote(v, index, layers, 'A', 200, rowY(v))?.id).toBe('long')
    // Past the lozenge's right cap there is nothing to hit.
    expect(hitNote(v, index, layers, 'A', rect.x + rect.width + 2, rowY(v))).toBeNull()
    // Nor above the row.
    expect(hitNote(v, index, layers, 'A', 200, rowY(v) - 15)).toBeNull()
  })

  it('finds an off-grid note that no slot of the current subdivision contains (§7)', () => {
    // Placed on a triplet grid, then the column was re-split into 4. §7 re-quantizes
    // nothing, so the note sits between slots — slot-based hit testing would make it
    // permanently unclickable.
    const v = vp()
    const note = mk('offgrid', 'A', 0, P, [1, 3], [1, 3])
    const index = NoteIndex.build([note])

    const x = quartersToX(v, 1 / 3 + 1 / 6) // the note's own centre, 48 px
    expect(hitNote(v, index, layers, 'A', x, rowY(v))?.id).toBe('offgrid')

    // The slot the same point resolves to under the new grid is a different instant.
    const slot = pointToSlot(v, always({ split: 4 }), x, rowY(v))!
    expect(slot.pos).toEqual(pos(0, 2, 4))
    expect(slot.pos.frac).not.toEqual(note.pos.frac)
  })

  it('prefers the active layer, then descending order', () => {
    const v = vp()
    const index = NoteIndex.build([
      mk('onA', 'A', 0, P),
      mk('onB', 'B', 0, P),
      mk('onC', 'C', 0, P),
    ])
    const x = 48
    // Active layer wins even though C has the highest order.
    expect(hitNote(v, index, layers, 'A', x, rowY(v), { includeInactive: true })?.id).toBe('onA')
    // With A inactive, the highest order among the rest wins.
    expect(hitNote(v, index, layers, 'B', x, rowY(v), { includeInactive: true })?.id).toBe('onB')
    expect(hitNote(v, index, layers, 'A', 200, rowY(v), { includeInactive: true })).toBeNull()
  })

  it('makes non-active layers pointer-transparent unless asked otherwise', () => {
    const v = vp()
    const index = NoteIndex.build([mk('onC', 'C', 0, P)])
    expect(hitNote(v, index, layers, 'A', 48, rowY(v))).toBeNull()
    expect(hitNote(v, index, layers, 'A', 48, rowY(v), { includeInactive: true })?.id).toBe('onC')
    // Descending order decides between two inactive layers.
    const both = NoteIndex.build([mk('onB', 'B', 0, P), mk('onC', 'C', 0, P)])
    expect(hitNote(v, both, layers, 'A', 48, rowY(v), { includeInactive: true })?.id).toBe('onC')
  })

  it('never hits a hidden layer', () => {
    const v = vp()
    const hidden = [layer('A', 0, false), layer('C', 2, false)]
    const index = NoteIndex.build([mk('onA', 'A', 0, P), mk('onC', 'C', 0, P)])
    expect(hitNote(v, index, hidden, 'A', 48, rowY(v), { includeInactive: true })).toBeNull()
  })

  it('resolves same-cell ties shortest-first, then most-recently-added', () => {
    const v = vp()
    const index = NoteIndex.build([mk('long', 'A', 0, P, [4, 1]), mk('short', 'A', 0, P)])
    expect(hitNote(v, index, layers, 'A', 48, rowY(v))?.id).toBe('short')

    const tied = NoteIndex.build([mk('older', 'A', 0, P), mk('newer', 'A', 0, P)])
    expect(hitNote(v, tied, layers, 'A', 48, rowY(v))?.id).toBe('newer')
  })

  it('uses the caller-supplied slot width, so hits match the drawn geometry', () => {
    const v = vp()
    const note = mk('n', 'A', 0, P) // one quarter, in a { split: 4 } column
    const index = NoteIndex.build([note])
    const opts = { slotWidthPx: () => 24 }
    // Drawn from the first slot's centre (12 px) to the last slot's centre (84 px).
    expect(hitNote(v, index, layers, 'A', 12, rowY(v), opts)?.id).toBe('n')
    expect(hitNote(v, index, layers, 'A', 84, rowY(v), opts)?.id).toBe('n')
    // Without the slot width the same note is a circle centred at 48 px.
    expect(hitNote(v, index, layers, 'A', 84, rowY(v))).toBeNull()
  })

  it('returns null outside the MIDI range', () => {
    const v = vp()
    const index = NoteIndex.build([mk('n', 'A', 0, P)])
    expect(hitNote(v, index, layers, 'A', 48, rowY(v, 128))).toBeNull()
  })
})

describe('resizeZone', () => {
  it('is disabled below a 16 px stone, so click-to-remove stays reachable (§7.3)', () => {
    // Minimum zoom: 24 px/quarter, 8 px/semitone — a 6.72 px stone that a fixed
    // 6 px zone would swallow whole.
    const v = vp({ pxPerQuarter: 24, pxPerSemitone: 8 })
    const note = mk('n', 'A', 0, P)
    const rect = noteRect(v, note)
    expect(rect.width).toBeCloseTo(8 * 0.42 * 2, 9)
    expect(rect.width).toBeLessThan(16)
    expect(resizeZone(v, note, rect.x + rect.width)).toBe(false)
    expect(resizeZone(v, note, rect.x + rect.width - 1)).toBe(false)
    // …and the stone is still clickable, which is the point of disabling it.
    const index = NoteIndex.build([note])
    expect(hitNote(v, index, [layer('A', 0)], 'A', 12, rowY(v))?.id).toBe('n')
  })

  it('is enabled once the stone is large enough, capped at 6 px', () => {
    const v = vp({ pxPerSemitone: 48 })
    const note = mk('n', 'A', 0, P)
    const rect = noteRect(v, note)
    const right = rect.x + rect.width
    expect(rect.width).toBeGreaterThanOrEqual(16)
    expect(resizeZone(v, note, right)).toBe(true)
    expect(resizeZone(v, note, right - 5.9)).toBe(true)
    expect(resizeZone(v, note, right - 6.1)).toBe(false)
    expect(resizeZone(v, note, right + 1)).toBe(false)
    expect(resizeZone(v, note, rect.x + 1)).toBe(false)
  })

  it('sits at the right cap of a lozenge, not at the note end', () => {
    const v = vp({ pxPerSemitone: 48 })
    const note = mk('n', 'A', 0, P, [4, 1])
    const rect = noteRect(v, note)
    expect(resizeZone(v, note, rect.x + rect.width - 1)).toBe(true)
    expect(resizeZone(v, note, rect.x + rect.width / 2)).toBe(false)
  })

  it('narrows the zone to a quarter of a mid-sized stone', () => {
    // 20 px stone -> zone is 5 px, not 6.
    const v = vp({ pxPerSemitone: 20 / 0.84 })
    const note = mk('n', 'A', 0, P)
    const rect = noteRect(v, note)
    expect(rect.width).toBeCloseTo(20, 9)
    const right = rect.x + rect.width
    expect(resizeZone(v, note, right - 4.9)).toBe(true)
    expect(resizeZone(v, note, right - 5.1)).toBe(false)
  })
})

describe('createDragLatch', () => {
  it('latches at the mouse threshold and never re-arms (§7.3)', () => {
    const latch = createDragLatch(100, 100)
    expect(latch.dragging).toBe(false)
    expect(latch.update(102, 100)).toBe(false)
    expect(latch.update(100, 100 + DRAG_THRESHOLD_MOUSE)).toBe(false)
    expect(latch.update(105, 100)).toBe(true)
    expect(latch.dragging).toBe(true)
    // Returning to the origin must never re-arm the click.
    expect(latch.update(100, 100)).toBe(true)
    expect(latch.update(100.0001, 99.9999)).toBe(true)
    expect(latch.dragging).toBe(true)
  })

  it('measures euclidean distance, not per-axis', () => {
    const latch = createDragLatch(0, 0)
    expect(latch.update(3, 3)).toBe(true) // 4.24 px, though neither axis crosses 4
  })

  it('takes a larger threshold for touch', () => {
    expect(DRAG_THRESHOLD_TOUCH).toBeGreaterThan(DRAG_THRESHOLD_MOUSE)
    const latch = createDragLatch(0, 0, DRAG_THRESHOLD_TOUCH)
    expect(latch.update(8, 0)).toBe(false)
    expect(latch.update(11, 0)).toBe(true)
    expect(latch.update(0, 0)).toBe(true)
  })
})

describe('resize zone at the default zoom', () => {
  it('is enabled at 16 px/semitone and disabled at minimum zoom', () => {
    // Regression: a 16 px threshold would have disabled resize at the DEFAULT zoom,
    // since a one-slot stone is only pxPerSemitone * 0.84 wide (§7.3).
    const note: Note = {
      id: 'n', layerId: 'L1', pos: pos(0), dur: frac(1), pitch: 60,
    }
    const dflt: Viewport = { xQuarters: 0, yPitch: 70, pxPerQuarter: 96, pxPerSemitone: 16 }
    const rect = noteRect(dflt, note, 96)
    expect(rect.width).toBeGreaterThan(RESIZE_ZONE_MIN_STONE_PX)
    expect(resizeZone(dflt, note, rect.x + rect.width - 1, 96)).toBe(true)

    const minZoom: Viewport = { xQuarters: 0, yPitch: 70, pxPerQuarter: 24, pxPerSemitone: 8 }
    const small = noteRect(minZoom, note, 24)
    expect(small.width).toBeLessThan(RESIZE_ZONE_MIN_STONE_PX)
    expect(resizeZone(minZoom, note, small.x + small.width - 0.5, 24)).toBe(false)
  })
})
