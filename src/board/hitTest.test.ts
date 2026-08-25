import { describe, expect, it } from 'vitest'
import type { Note } from '../core/types'
import { frac } from '../core/frac'
import { pos, toQuarters } from '../core/pos'
import { createGridCursor } from '../core/gridCursor'
import { slotAt, slotStartsIn } from '../core/grid'
import type { GridRegion } from '../core/grid'
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

/** Quarter grid (no regions), for the tests that don't care about a coarser grid. */
const quarterCursor = () => createGridCursor([])

describe('pointToSlot', () => {
  it('resolves to the nearer of two default-grid (whole quarter) intersections', () => {
    const v = vp()
    const cursor = quarterCursor()
    // 50 px is 50 from the intersection at col 0 and 46 from the one at col 1 — nearer
    // to col 1. (Old cell-containment semantics put this in col 0 — see §F9 in the report.)
    const hit = pointToSlot(v, cursor, 50, rowY(v))
    expect(hit).not.toBeNull()
    expect(hit!.pos).toEqual(pos(1))
    expect(hit!.dur).toEqual(frac(1, 1))
    expect(hit!.pitch).toBe(P)
    // 20 px is nearer to col 0.
    expect(pointToSlot(v, cursor, 20, rowY(v))!.pos).toEqual(pos(0))
  })

  it('resolves within a uniform 16th grid to exact fractions, snapped to the nearer line', () => {
    const v = vp()
    const cursor = createGridCursor([{ start: pos(0), value: frac(1, 4) }])
    for (let i = 0; i < 4; i++) {
      // 2 px past the start of slot i — 22 px from the next line, so unambiguously nearer
      // to this one. (The old test queried the MIDPOINT of each slot; under
      // nearest-intersection a midpoint is an exact tie between its two bounding lines,
      // so the query point moved off it — see §F9.)
      const hit = pointToSlot(v, cursor, i * 24 + 2, rowY(v))!
      expect(hit.pos).toEqual(pos(0, i, 4))
      expect(hit.dur).toEqual(frac(1, 4))
    }
  })

  it('follows a region boundary into a finer grid, each slot keeping its own denominator', () => {
    const v = vp()
    // Whole quarters up to col 0 + 3/4, then that last quarter re-gridded into triplet
    // 32nds — the region-based analogue of the old "triplet on the last 16th" example.
    const regions: readonly GridRegion[] = [
      { start: pos(0), value: frac(1, 4) },
      { start: pos(0, 3, 4), value: frac(1, 12) },
    ]
    const cursor = createGridCursor(regions)
    // Before the region change: 2 px past the line at x=0, keeps the coarser denominator.
    const before = pointToSlot(v, cursor, 2, rowY(v))!
    expect(before.pos).toEqual(pos(0, 0, 4))
    expect(before.dur).toEqual(frac(1, 4))
    // 2 px past the region boundary itself (72 px = 0.75 of a quarter).
    const at = pointToSlot(v, cursor, 74, rowY(v))!
    expect(at.pos).toEqual(pos(0, 3, 4))
    expect(at.dur).toEqual(frac(1, 12))
    // One triplet-32nd line further in (80 px = 0.75 + 1/12 = 5/6 of a quarter).
    const next = pointToSlot(v, cursor, 82, rowY(v))!
    expect(next.pos.frac).toEqual(frac(5, 6))
    expect(next.dur).toEqual(frac(1, 12))
  })

  it('snaps exactly onto an intersection at zero distance', () => {
    const v = vp()
    const cursor = createGridCursor([{ start: pos(0), value: frac(1, 4) }])
    expect(pointToSlot(v, cursor, 0, rowY(v))!.pos).toEqual(pos(0, 0, 4))
    expect(pointToSlot(v, cursor, 24, rowY(v))!.pos).toEqual(pos(0, 1, 4))
    // 23.9 is 0.1 px from the line at 24 and 23.9 px from the one at 0 — nearer to 24.
    // (Old half-open cell semantics put this in slot 0; nearest-intersection puts it in
    // slot 1 — this is the exact flip named in ruling §F9.)
    expect(pointToSlot(v, cursor, 23.9, rowY(v))!.pos).toEqual(pos(0, 1, 4))
    expect(pointToSlot(v, cursor, 96, rowY(v))!.pos).toEqual(pos(1, 0, 4))
  })

  it('resolves a quintuplet boundary correctly despite binary float imprecision', () => {
    const v = vp()
    const cursor = createGridCursor([{ start: pos(0), value: frac(1, 5) }])
    // The second boundary of a quintuplet at 96 px/quarter sits at 19.2 px, and
    // 19.2 / 96 * 5 evaluates to 0.9999999999999999 — a naive floor would land this in
    // the slot before the one the boundary actually starts.
    expect(19.2 / 96 * 5).toBeLessThan(1)
    const hit = pointToSlot(v, cursor, 19.2, rowY(v))!
    expect(hit.pos).toEqual(pos(0, 1, 5))
    expect(hit.dur).toEqual(frac(1, 5))
    // 19 px is only 0.2 px from that same boundary (vs 19 px from the one at 0) — nearer
    // to slot 1. (Old containment semantics put this in slot 0 — see §F9.)
    expect(pointToSlot(v, cursor, 19, rowY(v))!.pos).toEqual(pos(0, 1, 5))
    // Genuinely nearer to the boundary at 0 than to the one at 19.2.
    expect(pointToSlot(v, cursor, 5, rowY(v))!.pos).toEqual(pos(0, 0, 5))
  })

  it('agrees with the region grid at every slot start it reports', () => {
    const v = vp()
    const regions: readonly GridRegion[] = [
      { start: pos(0), value: frac(1, 4) },
      { start: pos(0, 3, 4), value: frac(1, 12) },
    ]
    const cursor = createGridCursor(regions)
    for (const start of slotStartsIn(regions, pos(0), pos(1))) {
      const x = quartersToX(v, toQuarters(start))
      const hit = pointToSlot(v, cursor, x, rowY(v))!
      expect(hit.pos).toEqual(start)
      expect(hit.dur).toEqual(slotAt(regions, start).dur)
    }
  })

  it('builds fractions from region arithmetic, never from the float pixel position', () => {
    const v = vp({ pxPerQuarter: 100 })
    const cursor = createGridCursor([{ start: pos(0), value: frac(1, 7) }])
    // 1/7 of a 100 px column is 14.2857… px — a position no float can hold exactly, and
    // 16 px is nearer to that line than to the one at 0 or the one at 2/7 (28.57 px).
    const hit = pointToSlot(v, cursor, 16, rowY(v))!
    expect(hit.pos.frac).toEqual(frac(1, 7))
    expect(hit.dur).toEqual(frac(1, 7))
    expect(hit.pos.frac.d).toBe(7)
  })

  it('handles negative columns and negative x on the default grid', () => {
    const v = vp()
    const cursor = quarterCursor()
    expect(pointToSlot(v, cursor, -10, rowY(v))!.pos).toEqual(pos(0)) // nearer to 0 than -96
    expect(pointToSlot(v, cursor, -50, rowY(v))!.pos).toEqual(pos(-1)) // nearer to -96 than 0
    expect(pointToSlot(v, cursor, -96, rowY(v))!.pos).toEqual(pos(-1)) // exact intersection
  })

  it('anchors a region\'s phase at its own (possibly negative) start, not at column 0', () => {
    const v = vp()
    // An 8th-note grid phased from col -3 onward: lines at -3, -2.5, -2, -1.5, -1, -0.5, 0…
    const cursor = createGridCursor([{ start: pos(-3), value: frac(1, 2) }])
    // -50 px = -0.5208 of a quarter: 2 px from the line at -0.5 (-48 px), 46 px from -1 (-96 px).
    const hit = pointToSlot(v, cursor, -50, rowY(v))!
    expect(hit.pos).toEqual(pos(-1, 1, 2))
    expect(hit.dur).toEqual(frac(1, 2))
  })

  it('returns null outside the MIDI range', () => {
    const v = vp()
    const cursor = quarterCursor()
    expect(pointToSlot(v, cursor, 10, rowY(v, 127))).not.toBeNull()
    expect(pointToSlot(v, cursor, 10, rowY(v, 0))).not.toBeNull()
    expect(pointToSlot(v, cursor, 10, rowY(v, 128))).toBeNull()
    expect(pointToSlot(v, cursor, 10, rowY(v, -1))).toBeNull()
  })
})

describe('pointToSlot on grid regions', () => {
  it('snaps to the nearest intersection, not the containing cell', () => {
    const cursor = createGridCursor([]) // quarter grid
    // 0.6 of a quarter in: nearer to the NEXT intersection.
    expect(pointToSlot(vp(), cursor, 0.6 * 96, 100)?.pos).toEqual(pos(1))
    expect(pointToSlot(vp(), cursor, 0.4 * 96, 100)?.pos).toEqual(pos(0))
  })

  it('snaps on a coarse grid', () => {
    const cursor = createGridCursor([{ start: pos(0), value: frac(2) }])
    expect(pointToSlot(vp(), cursor, 1.2 * 96, 100)?.pos).toEqual(pos(2))
    expect(pointToSlot(vp(), cursor, 0.7 * 96, 100)?.pos).toEqual(pos(0))
  })

  it('reports the slot duration of the intersection it chose, clipped', () => {
    const cursor = createGridCursor([
      { start: pos(0), value: frac(2, 3) },
      { start: pos(1), value: frac(1, 4) },
    ])
    const hit = pointToSlot(vp(), cursor, (2 / 3) * 96 + 2, 100)
    expect(hit?.pos).toEqual(pos(0, 2, 3))
    expect(hit?.dur).toEqual(frac(1, 3)) // clipped by the region boundary at col 1
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
    // Explicit one-quarter slot width: without it, the note's own (4-quarter) duration
    // would now be the assumed slot (§3.3 fix below) and it would draw as a one-slot
    // circle instead of a lozenge — this test is about a note longer than its SLOT.
    const head = noteRect(v, mk('n', 'A', 0, P), 96)
    const long = noteRect(v, mk('n', 'A', 0, P, [4, 1]), 96)
    expect(long.x).toBeCloseTo(head.x, 9)
    expect(long.height).toBeCloseTo(head.height, 9)
    expect(long.width).toBeCloseTo(head.width + 3 * 96, 9)
  })

  it('does not clamp an unsupplied slot width to one column on a coarse grid (§3.3)', () => {
    // The bug the spec calls out: `noteRect` used to default an OMITTED slot width to
    // `vp.pxPerQuarter` — one column — which is what made a whole note with no known
    // slot draw as a per-column lozenge (301.44 px: exactly what the "stretches a
    // longer note" test above gets when it explicitly asks for a 96 px slot). With the
    // default fixed to fall back to the note's own duration, the same call — no third
    // argument — no longer assumes a column and draws as a single one-slot circle.
    const v = vp()
    const note = mk('n', 'A', 0, P, [4, 1]) // whole note, slot width unknown
    const rect = noteRect(v, note)
    const r = 16 * 0.42 // bound by pxPerSemitone regardless of the (4-column) duration
    expect(rect.width).toBeCloseTo(2 * r, 9)
    // Contrast: the old, buggy default clamped to 96 px and produced 301.44 px here.
    expect(rect.width).toBeLessThan(3 * 96)
  })

  it('honours an explicitly wider-than-column slot for a shorter note inside it', () => {
    // A whole-note grid slot is 4 columns wide. A half note placed inside one is
    // shorter than its slot, so it still draws as a circle — but sized and centred
    // using the FULL 384 px slot, never re-clamped down to one column's 96 px.
    const v = vp()
    const wholeSlot = 4 * 96
    const half = noteRect(v, mk('n', 'A', 0, P, [2, 1]), wholeSlot) // half note in it
    const r = 16 * 0.42
    // unit = min(slotW, durW) = min(384, 192) = 192.
    expect(half.width).toBeCloseTo(2 * r, 9)
    expect(half.x + half.width / 2).toBeCloseTo(192 / 2, 9) // centred 96 px in
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
    // click lands three columns to the right of it. Slot width is given explicitly —
    // §3.3's fixed default now assumes an unknown slot equals the note's OWN duration
    // (no lozenge at all), so a real lozenge here needs an explicit one-quarter slot.
    const v = vp()
    const note = mk('long', 'A', 0, P, [4, 1])
    const index = NoteIndex.build([note])
    const opts = { slotWidthPx: () => 96 }
    const rect = noteRect(v, note, 96)

    expect(hitNote(v, index, layers, 'A', 336, rowY(v), opts)?.id).toBe('long')
    expect(hitNote(v, index, layers, 'A', rect.x + rect.width - 0.5, rowY(v), opts)?.id).toBe('long')
    expect(hitNote(v, index, layers, 'A', 200, rowY(v), opts)?.id).toBe('long')
    // Past the lozenge's right cap there is nothing to hit.
    expect(hitNote(v, index, layers, 'A', rect.x + rect.width + 2, rowY(v), opts)).toBeNull()
    // Nor above the row.
    expect(hitNote(v, index, layers, 'A', 200, rowY(v) - 15, opts)).toBeNull()
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
    const cursor = createGridCursor([{ start: pos(0), value: frac(1, 4) }])
    const slot = pointToSlot(v, cursor, x, rowY(v))!
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
    // Explicit slot width so 'long' is really a candidate at x=48 (a real tie), not
    // just absent — see the §3.3 default fix in the test above.
    const index = NoteIndex.build([mk('long', 'A', 0, P, [4, 1]), mk('short', 'A', 0, P)])
    const opts = { slotWidthPx: () => 96 }
    expect(hitNote(v, index, layers, 'A', 48, rowY(v), opts)?.id).toBe('short')

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
    // Explicit one-quarter slot width, so the note actually forms a lozenge — see the
    // §3.3 default fix above.
    const v = vp({ pxPerSemitone: 48 })
    const note = mk('n', 'A', 0, P, [4, 1])
    const rect = noteRect(v, note, 96)
    expect(resizeZone(v, note, rect.x + rect.width - 1, 96)).toBe(true)
    expect(resizeZone(v, note, rect.x + rect.width / 2, 96)).toBe(false)
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
