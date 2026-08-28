import type { Frac, Pos } from './types'
import { cmp as fracCmp, div as fracDiv, frac, mul as fracMul } from './frac'
import { add as posAdd, cmp as posCmp, diff as posDiff, canonicalize } from './pos'

/**
 * A layer's rhythmic grid: a sorted list of change points, exactly the shape `tempoMap`
 * uses. See the design doc §3.2.
 *
 * `value` is the LINE SPACING in quarter notes, which is what lets the grid be coarser
 * than a column — the old `Subdiv` could only ever divide one. Phase anchors at
 * `start`, so two adjacent regions of equal value are not redundant: the second one
 * resets the phase.
 */

export type GridRegion = { readonly start: Pos; readonly value: Frac }

/** An absolute slot: where it starts and how long it lasts (possibly clipped). */
export type GridSlot = { readonly start: Pos; readonly dur: Frac }

/** No region covering a position means one line per quarter note. */
export const DEFAULT_GRID_VALUE: Frac = frac(1)

/** Index of the region governing `at`, or -1 when the implicit default governs. */
export function regionIndexAt(regions: readonly GridRegion[], at: Pos): number {
  let lo = 0
  let hi = regions.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (posCmp(regions[mid]!.start, at) <= 0) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

export function gridValueAt(regions: readonly GridRegion[], at: Pos): Frac {
  const i = regionIndexAt(regions, at)
  return i < 0 ? DEFAULT_GRID_VALUE : regions[i]!.value
}

/**
 * The slot containing `at`.
 *
 * `k = floor((at - start) / v)` in exact rationals, so the answer is the same at every
 * zoom and in negative columns. The duration is clipped by the next region's start,
 * which is what makes a boundary-adjacent slot short rather than overlapping.
 *
 * `knownIndex`, when given, is used in place of a fresh `regionIndexAt` search — for a
 * caller (`gridCursor.ts`) that already knows which region governs `at` and does not
 * want to pay for a binary search it has already done. Passing the wrong index for `at`
 * gives wrong answers; only pass a value obtained the same way `regionIndexAt` would
 * compute it.
 */
export function slotAt(regions: readonly GridRegion[], at: Pos, knownIndex?: number): GridSlot {
  const i = knownIndex ?? regionIndexAt(regions, at)
  const anchor = i < 0 ? canonicalize(0, frac(0)) : regions[i]!.start
  const value = i < 0 ? DEFAULT_GRID_VALUE : regions[i]!.value

  const offset = posDiff(anchor, at) // exact Frac (at - anchor), >= 0 when i >= 0
  const k = Math.floor((offset.n * value.d) / (offset.d * value.n))
  const start = posAdd(anchor, fracMul(value, frac(k)))

  const next = regions[i + 1]
  if (next === undefined) return { start, dur: value }
  const room = posDiff(start, next.start)
  return { start, dur: fracCmp(room, value) < 0 ? room : value }
}

/** A note is on-grid when its onset is exactly a slot start (§7's off-grid flag). */
export function isOnGrid(regions: readonly GridRegion[], at: Pos): boolean {
  return posCmp(slotAt(regions, at).start, at) === 0
}

/**
 * Every slot start in `[from, to]`, in order — what a gridline pass draws.
 *
 * Walks regions rather than positions so the cost is proportional to what is visible,
 * not to the board's (unbounded) extent.
 */
export function slotStartsIn(regions: readonly GridRegion[], from: Pos, to: Pos): Pos[] {
  const out: Pos[] = []
  let cursor = slotAt(regions, from).start
  if (posCmp(cursor, from) < 0) cursor = posAdd(cursor, slotAt(regions, cursor).dur)
  while (posCmp(cursor, to) <= 0) {
    out.push(cursor)
    const slot = slotAt(regions, cursor)
    cursor = posAdd(cursor, slot.dur)
  }
  return out
}

/**
 * Canonical form. Autosave diffs the serialized bytes (`io/project.ts`), so two equal
 * grids must serialize identically or every no-op edit writes a revision.
 *
 * A region is dropped only when it is a true no-op: same value as its predecessor AND a
 * start already on the predecessor's lattice. A same-valued region starting off that
 * lattice is a deliberate phase reset and must survive.
 */
export function canonicalizeGrid(regions: readonly GridRegion[]): GridRegion[] {
  const sorted = [...regions].sort((a, b) => posCmp(a.start, b.start))
  const out: GridRegion[] = []
  for (const region of sorted) {
    const prev = out[out.length - 1]
    const prevValue = prev?.value ?? DEFAULT_GRID_VALUE
    const prevAnchor = prev?.start ?? canonicalize(0, frac(0))
    if (fracCmp(region.value, prevValue) === 0) {
      const offset = posDiff(prevAnchor, region.start)
      const ratio = fracDiv(offset, prevValue)
      if (ratio.d === 1) continue // on the predecessor's lattice: a true no-op
    }
    if (prev && posCmp(prev.start, region.start) === 0) {
      out[out.length - 1] = region // later wins; import rejects duplicates separately
      continue
    }
    out.push(region)
  }
  return out
}

/**
 * Set `[from, to)` to `value`, restoring whatever governed at `to` afterwards.
 * `to === undefined` means "to the end of time". One call, one command (§7.3).
 */
export function setGridRange(
  regions: readonly GridRegion[],
  from: Pos,
  to: Pos | undefined,
  value: Frac,
): GridRegion[] {
  const restore = to === undefined ? undefined : gridValueAt(regions, to)
  const kept = regions.filter(
    (r) => posCmp(r.start, from) < 0 || (to !== undefined && posCmp(r.start, to) >= 0),
  )
  const next: GridRegion[] = [...kept, { start: from, value }]
  if (to !== undefined && restore !== undefined) next.push({ start: to, value: restore })
  return canonicalizeGrid(next)
}
