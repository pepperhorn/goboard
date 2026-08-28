import { describe, expect, it } from 'vitest'
import type { Note } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import type { GridRegion } from '../core/grid'
import { createGridCursor } from '../core/gridCursor'
import { effectiveVelocity } from '../audio/scheduler'
import { BoardStore } from '../state/boardStore'
import { createEmptyProject } from '../io/project'
import type { Viewport } from './viewport'
import {
  LANE_HEIGHT,
  MAX_VELOCITY,
  bucketBySlot,
  drawLane,
  ghostVelocity,
  laneSlotAt,
  laneVelocities,
  noteSegments,
  segmentIndexAt,
  slotColumns,
  slotIsColumnAligned,
  slotKey,
  slotSegments,
  velocityAtY,
  velocityToY,
} from './lane'
import type { LaneLayer, LaneScene } from './lane'

/**
 * Headless coverage for the lane's geometry and its velocity resolution (§6.2), now
 * slot-scoped over grid regions rather than column-scoped over subdivisions (§3.4).
 * Nothing here touches a canvas — the drawing function is a thin consumer of these
 * same helpers, which is why they are exported rather than inlined into the paint.
 */

const vp: Viewport = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }

/** No regions at all: the implicit default of one slot per quarter note (§3.2). */
const QUARTERS: readonly GridRegion[] = []
/** Sixteenths — four slots per column, the old `{split:4}`. */
const SIXTEENTHS: readonly GridRegion[] = [{ start: pos(0), value: frac(1, 4) }]
/** Triplets — the case a float `Math.floor` used to get wrong on the boundary. */
const TRIPLETS: readonly GridRegion[] = [{ start: pos(0), value: frac(1, 3) }]
/** A half-note grid: ONE slot spanning TWO columns. Impossible under `Subdiv`. */
const HALVES: readonly GridRegion[] = [{ start: pos(0), value: frac(2) }]

const cursorOn = (regions: readonly GridRegion[]) => createGridCursor(regions)

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
  it('resolves the implicit default grid to a whole-column slot', () => {
    expect(laneSlotAt(vp, cursorOn(QUARTERS), 40)).toEqual({ start: pos(0), dur: frac(1) })
  })

  it('lands on the slot a boundary starts, not the one it ends', () => {
    // Sixteenths at 96 px/quarter: boundaries at x = 0, 24, 48, 72.
    const cursor = cursorOn(SIXTEENTHS)
    for (const [x, n] of [[0, 0], [24, 1], [48, 2], [72, 3]] as const) {
      expect(laneSlotAt(vp, cursor, x)?.start).toEqual(pos(0, n, 4))
    }
    // One pixel short of a boundary is still the previous slot.
    expect(laneSlotAt(vp, cursorOn(SIXTEENTHS), 23.999)?.start).toEqual(pos(0))
  })

  it('keeps a triplet boundary exact rather than float-rounded', () => {
    // 32 px is 1/3 of a quarter; `ceil`/`floor` on the float lands on the wrong side.
    const cursor = cursorOn(TRIPLETS)
    expect(laneSlotAt(vp, cursor, 32)).toEqual({ start: pos(0, 1, 3), dur: frac(1, 3) })
    expect(laneSlotAt(vp, cursorOn(TRIPLETS), 64)?.start).toEqual(pos(0, 2, 3))
    expect(laneSlotAt(vp, cursorOn(TRIPLETS), 31.9)?.start).toEqual(pos(0))
  })

  it('returns ONE slot for a whole span of columns under a coarse grid', () => {
    const cursor = cursorOn(HALVES)
    // Columns 0 and 1 are the same slot; column 2 starts the next one.
    expect(laneSlotAt(vp, cursor, 10)).toEqual({ start: pos(0), dur: frac(2) })
    expect(laneSlotAt(vp, cursor, 100)).toEqual({ start: pos(0), dur: frac(2) })
    expect(laneSlotAt(vp, cursor, 192)).toEqual({ start: pos(2), dur: frac(2) })
  })

  it('reports a clipped slot at a region boundary, and it is a real slot', () => {
    // A same-valued region half a column in is a phase reset (§3.2): the slot before
    // it is clipped to 1/2 rather than overlapping.
    const regions: readonly GridRegion[] = [
      { start: pos(0), value: frac(1) },
      { start: pos(0, 1, 2), value: frac(1) },
    ]
    expect(laneSlotAt(vp, cursorOn(regions), 10)).toEqual({ start: pos(0), dur: frac(1, 2) })
    expect(laneSlotAt(vp, cursorOn(regions), 60)).toEqual({ start: pos(0, 1, 2), dur: frac(1) })
  })

  it('crosses into the next region with that region own value', () => {
    const regions: readonly GridRegion[] = [
      { start: pos(0), value: frac(1, 4) },
      { start: pos(1), value: frac(1, 2) },
    ]
    const cursor = cursorOn(regions)
    expect(laneSlotAt(vp, cursor, 0)).toEqual({ start: pos(0), dur: frac(1, 4) })
    expect(laneSlotAt(vp, cursor, 96)).toEqual({ start: pos(1), dur: frac(1, 2) })
    expect(laneSlotAt(vp, cursor, 144)).toEqual({ start: pos(1, 1, 2), dur: frac(1, 2) })
    expect(laneSlotAt(vp, cursorOn(regions), 95.999)?.start).toEqual(pos(0, 3, 4))
  })

  it('handles negative columns, since the board is boundless', () => {
    const regions: readonly GridRegion[] = [{ start: pos(-4), value: frac(1, 4) }]
    expect(laneSlotAt(vp, cursorOn(regions), -1)?.start).toEqual(pos(-1, 3, 4))
  })

  it('governs the space left of every region with the implicit default, clipped', () => {
    // Anchored MID-column, so the clip is real rather than incidental: a region
    // starting on a column boundary would end the default slot where it ended anyway.
    const late: readonly GridRegion[] = [{ start: pos(0, 1, 2), value: frac(1, 4) }]
    // Well left of the region: the implicit one-slot-per-quarter default, uncut.
    expect(laneSlotAt(vp, cursorOn(late), -1)).toEqual({ start: pos(-1), dur: frac(1) })
    // The default slot that runs INTO the region is cut short at the region's start —
    // half a quarter, not a whole one — and that clipped slot is a real, editable slot.
    expect(laneSlotAt(vp, cursorOn(late), 10)).toEqual({ start: pos(0), dur: frac(1, 2) })
    // ...and the region's own phase starts there, at its own value.
    expect(laneSlotAt(vp, cursorOn(late), 60)).toEqual({ start: pos(0, 1, 2), dur: frac(1, 4) })
  })

  it('respects a panned/zoomed viewport rather than deriving its own', () => {
    const panned: Viewport = { ...vp, xQuarters: 3.5, pxPerQuarter: 48 }
    // x = 24 px is 0.5 quarters right of the left edge: col 4, offset 0.
    expect(laneSlotAt(panned, cursorOn(QUARTERS), 24)?.start).toEqual(pos(4))
  })

  it('returns null only for a non-finite x', () => {
    expect(laneSlotAt(vp, cursorOn(QUARTERS), Number.NaN)).toBeNull()
    expect(laneSlotAt(vp, cursorOn(QUARTERS), -100000)).not.toBeNull()
  })
})

describe('slotColumns (design §3.4)', () => {
  it('is the half-open column range a slot covers', () => {
    expect(slotColumns({ start: pos(0), dur: frac(1) })).toEqual({ fromCol: 0, toCol: 1 })
    expect(slotColumns({ start: pos(0), dur: frac(2) })).toEqual({ fromCol: 0, toCol: 2 })
    expect(slotColumns({ start: pos(0), dur: frac(4) })).toEqual({ fromCol: 0, toCol: 4 })
  })

  it('rounds a partial column up, in integers rather than through a float', () => {
    // 1/3 through `ceil(toQuarters(...))` is exactly the value that lands wrong.
    expect(slotColumns({ start: pos(0), dur: frac(1, 3) })).toEqual({ fromCol: 0, toCol: 1 })
    expect(slotColumns({ start: pos(0, 2, 3), dur: frac(1, 3) })).toEqual({ fromCol: 0, toCol: 1 })
    expect(slotColumns({ start: pos(0, 2, 3), dur: frac(2, 3) })).toEqual({ fromCol: 0, toCol: 2 })
    expect(slotColumns({ start: pos(-1), dur: frac(2) })).toEqual({ fromCol: -1, toCol: 1 })
  })

  it('marks only column-aligned whole-column slots as column edits', () => {
    expect(slotIsColumnAligned({ start: pos(0), dur: frac(1) })).toBe(true)
    expect(slotIsColumnAligned({ start: pos(0), dur: frac(2) })).toBe(true)
    expect(slotIsColumnAligned({ start: pos(0), dur: frac(1, 2) })).toBe(false)
    expect(slotIsColumnAligned({ start: pos(0, 1, 2), dur: frac(1) })).toBe(false)
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
    expect(laneVelocities(l).ghostOf(pos(5))).toBe(110)
    expect(laneVelocities(l).ghostOf(pos(4))).toBe(72)
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
    const v = laneVelocities(l, { slots: new Map([[slotKey(pos(1, 1, 2)), 55]]) })
    const n = note({ pos: pos(1) })
    expect(v.velOf(n, pos(1, 1, 2))).toBe(55)
    expect(v.velOf(n, pos(1, 3, 4))).toBe(100)
    expect(v.ghostOf(pos(1, 1, 2))).toBe(55)
    expect(v.ghostOf(pos(1, 3, 4))).toBe(100)
  })

  it('lets an Alt-drag note override outrank the slot drag, mirroring §6.1', () => {
    const n = note({ pos: pos(1) })
    const v = laneVelocities(l, {
      slots: new Map([[slotKey(pos(1)), 55]]),
      notes: new Map([[n.id, 20]]),
    })
    expect(v.velOf(n, pos(1))).toBe(20)
  })

  it('shows a multi-column slot the value at its STARTING column (§3.4)', () => {
    // A whole-note slot covers columns 0-3; column 2 carries a stale 100.
    const coarse = layer({ defaultVel: 80, colVel: new Map([[0, 40], [2, 100]]) })
    expect(laneVelocities(coarse).ghostOf(pos(0))).toBe(40)
    expect(laneVelocities(coarse).ghostOf(pos(4))).toBe(80)
  })

  it('leaves note-level resolution alone, on-grid or off', () => {
    // §6.1 is untouched: a note still resolves through its OWN column, even when the
    // slot it is drawn in starts somewhere else.
    const coarse = layer({ defaultVel: 80, colVel: new Map([[0, 40], [2, 100]]) })
    const inCol2 = note({ pos: pos(2, 1, 5) })
    expect(laneVelocities(coarse).velOf(inCol2, pos(0))).toBe(100)
    expect(effectiveVelocity(inCol2, coarse)).toBe(100)
  })
})

describe('bucketBySlot', () => {
  it('keys buckets by slot start, not by column and index', () => {
    const regions: readonly GridRegion[] = [{ start: pos(0), value: frac(1, 2) }]
    const notes = [note({ pos: pos(0) }), note({ pos: pos(0, 1, 2) })]
    const buckets = bucketBySlot(regions, notes)
    expect([...buckets.keys()]).toEqual([slotKey(pos(0)), slotKey(pos(0, 1, 2))])
  })

  it('puts both columns of a half-note slot in one bucket', () => {
    const notes = [
      note({ pos: pos(0), dur: frac(2) }),
      note({ pos: pos(1), dur: frac(1) }), // off-grid, inside the same slot
    ]
    expect(bucketBySlot(HALVES, notes).get(slotKey(pos(0)))).toHaveLength(2)
    expect(bucketBySlot(HALVES, notes).size).toBe(1)
  })

  it('keeps an off-grid note in the slot that contains it', () => {
    // 1/5 of a quarter is on no sixteenth line; it sits inside the slot at 0.
    const off = note({ pos: pos(0, 1, 5) })
    expect(bucketBySlot(SIXTEENTHS, [off]).get(slotKey(pos(0)))).toEqual([off])
  })

  it('collapses to one bucket under the implicit default grid', () => {
    const notes = [note({ pos: pos(3) }), note({ pos: pos(3, 1, 3) })]
    const buckets = bucketBySlot(QUARTERS, notes)
    expect(buckets.size).toBe(1)
    expect(buckets.get(slotKey(pos(3)))).toHaveLength(2)
  })

  it('buckets across a region boundary, clipped slot included', () => {
    const regions: readonly GridRegion[] = [
      { start: pos(0), value: frac(2) },
      { start: pos(1), value: frac(1, 2) },
    ]
    // The slot at 0 is clipped to [0, 1); the region change starts a fresh phase.
    const a = note({ pos: pos(0, 1, 2) })
    const b = note({ pos: pos(1, 1, 4) })
    const buckets = bucketBySlot(regions, [a, b])
    expect(buckets.get(slotKey(pos(0)))).toEqual([a])
    expect(buckets.get(slotKey(pos(1)))).toEqual([b])
  })
})

// --- drawLane: the loop restructure ------------------------------------------------

/**
 * `drawLane` batches into `Path2D`, which the node test environment has no
 * implementation of. Recording stubs give the test what it actually needs to assert:
 * how many cells the walk produced and where they were.
 */
type StubRect = { x: number; y: number; w: number; h: number }

class StubPath {
  static made: StubPath[] = []
  readonly rects: StubRect[] = []
  constructor() {
    StubPath.made.push(this)
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h })
  }
  moveTo(): void {}
  lineTo(): void {}
}

const stubCtx = (): CanvasRenderingContext2D =>
  ({
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: () => {},
    fill: () => {},
    stroke: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
  }) as unknown as CanvasRenderingContext2D

/** Run one lane frame and hand back the two paths the assertions care about. */
function paint(scene: LaneScene, size = { width: 384, height: 96 }, view: Viewport = vp) {
  const prev = (globalThis as { Path2D?: unknown }).Path2D
  ;(globalThis as { Path2D?: unknown }).Path2D = StubPath
  StubPath.made = []
  try {
    const drawn = drawLane(stubCtx(), view, size, scene, 1)
    // Construction order inside `drawLane`: rules, bars, ghosts, caps.
    return { drawn, bars: StubPath.made[1]!, ghosts: StubPath.made[2]! }
  } finally {
    ;(globalThis as { Path2D?: unknown }).Path2D = prev
  }
}

const laneScene = (over: Partial<LaneScene> = {}): LaneScene => ({
  layer: layer(),
  grid: QUARTERS,
  notesInRange: () => [],
  showGhosts: false,
  ...over,
})

describe('drawLane over grid regions', () => {
  it('draws one cell per column under the default grid', () => {
    // 384 px at 96 px/quarter is columns 0-3, plus the boundary column 4.
    const { drawn } = paint(laneScene({ showGhosts: true }))
    expect(drawn).toBe(5)
  })

  it('draws ONE cell for a slot that spans two columns, not one per column', () => {
    const notes = [note({ pos: pos(0), dur: frac(2) }), note({ pos: pos(1), dur: frac(1) })]
    const { drawn, bars } = paint(
      laneScene({ grid: HALVES, notesInRange: () => notes }),
    )
    // Both notes inherit the same velocity, so the single slot is a single segment.
    expect(drawn).toBe(1)
    expect(bars.rects).toHaveLength(1)
    // ...and that one bar spans both columns, ~192 px wide rather than ~96.
    expect(bars.rects[0]!.w).toBeGreaterThan(180)
  })

  it('gives a whole-note slot one cell across four columns', () => {
    const grid: readonly GridRegion[] = [{ start: pos(0), value: frac(4) }]
    const { drawn, ghosts } = paint(laneScene({ grid, showGhosts: true }))
    // Slots start at 0 and 4; both are within the walked span.
    expect(drawn).toBe(2)
    expect(ghosts.rects[0]!.w).toBeGreaterThan(370)
  })

  it('ghosts a multi-column slot at its STARTING column value (§3.4)', () => {
    const l = layer({ defaultVel: 80, colVel: new Map([[0, 40], [1, 127]]) })
    const { ghosts } = paint(laneScene({ layer: l, grid: HALVES, showGhosts: true }))
    // The renderer snaps to a device pixel; at dpr 1 that is a plain round.
    expect(ghosts.rects[0]!.y).toBe(Math.round(velocityToY(96, 40)))
  })

  it('draws the cell of a slot that starts left of the viewport', () => {
    // Panned so the visible span opens mid-way through a whole-note slot.
    const grid: readonly GridRegion[] = [{ start: pos(0), value: frac(4) }]
    const { ghosts } = paint(
      laneScene({ grid, showGhosts: true }),
      { width: 384, height: 96 },
      { ...vp, xQuarters: 2 },
    )
    // The slot starting at column 0 is off-screen to the left but its cell is not.
    expect(ghosts.rects[0]!.x).toBeLessThan(0)
  })

  it('fetches the notes of a slot whose tail runs past the visible columns', () => {
    // The regression: `visibleCols` gives {start: 0, end: 5} here, but the last slot
    // the walk draws is [4, 8) — its notes live in columns the old `end + 1` query
    // never reached, so the cell rendered as a ghost at the layer default instead of
    // as a bar at the note's own velocity. A column-scoped loop could not do this.
    const panned: Viewport = { ...vp, xQuarters: 0.5 }
    const grid: readonly GridRegion[] = [{ start: pos(0), value: frac(4) }]
    const loud = note({ pos: pos(6), dur: frac(1), vel: 20 })
    const range: number[] = []
    const scene = laneScene({
      grid,
      showGhosts: true,
      notesInRange: (s0, e0) => {
        range.push(s0, e0)
        // Stand in for `NoteIndex.queryRange`: half-open on the column.
        return loud.pos.col >= s0 && loud.pos.col < e0 ? [loud] : []
      },
    })
    const { bars, ghosts } = paint(scene, { width: 384, height: 96 }, panned)

    // The query must reach column 6, which is past `end + 1 === 6`.
    expect(range[1]).toBeGreaterThan(6)
    // Slot [0,4) is empty -> one ghost; slot [4,8) holds the note -> one bar at vel 20.
    expect(ghosts.rects).toHaveLength(1)
    expect(bars.rects).toHaveLength(1)
    expect(bars.rects[0]!.y).toBe(Math.round(velocityToY(96, 20)))
    // ...and NOT a ghost at the layer default, which is what the bug produced.
    expect(bars.rects[0]!.y).not.toBe(Math.round(velocityToY(96, 80)))
  })

  it('still reaches left when the coarse slot runs the other way', () => {
    // The left edge must not regress while the right one is fixed: `Math.min`/`Math.max`
    // widen independently.
    const grid: readonly GridRegion[] = [{ start: pos(0), value: frac(4) }]
    const early = note({ pos: pos(0), dur: frac(1), vel: 20 })
    const scene = laneScene({
      grid,
      showGhosts: true,
      notesInRange: (s0, e0) => (early.pos.col >= s0 && early.pos.col < e0 ? [early] : []),
    })
    const { bars } = paint(scene, { width: 384, height: 96 }, { ...vp, xQuarters: 2 })
    expect(bars.rects).toHaveLength(1)
    expect(bars.rects[0]!.y).toBe(Math.round(velocityToY(96, 20)))
  })

  it('draws a clipped slot as a real, narrower cell', () => {
    const grid: readonly GridRegion[] = [
      { start: pos(0), value: frac(4) },
      { start: pos(1), value: frac(4) },
    ]
    const { ghosts } = paint(laneScene({ grid, showGhosts: true }))
    // [0,1) clipped by the phase reset at column 1, then [1,5).
    expect(ghosts.rects[0]!.w).toBeGreaterThan(90)
    expect(ghosts.rects[0]!.w).toBeLessThan(96)
  })
})

describe('BoardStore.setColVelRange (design §3.4)', () => {
  const store = () => new BoardStore(createEmptyProject(), { width: 800, height: 600 })

  it('writes the value to every column a slot covers', () => {
    const s = store()
    const id = s.activeLayer().id
    s.setColVelRange(id, 0, 2, 40)
    expect(s.layer(id)!.colVel.get(0)).toBe(40)
    expect(s.layer(id)!.colVel.get(1)).toBe(40)
    expect(s.layer(id)!.colVel.get(2)).toBeUndefined() // half-open
  })

  it('clears stale entries inside the covered range', () => {
    const s = store()
    const id = s.activeLayer().id
    s.setColVelRange(id, 1, 2, 127)
    s.setColVelRange(id, 0, 4, 55)
    expect([0, 1, 2, 3].map((c) => s.layer(id)!.colVel.get(c))).toEqual([55, 55, 55, 55])
  })

  it('is one command', () => {
    const s = store()
    const id = s.activeLayer().id
    s.setColVelRange(id, 0, 4, 55)
    s.undo()
    expect(s.layer(id)!.colVel.size).toBe(0)
  })

  it('undo restores overwritten values, not just added ones', () => {
    const s = store()
    const id = s.activeLayer().id
    s.setColVelRange(id, 1, 2, 127)
    s.setColVelRange(id, 0, 4, 55)
    s.undo()
    expect(s.layer(id)!.colVel.get(1)).toBe(127)
    expect(s.layer(id)!.colVel.size).toBe(1)
  })

  it('clears the range when given undefined, and ignores an empty range', () => {
    const s = store()
    const id = s.activeLayer().id
    s.setColVelRange(id, 0, 3, 55)
    s.setColVelRange(id, 1, 2, undefined)
    expect(s.layer(id)!.colVel.get(1)).toBeUndefined()
    expect(s.layer(id)!.colVel.get(2)).toBe(55)
    const before = s.commitVersion
    s.setColVelRange(id, 2, 2, 10)
    expect(s.commitVersion).toBe(before)
  })
})
