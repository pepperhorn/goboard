import type { Subdiv } from '../core/types'
import { eq as fracEq, frac } from '../core/frac'
import { canonicalize } from '../core/pos'
import { enumerateSlots } from '../core/subdiv'
import type { GridRegion } from '../core/grid'
import { DEFAULT_GRID_VALUE, canonicalizeGrid } from '../core/grid'

/**
 * `.go.json` v1 → v2: a per-column `Subdiv` tree becomes position-anchored regions.
 *
 * One region per UNIFORM RUN, not per column. A depth-2 tree is a finite sequence of
 * equal-duration runs, and each run becomes a region anchored at its own start — which
 * is exactly why regions subsume nesting. Emitting one region per column instead would
 * flatten nested columns and leave every note in a nested slot flagged off-grid.
 *
 * Lossless means what §3.2 means by subdivision equality: the enumerated slot starts are
 * identical before and after. Tree shape is not preserved and does not need to be.
 */
export function subdivsToRegions(subdivs: ReadonlyMap<number, Subdiv>): GridRegion[] {
  const cols = [...subdivs.keys()].sort((a, b) => a - b)
  const out: GridRegion[] = []

  for (const col of cols) {
    const slots = enumerateSlots(subdivs.get(col))
    let runValue = frac(0)
    for (const slot of slots) {
      if (!fracEq(slot.dur, runValue)) {
        out.push({ start: canonicalize(col, slot.start), value: slot.dur })
        runValue = slot.dur
      }
    }
    // Restore the quarter default after this column, unless the next column starts its
    // own region there anyway (the next iteration would emit one at exactly col + 1).
    if (!subdivs.has(col + 1)) {
      out.push({ start: canonicalize(col + 1, frac(0)), value: DEFAULT_GRID_VALUE })
    }
  }

  return canonicalizeGrid(out)
}
