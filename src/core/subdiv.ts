import type { Slot, Subdiv, SubdivL2 } from './types'
import { frac } from './frac'

/**
 * v1 import only; the live model is `core/grid.ts`. This module survives solely so the
 * v1 `.go.json` reader (`io/project.ts`) and its migration (`io/gridMigrate.ts`) can
 * parse and enumerate the old per-column subdivision tree before converting it to
 * regions. Nothing in the live draw/edit path calls into this file.
 *
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
