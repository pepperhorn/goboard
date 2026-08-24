import type { Frac, Slot, Subdiv, SubdivL2 } from './types'
import { frac } from './frac'
import { floorDivMod } from './pos'

/**
 * Subdivision trees and slot enumeration. See go-spec.md §3.2.
 *
 * A column's grid is a depth-2 tree, per column per layer. Slot boundaries within one
 * column therefore have denominator `s1 * s2 <= 256`, and every slot here is built from
 * integers through `frac.ts` — no float ever reaches a `Frac`.
 *
 * The depth limit lives in the type (`SubdivL2` has no `children`), but imported JSON
 * can violate it, so `validateSubdiv` is the load/import guard §3.2 requires.
 */

/** A node splits into 1..16 slots. `1` = the whole column, one slot. */
export const MAX_SPLIT = 16

/** Slot boundaries are `s1 * s2`, so a column holds at most 16 * 16 slots. */
export const MAX_SLOTS = 256

/** No entry in the layer's map means `{ split: 1 }` — one slot = one quarter note. */
const DEFAULT_SPLIT = 1

/**
 * Ordered slots within one column, in quarter-note units relative to the column start.
 *
 * `undefined` (no map entry) is the default `{ split: 1 }`. A depth-1 slot with a
 * non-null child expands into that child's sub-slots; a `null` child is a leaf.
 * Assumes a validated tree — `validateSubdiv` runs at import, not per frame.
 */
export function enumerateSlots(sd: Subdiv | undefined): Slot[] {
  const split = sd?.split ?? DEFAULT_SPLIT
  const children = sd?.children
  const slots: Slot[] = []
  for (let i = 0; i < split; i++) {
    const child = children?.[i] ?? null
    if (child === null) {
      // Slot i of a split-s node spanning [0,1) is [i/s, (i+1)/s).
      slots.push({ start: frac(i, split), dur: frac(1, split) })
      continue
    }
    // Sub-slot j subdivides [i/s, (i+1)/s) into t equal parts, so it starts at
    // (i*t + j)/(s*t) — formed from integers, never from `i/s + j/(s*t)` in floats.
    const t = child.split
    for (let j = 0; j < t; j++) {
      slots.push({ start: frac(i * t + j, split * t), dur: frac(1, split * t) })
    }
  }
  return slots
}

/** Slot count without materializing the array. */
export function slotCount(sd: Subdiv | undefined): number {
  const split = sd?.split ?? DEFAULT_SPLIT
  const children = sd?.children
  if (children === undefined) return split
  let count = 0
  for (let i = 0; i < split; i++) count += children[i]?.split ?? 1
  return count
}

/**
 * The slot containing offset `f`, plus its index, or `undefined` when `f` is outside
 * `[0, 1)`. Spans are half-open, so a boundary belongs to the slot it starts.
 */
function locate(sd: Subdiv | undefined, f: Frac): { index: number; slot: Slot } | undefined {
  if (f.n < 0 || f.n >= f.d) return undefined // `f` is normalized, so `d > 0`
  const split = sd?.split ?? DEFAULT_SPLIT
  // floor(f*s) and the leftover, in one floored div-mod. `f.n < f.d <= LATTICE` and
  // `s <= 16`, so `f.n * s` stays well inside 2^53.
  const { q: i, r } = floorDivMod(f.n * split, f.d)
  const children = sd?.children
  // Slots before slot i: 1 per leaf, `split` per subdivided slot.
  let index = i
  if (children !== undefined) {
    index = 0
    for (let k = 0; k < i; k++) index += children[k]?.split ?? 1
  }
  const child = children?.[i] ?? null
  if (child === null) return { index, slot: { start: frac(i, split), dur: frac(1, split) } }
  // `r / f.d` is the offset into slot i scaled to [0,1), so floor(r*t/f.d) is the sub-slot.
  const t = child.split
  const { q: j } = floorDivMod(r * t, f.d)
  return {
    index: index + j,
    slot: { start: frac(i * t + j, split * t), dur: frac(1, split * t) },
  }
}

/**
 * Index of the slot containing offset `f` (`0 <= f < 1`), or -1 if out of range.
 * Used by hit-testing and the velocity lane.
 */
export function slotIndexAt(sd: Subdiv | undefined, f: Frac): number {
  return locate(sd, f)?.index ?? -1
}

/** The slot containing offset `f`, or `undefined` if `f` is outside `[0, 1)`. */
export function slotAt(sd: Subdiv | undefined, f: Frac): Slot | undefined {
  return locate(sd, f)?.slot
}

/** `split` must be an integer in 1..16 — at either level. */
function checkSplit(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_SPLIT) {
    throw new RangeError(`Subdiv: ${what} must be an integer in 1..${MAX_SPLIT}, got ${String(v)}`)
  }
  return v
}

/**
 * Validate an imported subdivision tree, returning a rebuilt node that carries only the
 * properties the type defines. This is the load/import guard of §3.2: `children.length
 * === split`, the depth limit and the 256-slot bound are all validated, never assumed.
 */
export function validateSubdiv(sd: unknown): Subdiv {
  if (typeof sd !== 'object' || sd === null) {
    throw new TypeError(`Subdiv: expected an object, got ${sd === null ? 'null' : typeof sd}`)
  }
  const node = sd as { split?: unknown; children?: unknown }
  const split = checkSplit(node.split, 'split')
  if (node.children === undefined) return { split }
  if (!Array.isArray(node.children)) {
    throw new TypeError(`Subdiv: children must be an array of length ${split}`)
  }
  const raw = node.children as readonly unknown[]
  if (raw.length !== split) {
    throw new RangeError(`Subdiv: children.length ${raw.length} !== split ${split}`)
  }
  // The aggregate bound goes first: it is the invariant §3.2 actually names, and an
  // import claiming wild splits should report the bound it blew, not just the first
  // child that happens to be out of range.
  let count = 0
  for (const c of raw) {
    // Anything malformed counts as one slot here; the shape checks below reject it.
    const s = typeof c === 'object' && c !== null ? (c as { split?: unknown }).split : 1
    count += typeof s === 'number' && Number.isInteger(s) && s > 0 ? s : 1
  }
  if (count > MAX_SLOTS) {
    throw new RangeError(`Subdiv: ${count} slots exceeds the ${MAX_SLOTS}-slot maximum`)
  }
  const children: (SubdivL2 | null)[] = []
  for (let i = 0; i < split; i++) {
    const c = raw[i]
    if (c === null) {
      children.push(null)
      continue
    }
    if (typeof c !== 'object') {
      throw new TypeError(`Subdiv: child ${i} must be a depth-2 node or null, got ${typeof c}`)
    }
    // A third level is unrepresentable in the type but reachable from JSON, and it blows
    // the 256-slot bound.
    if ('children' in c) {
      throw new RangeError(`Subdiv: child ${i} must not carry children — the depth limit is 2`)
    }
    children.push({ split: checkSplit((c as { split?: unknown }).split, `child ${i} split`) })
  }
  return { split, children }
}
