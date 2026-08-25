import type { Layer, Note, Project } from '../core/types'
import { frac } from '../core/frac'
import { canonicalize } from '../core/pos'
import { DEFAULT_METER } from '../core/meter'
import { LAYER_COLORS } from '../board/theme'

/**
 * The §5.3 benchmark fixture: "60 fps pan/zoom with 5k notes in the viewport, 50k in
 * the project".
 *
 * Both halves of that sentence are load-bearing and pull in opposite directions. The
 * 50k is what the *index* and the cull have to survive; the 5k is what the *draw* has
 * to survive. A fixture with 50k notes spread evenly would put ~500 in view and quietly
 * measure nothing, and one with 5k notes total would never exercise the cull. So this
 * builds a dense head — every note inside the opening screen — followed by a long
 * sparse tail.
 *
 * Generated rather than checked in: 50k notes is ~4 MB of JSON, and the shape has to
 * follow the viewport constants rather than a stale copy of them.
 */

export type BenchFixtureOptions = {
  /** Total notes in the project. §5.3's number is 50,000. */
  readonly total?: number
  /**
   * Notes per column in the dense head. §5.3 wants ~5,000 on screen and a 1280 px
   * board at the 24 px/quarter minimum shows ~53 columns, so ~95 per column.
   */
  readonly perCol?: number
  /**
   * How far the dense head runs. It has to outlast the pan sweep: a head only as wide
   * as the opening screen empties out as the bench pans into the tail, and the phase
   * would report the frame times of a half-empty board.
   */
  readonly denseCols?: number
  /** Lowest pitch used, and how many rows the notes spread over. */
  readonly pitchLo?: number
  readonly pitchSpan?: number
  /** Columns the sparse tail spreads over. */
  readonly tailCols?: number
}

/** The §9.4 starter set, minus the kit: kit layers would reject most of these rows. */
const BENCH_LAYERS = ['Piano', 'Guitar', 'Bass', 'Keys'] as const

/**
 * Slot denominators used across the head, so the fixture exercises the subdivision
 * lattice rather than landing every note on a beat. 1 keeps a run of plain quarters.
 */
const DENOMINATORS = [1, 2, 3, 4, 5, 7, 11, 13] as const

/** Coprime with the default `pitchSpan`, so the head covers every row. */
const PITCH_STRIDE = 13

function layers(): Layer[] {
  return BENCH_LAYERS.map((name, order) => ({
    id: `bench-${order}`,
    name,
    color: LAYER_COLORS[order % LAYER_COLORS.length]!,
    instrumentId: 'ph-piano-1',
    channel: order,
    audible: true,
    visible: true,
    defaultVel: 96,
    colVel: new Map<number, number>(),
    // A finer grid over one column on every layer, so the §5.2 gridline pass is
    // exercised and its two guards (pxPerQuarter < 48, slot width < 4 px) actually
    // get hit. The middle column is three regions, not one: 1/6, 1/3, 1/6, bracketing
    // a coarser middle third — the region-model equivalent of the old fixture's
    // non-uniform `{split:3, children:[{split:2}, null, {split:2}]}` column (mixed
    // 1/6- and 1/3-wide slots in one column). That shape forces the grid cursor to
    // cross a region boundary mid-column rather than only at column starts, which is
    // exactly the stepping path a `slotAt`-in-the-draw-loop regression would skip.
    grid: [
      { start: canonicalize(order * 3, frac(0)), value: frac(1, 4) },
      { start: canonicalize(order * 3 + 1, frac(0)), value: frac(1, 6) },
      { start: canonicalize(order * 3 + 1, frac(1, 3)), value: frac(1, 3) },
      { start: canonicalize(order * 3 + 1, frac(2, 3)), value: frac(1, 6) },
      { start: canonicalize(order * 3 + 2, frac(0)), value: frac(1) },
    ],
    order,
  }))
}

export function createBenchProject(options: BenchFixtureOptions = {}): Project {
  const {
    total = 50_000,
    perCol = 95,
    denseCols = 200,
    pitchLo = 12,
    pitchSpan = 84, // rows visible at the 8 px/semitone minimum on a 676 px board
    tailCols = 4_000,
  } = options

  if (total < 1) throw new RangeError('createBenchProject: total must be positive')
  if (perCol < 1 || denseCols < 1) throw new RangeError('createBenchProject: empty head')

  const project: Layer[] = layers()
  const notes: Note[] = []
  const dense = Math.min(total, perCol * denseCols)

  const push = (i: number, col: number): void => {
    const layer = project[i % project.length]!
    const d = DENOMINATORS[i % DENOMINATORS.length]!
    const n = i % d
    notes.push({
      id: `b${i}`,
      layerId: layer.id,
      // `canonicalize` because n/d is already < 1 by construction, but the fixture must
      // not be the one place in the app that hand-builds a Pos and gets it wrong.
      pos: canonicalize(col, frac(n, d)),
      dur: frac(1, d),
      // The stride is coprime with `pitchSpan` on purpose: a stride sharing a factor
      // (7 and 84, say) would visit only a twelfth of the rows and leave the board
      // striped with empty bands.
      pitch: pitchLo + ((i * PITCH_STRIDE) % pitchSpan),
      // Every fourth note carries an explicit velocity, so §6.1's resolution order is
      // exercised on the lane's draw path rather than short-circuiting on the default.
      ...(i % 4 === 0 ? { vel: 20 + (i % 100) } : {}),
    })
  }

  for (let i = 0; i < dense; i++) push(i, i % denseCols)
  for (let i = dense; i < total; i++) push(i, denseCols + (i % tailCols))

  return {
    version: 2,
    name: `Bench ${total}`,
    tempoMap: [{ pos: canonicalize(0, frac(0)), bpm: 120 }],
    layers: project,
    notes,
    activeLayerId: project[0]!.id,
    meterMap: [DEFAULT_METER],
  }
}

/**
 * How many notes actually fall inside a column/pitch window. The bench reports this
 * next to its frame times: a number measured against an unstated note count is not a
 * benchmark, and a fixture that silently stops filling the screen would otherwise look
 * like a performance win.
 */
export function countInWindow(
  project: Project,
  cols: { readonly from: number; readonly to: number },
  pitches: { readonly from: number; readonly to: number },
): number {
  let n = 0
  for (const note of project.notes) {
    if (note.pos.col < cols.from || note.pos.col > cols.to) continue
    if (note.pitch < pitches.from || note.pitch > pitches.to) continue
    n++
  }
  return n
}
