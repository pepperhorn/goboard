import type { Pos } from './types'
import { cmp as posCmp } from './pos'
import type { GridRegion, GridSlot } from './grid'
import { regionIndexAt, slotAt as slotAtRegions } from './grid'

/**
 * A cursor that caches the current region index, for draw paths that walk positions in
 * order. Modelled on `createTempoCursor` (src/core/tempo.ts) — same problem, same shape.
 *
 * Forward motion steps the index; only a backward seek pays for a search. The draw path
 * calls `reset()` once per frame per layer.
 */
export type GridCursor = {
  slotAt(at: Pos): GridSlot
  reset(): void
}

export function createGridCursor(regions: readonly GridRegion[]): GridCursor {
  let index = -1
  let last: Pos | null = null

  return {
    slotAt(at: Pos): GridSlot {
      if (last !== null && posCmp(at, last) < 0) {
        index = regionIndexAt(regions, at) // backward seek
      } else {
        // Forward walk (including the first call, from the index=-1 sentinel).
        while (index + 1 < regions.length && posCmp(regions[index + 1]!.start, at) <= 0) index++
      }
      last = at
      // The region window is now known; delegate the exact slot math to one place,
      // passing the resolved index so it does not re-run the binary search.
      return slotAtRegions(regions, at, index)
    },

    reset(): void {
      index = -1
      last = null
    },
  }
}
