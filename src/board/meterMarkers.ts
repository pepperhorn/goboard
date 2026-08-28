import type { Pos } from '../core/types'
import type { Meter } from '../core/meter'
import { barLinesIn, midiDenominator } from '../core/meter'
import { frac, mul as fmul, toNumber } from '../core/frac'
import { ORIGIN, cmp as pcmp, pos, toQuarters } from '../core/pos'
import { quartersToX } from './viewport'
import type { Viewport } from './viewport'

/**
 * Meter markers on the ruler. See go-spec.md §7.2 and design §3.7.
 *
 * The ruler already owns click-seek, drag-loop, shift-clear and the right-click grid
 * editor. Markers cannot simply be "another thing on the ruler": they need their own
 * band, or every click near a time signature would also seek. So they take the top
 * `MARKER_BAND_HEIGHT` pixels and win there, and `markerAt` returns `null` everywhere
 * below — which is what keeps the rest of §7.2 exactly as it was.
 *
 * Drawing and hit-testing share `markerWidth` deliberately. If the chip were measured
 * with `ctx.measureText` and the hit box were a constant, the two would disagree by a
 * few pixels for every label of unusual length ("12/16"), and the disagreement would
 * only show up as markers that are hard to grab.
 */

/** The band at the top of the ruler that belongs to markers, in CSS pixels. */
export const MARKER_BAND_HEIGHT = 12

/** Approximate advance of one glyph of the chip's 9px label. */
const MARKER_CHAR_PX = 5.5

/** Horizontal padding either side of the label. */
const MARKER_PAD_PX = 6

/** No chip is narrower than this, so a "2/4" is still a comfortable target. */
export const MARKER_MIN_WIDTH = 20

/** `sum(groups)/midiDenominator(beatUnit)` — 7/8 felt as `[2, 2, 3]` reads "7/8". */
export function markerLabel(m: Meter): string {
  let beats = 0
  for (const g of m.groups) beats += g
  return `${beats}/${midiDenominator(m.beatUnit)}`
}

/** Chip width for a label. The single source of truth for both draw and hit test. */
export function markerWidth(label: string): number {
  return Math.max(MARKER_MIN_WIDTH, label.length * MARKER_CHAR_PX + MARKER_PAD_PX * 2)
}

/** Screen x of a marker's centre — the chip straddles its own meter change. */
export const markerCenterX = (vp: Viewport, m: Meter): number =>
  quartersToX(vp, toQuarters(m.pos))

/**
 * The index of the marker under `(x, y)`, or `null`.
 *
 * Scans from the end so the answer matches what is on screen: markers are drawn in
 * map order, so a later one overlaps an earlier one when the zoom packs them together.
 */
export function markerAt(
  vp: Viewport,
  meterMap: readonly Meter[],
  x: number,
  y: number,
): number | null {
  if (!(y >= 0) || y >= MARKER_BAND_HEIGHT) return null
  for (let i = meterMap.length - 1; i >= 0; i--) {
    const m = meterMap[i]!
    const half = markerWidth(markerLabel(m)) / 2
    if (Math.abs(x - markerCenterX(vp, m)) <= half) return i
  }
  return null
}

/** Longest bar in the map, in quarters. Used only to size a search window. */
function maxBarQuarters(map: readonly Meter[]): number {
  let max = 0
  for (const m of map) {
    let beats = 0
    for (const g of m.groups) beats += g
    max = Math.max(max, toNumber(fmul(frac(beats), m.beatUnit)))
  }
  return max > 0 ? max : 4
}

/**
 * Where a dragged marker lands: the nearest **bar line of the map with the dragged
 * meter taken out**.
 *
 * A meter change always starts a new bar at its own position (`meter.ts` module doc),
 * so a drop anywhere else silently truncates the bar it lands inside — drag a 7/8
 * marker one pixel and the preceding 4/4 bar becomes a 3.99/4 bar. Snapping to a bar
 * line of the *surrounding* meter is the only landing that leaves the bars on both
 * sides intact, and it makes the gesture idempotent: dropping a marker back where it
 * came from is a no-op rather than a one-pixel edit.
 *
 * Exactness (§3.1): every candidate comes out of `barLinesIn`, so the stored `Pos` is
 * the product of exact bar arithmetic. The pointer's float only *chooses among* those
 * candidates — it never constructs one, and no float decides a column index.
 *
 * Candidates at or before the origin are dropped: that slot belongs to the anchor
 * meter, which `BoardStore.moveMeter` refuses to displace.
 */
export function quantizeMeterDrop(map: readonly Meter[], q: number): Pos {
  const w = maxBarQuarters(map)
  // The window is clamped to the origin at both ends: bar lines before it are never
  // candidates, and a drag dragged left of the origin still needs the first bar line
  // *after* it in range, or there would be nothing to choose.
  const from = pos(Math.max(0, Math.floor(q - w) - 1))
  const to = pos(Math.ceil(Math.max(q, 0) + w) + 1)

  let best: Pos | null = null
  let bestDistance = Infinity
  for (const p of barLinesIn(map, from, to)) {
    if (pcmp(p, ORIGIN) <= 0) continue
    const d = Math.abs(toQuarters(p) - q)
    if (d < bestDistance) {
      bestDistance = d
      best = p
    }
  }
  /*
   * Unreachable: consecutive bar starts are at most `w` apart, and the window spans at
   * least `[max(0, q-w)-1, max(q,0)+w+1]`, so it always holds a bar start strictly
   * after the origin. Throwing rather than falling back to `pos(Math.round(q))` is
   * deliberate — that fallback would let a float decide a column index, which §3.1
   * forbids, and it would answer a question this function could not actually answer.
   */
  if (best === null) {
    throw new RangeError(`quantizeMeterDrop: no bar line near ${q} — the meter map is malformed`)
  }
  return best
}
