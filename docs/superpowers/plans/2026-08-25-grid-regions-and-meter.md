# Grid Regions and Meter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-column subdivision tree with position-anchored grid regions so any note value from a 32nd-triplet to a whole note is a real snap target, then add a meter map that drives bar lines and MIDI time signatures.

**Architecture:** A layer's grid becomes a sorted list of `{start: Pos, value: Frac}` regions — the same piecewise-constant shape `tempoMap` already uses — where `value` is the line spacing in quarter notes. Slots are half-open intervals phase-anchored at each region's start, clipped by the next region. Every consumer (hit testing, gridlines, stones, velocity lane, persistence) moves from column-keyed lookup to a monotone cursor over regions. Meter lands afterwards as a separate map with its own line levels and SMF meta events.

**Tech Stack:** TypeScript 5.9, Vitest (node environment, no DOM), React 19 for chrome only, canvas 2D for the board, `@tonejs/midi` for export, Playwright for smoke and bench.

**Spec:** `docs/superpowers/specs/2026-08-25-three-board-design.md` (this plan implements §3, §5's ruler changes, and steps 1–2 of §8)

## Global Constraints

- **Exact rationals only.** Every position and duration is built from integers through `src/core/frac.ts`. No float ever reaches a `Frac`. Denominators must divide the §3.1 lattice `519437318400`.
- **Grid value range:** `1/256 <= v <= 4` quarters, reduced, lattice-safe.
- **`beatUnit` restriction:** `4 / beatUnit` must be a power of two (SMF's denominator is a 2^k field).
- **Implicit default grid:** before the first region, and for an empty region list, the grid is one quarter (`frac(1)`). This governs negative columns too — the board is boundless leftward.
- **Phase anchors at `region.start`**, never at a global origin.
- **Canonical form** (autosave diffs serialized bytes, so this is load-bearing): sorted by start, no duplicate starts, and a region is dropped only when it has the same value as its predecessor *and* its start lies on the predecessor's lattice.
- **One command per gesture** (§7.3). Multi-region edits go through `board.batch`.
- **No `any`.** `tsc -b --noEmit` must stay clean; the repo runs `exactOptionalPropertyTypes`.
- **Run `npx vitest run` before every commit.** 469 tests pass today; that number only goes up.

---

## File Structure

**Created:**
- `src/core/gridValue.ts` — the value type, its bounds, the eleven presets, validation
- `src/core/grid.ts` — regions, canonical form, slot enumeration, range edits
- `src/core/gridCursor.ts` — monotone lookup for draw paths
- `src/io/gridMigrate.ts` — v1 `Subdiv` map → v2 region list
- `src/core/meter.ts` — meter map, bar/group line positions, bar numbering
- `src/board/meterMarkers.ts` — pure hit logic for ruler markers
- `src/ui/GridMenu.tsx` — replaces `SubdivMenu.tsx`

**Modified:**
- `src/core/types.ts` — `Layer.grid` replaces `Layer.subdivs`; `Project.meterMap`
- `src/core/subdiv.ts` — retained for the migration only, everything else deleted
- `src/board/hitTest.ts` — `pointToSlot` on regions, `noteRect` slot-width fix
- `src/board/stones.ts` — `isOffGrid` on regions
- `src/board/grid.ts` — gridlines and cell fills from regions and meter
- `src/board/lane.ts` — slot-keyed instead of column-keyed
- `src/board/ruler.ts` — bar numbers, meter markers
- `src/state/boardStore.ts` — `setGridRange`, `setColVelRange`, meter commands
- `src/io/project.ts` — format v2 with a v1 reader
- `src/io/midi.ts` — time signatures, meter denominators
- `src/ui/VelocityLane.tsx`, `src/ui/BoardView.tsx`, `src/board/interaction.ts` — call-site updates
- `go-spec.md` — §3.2, §3.4, §6.1, §7 amendments

---

## Phase A — the core (Tasks 1–5)

### Task 1: Grid value type, bounds, and presets

**Files:**
- Create: `src/core/gridValue.ts`
- Test: `src/core/gridValue.test.ts`

**Interfaces:**
- Consumes: `frac`, `normalize`, `cmp`, `LATTICE` from `src/core/frac.ts`
- Produces: `MIN_GRID_VALUE`, `MAX_GRID_VALUE`, `GRID_PRESETS: readonly GridPreset[]`, `validateGridValue(v: unknown, where: string): Frac`, `gridValueLabel(v: Frac): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/gridValue.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from './frac'
import { GRID_PRESETS, gridValueLabel, validateGridValue } from './gridValue'

describe('GRID_PRESETS', () => {
  it('carries the eleven named values from whole to 32nd-triplet', () => {
    expect(GRID_PRESETS.map((p) => p.id)).toEqual([
      'whole', 'half', 'half-triplet', 'quarter', 'quarter-triplet',
      '8th', '8th-triplet', '16th', '16th-triplet', '32nd', '32nd-triplet',
    ])
    expect(GRID_PRESETS.map((p) => p.value)).toEqual([
      frac(4), frac(2), frac(4, 3), frac(1), frac(2, 3),
      frac(1, 2), frac(1, 3), frac(1, 4), frac(1, 6), frac(1, 8), frac(1, 12),
    ])
  })
})

describe('validateGridValue', () => {
  it('accepts any lattice fraction in range, not just the presets', () => {
    // Quintuplets and 11-tuplets are why §3.1 is rational at all.
    expect(validateGridValue({ n: 1, d: 5 }, 'grid')).toEqual(frac(1, 5))
    expect(validateGridValue({ n: 1, d: 11 }, 'grid')).toEqual(frac(1, 11))
    expect(validateGridValue({ n: 2, d: 7 }, 'grid')).toEqual(frac(2, 7))
  })

  it('reduces on the way in', () => {
    expect(validateGridValue({ n: 2, d: 8 }, 'grid')).toEqual(frac(1, 4))
  })

  it('rejects values outside 1/256..4 quarters', () => {
    expect(() => validateGridValue({ n: 5, d: 1 }, 'grid')).toThrow(RangeError)
    expect(() => validateGridValue({ n: 1, d: 512 }, 'grid')).toThrow(RangeError)
    expect(() => validateGridValue({ n: 0, d: 1 }, 'grid')).toThrow(RangeError)
    expect(() => validateGridValue({ n: -1, d: 4 }, 'grid')).toThrow(RangeError)
  })

  it('rejects denominators off the §3.1 lattice', () => {
    expect(() => validateGridValue({ n: 1, d: 17 }, 'grid')).toThrow(RangeError)
  })

  it('names the path it rejected', () => {
    expect(() => validateGridValue('x', 'layers[2].grid[0].value')).toThrow(
      /layers\[2\]\.grid\[0\]\.value/,
    )
  })
})

describe('gridValueLabel', () => {
  it('uses the preset name when there is one', () => {
    expect(gridValueLabel(frac(1, 4))).toBe('16th')
    expect(gridValueLabel(frac(4))).toBe('whole')
  })

  it('falls back to the fraction for a custom tuplet', () => {
    expect(gridValueLabel(frac(1, 7))).toBe('1/7')
    expect(gridValueLabel(frac(2, 7))).toBe('2/7')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/gridValue.test.ts`
Expected: FAIL — `Cannot find module './gridValue'`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/gridValue.ts
import type { Frac } from './types'
import { LATTICE, cmp, frac, normalize, toString as fracToString } from './frac'

/**
 * Grid line spacing, in quarter notes. See the design doc §3.1.
 *
 * The type is deliberately NOT a closed ladder. A ladder built from 2s and 3s cannot
 * express quintuplets, septuplets or the 9/11/13-tuplets that go-spec.md §3.1 exists
 * for, and the old `Subdiv` model reached all of them. The eleven presets below are a
 * menu; the type is any lattice fraction in range.
 */

/** The finest grid: 256 lines per quarter, matching the old MAX_SLOTS bound. */
export const MIN_GRID_VALUE: Frac = frac(1, 256)

/** The coarsest grid: a whole note. */
export const MAX_GRID_VALUE: Frac = frac(4)

export type GridPreset = { readonly id: string; readonly label: string; readonly value: Frac }

export const GRID_PRESETS: readonly GridPreset[] = [
  { id: 'whole', label: 'whole', value: frac(4) },
  { id: 'half', label: 'half', value: frac(2) },
  { id: 'half-triplet', label: 'half triplet', value: frac(4, 3) },
  { id: 'quarter', label: 'quarter', value: frac(1) },
  { id: 'quarter-triplet', label: 'quarter triplet', value: frac(2, 3) },
  { id: '8th', label: '8th', value: frac(1, 2) },
  { id: '8th-triplet', label: '8th triplet', value: frac(1, 3) },
  { id: '16th', label: '16th', value: frac(1, 4) },
  { id: '16th-triplet', label: '16th triplet', value: frac(1, 6) },
  { id: '32nd', label: '32nd', value: frac(1, 8) },
  { id: '32nd-triplet', label: '32nd triplet', value: frac(1, 12) },
]

/**
 * Validate arbitrary parsed JSON into a grid value, or throw a `RangeError` naming the
 * path that failed — the same import discipline `project.ts` uses everywhere else.
 */
export function validateGridValue(v: unknown, where: string): Frac {
  if (typeof v !== 'object' || v === null) {
    throw new RangeError(`${where}: expected a fraction, got ${typeof v}`)
  }
  const raw = v as { n?: unknown; d?: unknown }
  if (typeof raw.n !== 'number' || typeof raw.d !== 'number') {
    throw new RangeError(`${where}: n and d must be numbers`)
  }
  if (!Number.isInteger(raw.n) || !Number.isInteger(raw.d) || raw.d === 0) {
    throw new RangeError(`${where}: n and d must be integers with d != 0`)
  }
  const value = normalize(raw.n, raw.d)
  if (cmp(value, MIN_GRID_VALUE) < 0 || cmp(value, MAX_GRID_VALUE) > 0) {
    throw new RangeError(
      `${where}: grid value must be between 1/256 and 4 quarters, got ${fracToString(value)}`,
    )
  }
  if (LATTICE % value.d !== 0) {
    throw new RangeError(`${where}: denominator ${value.d} is not on the §3.1 lattice`)
  }
  return value
}

/** Preset name if the value is one, else the bare fraction — for menus and tooltips. */
export function gridValueLabel(value: Frac): string {
  const preset = GRID_PRESETS.find((p) => p.value.n === value.n && p.value.d === value.d)
  return preset ? preset.label : fracToString(value)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/gridValue.test.ts`
Expected: PASS (all cases). If `fracToString(frac(1,7))` does not render `1/7`, read `src/core/frac.ts:130` and match its format in the test rather than changing `frac.ts`.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/core/gridValue.ts src/core/gridValue.test.ts
git commit -m "core: grid value type, bounds and the eleven presets"
```

---

### Task 2: Regions, canonical form, and slot enumeration

**Files:**
- Create: `src/core/grid.ts`
- Test: `src/core/grid.test.ts`

**Interfaces:**
- Consumes: `validateGridValue` (Task 1); `Pos`, `Frac` from `src/core/types.ts`; `pos`, `add`, `sub`, `diff`, `cmp`, `canonicalize` from `src/core/pos.ts`; `frac.div`, `frac.mul`, `frac.cmp` from `src/core/frac.ts`
- Produces: `GridRegion`, `GridSlot`, `DEFAULT_GRID_VALUE`, `regionIndexAt(regions, at): number`, `gridValueAt(regions, at): Frac`, `slotAt(regions, at): GridSlot`, `slotStartsIn(regions, from, to): Pos[]`, `isOnGrid(regions, at): boolean`, `canonicalizeGrid(regions): GridRegion[]`, `setGridRange(regions, from, to, value): GridRegion[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/grid.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from './frac'
import { pos } from './pos'
import type { GridRegion } from './grid'
import {
  canonicalizeGrid, gridValueAt, isOnGrid, setGridRange, slotAt, slotStartsIn,
} from './grid'

const R = (col: number, n: number, d: number, vn: number, vd: number): GridRegion => ({
  start: pos(col, n, d),
  value: frac(vn, vd),
})

describe('the implicit default', () => {
  it('is one quarter before the first region and for an empty list', () => {
    expect(gridValueAt([], pos(0))).toEqual(frac(1))
    expect(gridValueAt([R(4, 0, 1, 1, 3)], pos(0))).toEqual(frac(1))
    // The board is boundless leftward.
    expect(gridValueAt([R(0, 0, 1, 1, 3)], pos(-5))).toEqual(frac(1))
  })
})

describe('slotAt', () => {
  it('phase-anchors on the region start, not the origin', () => {
    const regions = [R(5, 1, 4, 2, 3)] // 2/3-quarter grid starting at 5 + 1/4
    expect(slotAt(regions, pos(5, 1, 4))).toEqual({ start: pos(5, 1, 4), dur: frac(2, 3) })
    // 5+1/4 + 2/3 = 5 + 11/12
    expect(slotAt(regions, pos(5, 11, 12))).toEqual({ start: pos(5, 11, 12), dur: frac(2, 3) })
  })

  it('returns the containing slot for a point inside it', () => {
    const regions = [R(0, 0, 1, 1, 3)]
    expect(slotAt(regions, pos(0, 1, 4))).toEqual({ start: pos(0), dur: frac(1, 3) })
  })

  it('clips the last slot at a region boundary', () => {
    // 2/3 grid from col 0, next region at col 1: slots [0,2/3) then [2/3,1) — clipped.
    const regions = [R(0, 0, 1, 2, 3), R(1, 0, 1, 1, 4)]
    expect(slotAt(regions, pos(0, 2, 3))).toEqual({ start: pos(0, 2, 3), dur: frac(1, 3) })
    expect(slotAt(regions, pos(1))).toEqual({ start: pos(1), dur: frac(1, 4) })
  })

  it('handles values coarser than a column', () => {
    const regions = [R(0, 0, 1, 4, 1)] // whole notes
    expect(slotAt(regions, pos(2))).toEqual({ start: pos(0), dur: frac(4) })
    expect(slotAt(regions, pos(4))).toEqual({ start: pos(4), dur: frac(4) })
  })

  it('works in negative columns', () => {
    const regions = [R(-8, 0, 1, 2, 1)]
    expect(slotAt(regions, pos(-5))).toEqual({ start: pos(-6), dur: frac(2) })
  })
})

describe('isOnGrid', () => {
  it('is true exactly on slot starts', () => {
    const regions = [R(0, 0, 1, 1, 3)]
    expect(isOnGrid(regions, pos(0, 1, 3))).toBe(true)
    expect(isOnGrid(regions, pos(0, 1, 4))).toBe(false)
  })
})

describe('slotStartsIn', () => {
  it('lists the intersections a draw pass needs, in order', () => {
    const regions = [R(0, 0, 1, 1, 2), R(1, 0, 1, 1, 3)]
    expect(slotStartsIn(regions, pos(0), pos(2))).toEqual([
      pos(0), pos(0, 1, 2),
      pos(1), pos(1, 1, 3), pos(1, 2, 3),
      pos(2),
    ])
  })
})

describe('canonicalizeGrid', () => {
  it('sorts by start and rejects nothing legal', () => {
    const out = canonicalizeGrid([R(4, 0, 1, 1, 4), R(0, 0, 1, 1, 3)])
    expect(out.map((r) => r.start.col)).toEqual([0, 4])
  })

  it('drops a same-valued region that lands on its predecessor lattice', () => {
    // 1/2 grid from 0; another 1/2 at col 1 changes nothing — col 1 is on the lattice.
    expect(canonicalizeGrid([R(0, 0, 1, 1, 2), R(1, 0, 1, 1, 2)])).toHaveLength(1)
  })

  it('keeps a same-valued region that resets the phase', () => {
    // 1/2 grid from 0; another 1/2 starting at 1/4 is a deliberate phase shift.
    const out = canonicalizeGrid([R(0, 0, 1, 1, 2), R(0, 1, 4, 1, 2)])
    expect(out).toHaveLength(2)
    expect(slotAt(out, pos(0, 1, 4))).toEqual({ start: pos(0, 1, 4), dur: frac(1, 2) })
  })

  it('drops a leading region equal to the implicit quarter default', () => {
    expect(canonicalizeGrid([R(0, 0, 1, 1, 1)])).toEqual([])
  })
})

describe('setGridRange', () => {
  it('sets a range and restores the previous value after it', () => {
    const out = setGridRange([], pos(4), pos(8), frac(1, 3))
    expect(gridValueAt(out, pos(4))).toEqual(frac(1, 3))
    expect(gridValueAt(out, pos(8))).toEqual(frac(1)) // back to the default
  })

  it('swallows regions the range covers', () => {
    const before = [R(2, 0, 1, 1, 6), R(5, 0, 1, 1, 8)]
    const out = setGridRange(before, pos(0), pos(8), frac(1, 4))
    expect(out.filter((r) => r.start.col > 0 && r.start.col < 8)).toEqual([])
    expect(gridValueAt(out, pos(3))).toEqual(frac(1, 4))
  })

  it('extends to infinity when `to` is undefined', () => {
    const out = setGridRange([], pos(4), undefined, frac(1, 2))
    expect(gridValueAt(out, pos(400))).toEqual(frac(1, 2))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/grid.test.ts`
Expected: FAIL — `Cannot find module './grid'`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/grid.ts
import type { Frac, Pos } from './types'
import { add as fracAdd, cmp as fracCmp, div as fracDiv, frac, mul as fracMul, sub as fracSub } from './frac'
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
 */
export function slotAt(regions: readonly GridRegion[], at: Pos): GridSlot {
  const i = regionIndexAt(regions, at)
  const anchor = i < 0 ? canonicalize(0, frac(0)) : regions[i]!.start
  const value = i < 0 ? DEFAULT_GRID_VALUE : regions[i]!.value

  const offset = posDiff(at, anchor) // exact Frac, >= 0 when i >= 0
  const k = Math.floor((offset.n * value.d) / (offset.d * value.n))
  const start = posAdd(anchor, fracMul(value, frac(k)))

  const next = regions[i + 1]
  if (next === undefined) return { start, dur: value }
  const room = posDiff(next.start, start)
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
      const offset = posDiff(region.start, prevAnchor)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/grid.test.ts`
Expected: PASS. The likely first failure is `slotAt` in negative columns — `posDiff` returns a signed `Frac` and `Math.floor` on the ratio must round toward negative infinity, which is what the integer expression above does. Do not "fix" it with `Math.trunc`.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -b --noEmit && npx vitest run
git add src/core/grid.ts src/core/grid.test.ts
git commit -m "core: grid regions, phase-anchored slots and canonical form"
```

---

### Task 3: The monotone grid cursor

**Files:**
- Create: `src/core/gridCursor.ts`
- Test: `src/core/gridCursor.test.ts`

**Interfaces:**
- Consumes: `GridRegion`, `GridSlot`, `slotAt`, `regionIndexAt` (Task 2)
- Produces: `GridCursor` with `slotAt(at: Pos): GridSlot` and `reset(): void`; `createGridCursor(regions: readonly GridRegion[]): GridCursor`

This is a §5.3-grade requirement, not an optimization: the draw path resolves the grid per note per frame, and a binary search per note means rational compares with a gcd per probe at 5,000 notes × 60 fps. `src/core/tempo.ts:253` (`createTempoCursor`) solves the identical problem — read it before writing this.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/gridCursor.test.ts
import { describe, expect, it, vi } from 'vitest'
import { frac } from './frac'
import { pos } from './pos'
import * as grid from './grid'
import { createGridCursor } from './gridCursor'

const regions = [
  { start: pos(0), value: frac(1, 2) },
  { start: pos(4), value: frac(1, 3) },
  { start: pos(8), value: frac(1, 4) },
]

describe('createGridCursor', () => {
  it('agrees with slotAt everywhere, in order', () => {
    const cursor = createGridCursor(regions)
    for (let q = 0; q < 12; q += 0.25) {
      const p = pos(Math.floor(q), Math.round((q % 1) * 4), 4)
      expect(cursor.slotAt(p)).toEqual(grid.slotAt(regions, p))
    }
  })

  it('agrees with slotAt on a backward seek', () => {
    const cursor = createGridCursor(regions)
    cursor.slotAt(pos(10))
    expect(cursor.slotAt(pos(1))).toEqual(grid.slotAt(regions, pos(1)))
  })

  it('does not binary-search while walking forward', () => {
    const spy = vi.spyOn(grid, 'regionIndexAt')
    const cursor = createGridCursor(regions)
    for (let col = 0; col < 12; col++) cursor.slotAt(pos(col))
    // One search to place the cursor at most; the rest step forward.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
  })

  it('reset returns it to the start for the next frame', () => {
    const cursor = createGridCursor(regions)
    cursor.slotAt(pos(10))
    cursor.reset()
    expect(cursor.slotAt(pos(0))).toEqual(grid.slotAt(regions, pos(0)))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/gridCursor.test.ts`
Expected: FAIL — `Cannot find module './gridCursor'`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/gridCursor.ts
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
        while (index + 1 < regions.length && posCmp(regions[index + 1]!.start, at) <= 0) index++
      }
      last = at
      // The region window is now known; delegate the exact slot math to one place.
      return slotAtRegions(regions, at)
    },

    reset(): void {
      index = -1
      last = null
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/gridCursor.test.ts`
Expected: PASS

Note for the implementer: the delegation to `slotAtRegions` keeps one copy of the slot math but re-does the binary search inside it, which defeats the purpose. Make `slotAt` in `grid.ts` take an optional pre-resolved index — `slotAt(regions, at, knownIndex?)` — and pass `index` here. Update `grid.ts` and its tests accordingly; the public behaviour is unchanged.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npx tsc -b --noEmit && npx vitest run
git add src/core/gridCursor.ts src/core/gridCursor.test.ts src/core/grid.ts src/core/grid.test.ts
git commit -m "core: monotone grid cursor for the draw path"
```

---

### Task 4: v1 subdivision → v2 region migration

**Files:**
- Create: `src/io/gridMigrate.ts`
- Test: `src/io/gridMigrate.test.ts`

**Interfaces:**
- Consumes: `Subdiv` from `src/core/types.ts`, `enumerateSlots` from `src/core/subdiv.ts`, `GridRegion`, `canonicalizeGrid`, `slotStartsIn` (Task 2)
- Produces: `subdivsToRegions(subdivs: ReadonlyMap<number, Subdiv>): GridRegion[]`

The rule is one region **per uniform run**, not per column. A column of `{split:4, children:[null,null,{split:3},null]}` holds runs of 1/4, 1/4, then three of 1/12, then 1/4 — three regions, not one. Emitting one region per column would flatten nested columns and make every note in a nested slot off-grid.

- [ ] **Step 1: Write the failing test**

```ts
// src/io/gridMigrate.test.ts
import { describe, expect, it } from 'vitest'
import type { Subdiv } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { enumerateSlots } from '../core/subdiv'
import { slotStartsIn } from '../core/grid'
import { subdivsToRegions } from './gridMigrate'

/** The slot starts a v1 column produces, as absolute positions. */
const v1Starts = (col: number, sd: Subdiv | undefined): string[] =>
  enumerateSlots(sd).map((s) => `${col + s.start.n / s.start.d}`)

const v2Starts = (regions: ReturnType<typeof subdivsToRegions>, col: number): string[] =>
  slotStartsIn(regions, pos(col), pos(col + 1))
    .filter((p) => p.col === col)
    .map((p) => `${p.col + p.frac.n / p.frac.d}`)

describe('subdivsToRegions', () => {
  it('maps a flat split to one region plus a restore', () => {
    const regions = subdivsToRegions(new Map([[2, { split: 3 }]]))
    expect(regions).toEqual([
      { start: pos(2), value: frac(1, 3) },
      { start: pos(3), value: frac(1) },
    ])
  })

  it('emits one region per uniform run for a nested column', () => {
    const sd: Subdiv = { split: 4, children: [null, null, { split: 3 }, null] }
    const regions = subdivsToRegions(new Map([[0, sd]]))
    expect(regions).toEqual([
      { start: pos(0), value: frac(1, 4) },
      { start: pos(0, 2, 4), value: frac(1, 12) },
      { start: pos(0, 3, 4), value: frac(1, 4) },
      { start: pos(1), value: frac(1) },
    ])
  })

  it('preserves enumerated slots exactly — the definition of lossless', () => {
    const cases: Subdiv[] = [
      { split: 1 },
      { split: 5 },
      { split: 11 },
      { split: 4, children: [{ split: 3 }, null, { split: 2 }, null] },
      { split: 13, children: Array.from({ length: 13 }, (_, i) => (i === 6 ? { split: 11 } : null)) },
    ]
    for (const sd of cases) {
      const regions = subdivsToRegions(new Map([[7, sd]]))
      expect(v2Starts(regions, 7), JSON.stringify(sd)).toEqual(v1Starts(7, sd))
    }
  })

  it('drops the restore when the next column carries its own entry', () => {
    const regions = subdivsToRegions(new Map([[0, { split: 2 }], [1, { split: 3 }]]))
    expect(regions).toEqual([
      { start: pos(0), value: frac(1, 2) },
      { start: pos(1), value: frac(1, 3) },
      { start: pos(2), value: frac(1) },
    ])
  })

  it('canonicalizes no-op entries away', () => {
    expect(subdivsToRegions(new Map([[3, { split: 1 }]]))).toEqual([])
    expect(subdivsToRegions(new Map([[3, { split: 2, children: [null, null] }]]))).toEqual([
      { start: pos(3), value: frac(1, 2) },
      { start: pos(4), value: frac(1) },
    ])
  })

  it('handles an empty map and negative columns', () => {
    expect(subdivsToRegions(new Map())).toEqual([])
    expect(subdivsToRegions(new Map([[-2, { split: 4 }]]))).toEqual([
      { start: pos(-2), value: frac(1, 4) },
      { start: pos(-1), value: frac(1) },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/io/gridMigrate.test.ts`
Expected: FAIL — `Cannot find module './gridMigrate'`

- [ ] **Step 3: Write the implementation**

```ts
// src/io/gridMigrate.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/io/gridMigrate.test.ts`
Expected: PASS. The "preserves enumerated slots" case is the one that matters — if a nested case fails, the run detection is wrong, not the region model.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npx tsc -b --noEmit && npx vitest run
git add src/io/gridMigrate.ts src/io/gridMigrate.test.ts
git commit -m "io: v1 subdivision to v2 grid region migration"
```

---

### Task 5: Model and persistence move to regions

**Files:**
- Modify: `src/core/types.ts` (replace `Layer.subdivs` with `Layer.grid`)
- Modify: `src/io/project.ts` (format v2, v1 reader, deterministic bytes)
- Modify: `src/state/boardStore.ts` (`gridFor`, `slotAt`, `setGridRange`; delete `setSubdiv`, `subdivFor`)
- Test: `src/io/project.test.ts` (extend), `src/state/boardStore.test.ts` if present, else extend `src/io/project.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: `Layer.grid: readonly GridRegion[]`; `Project.version: 2`; `BoardStore.gridFor(layerId): readonly GridRegion[]`, `BoardStore.slotAt(layerId, at): GridSlot`, `BoardStore.setGridRange(layerId, from, to, value): void`

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/io/project.test.ts
import { frac } from '../core/frac'
import { pos } from '../core/pos'

describe('format v2 — grid regions (design doc §3.8)', () => {
  it('round-trips a layer grid', () => {
    const p = createEmptyProject()
    const withGrid: Project = {
      ...p,
      layers: p.layers.map((l, i) =>
        i === 0 ? { ...l, grid: [{ start: pos(4), value: frac(1, 3) }] } : l,
      ),
    }
    const back = projectFromString(projectToBlobString(withGrid))
    expect(back.layers[0]!.grid).toEqual([{ start: pos(4), value: frac(1, 3) }])
  })

  it('serializes identically for equal projects, so autosave does not churn', () => {
    const a = createEmptyProject()
    const b = createEmptyProject()
    const grid = [{ start: pos(2), value: frac(1, 6) }, { start: pos(3), value: frac(1) }]
    const withA: Project = { ...a, layers: a.layers.map((l) => ({ ...l, grid })) }
    const withB: Project = { ...b, layers: b.layers.map((l) => ({ ...l, grid: [...grid] })) }
    expect(projectToBlobString(withA)).toBe(projectToBlobString(withB))
  })

  it('reads a v1 file and migrates its subdivisions', () => {
    const v1 = {
      version: 1,
      name: 'Old',
      tempoMap: [{ pos: { col: 0, frac: { n: 0, d: 1 } }, bpm: 120 }],
      layers: [{
        id: 'l1', name: 'Piano', color: '#c33', instrumentId: 'ph-piano-1', channel: 0,
        audible: true, visible: true, defaultVel: 96, order: 0,
        colVel: [], subdivs: [[2, { split: 3 }]],
      }],
      notes: [],
      activeLayerId: 'l1',
    }
    const migrated = projectFromString(JSON.stringify(v1))
    expect(migrated.version).toBe(2)
    expect(migrated.layers[0]!.grid).toEqual([
      { start: pos(2), value: frac(1, 3) },
      { start: pos(3), value: frac(1) },
    ])
  })

  it('rejects a grid value off the lattice, naming the path', () => {
    const bad = JSON.parse(projectToBlobString(createEmptyProject())) as Record<string, unknown>
    ;(bad.layers as Record<string, unknown>[])[0]!.grid = [
      { start: { col: 0, frac: { n: 0, d: 1 } }, value: { n: 1, d: 17 } },
    ]
    expect(() => projectFromString(JSON.stringify(bad))).toThrow(/layers\[0\]\.grid\[0\]\.value/)
  })

  it('rejects duplicate region starts', () => {
    const bad = JSON.parse(projectToBlobString(createEmptyProject())) as Record<string, unknown>
    ;(bad.layers as Record<string, unknown>[])[0]!.grid = [
      { start: { col: 1, frac: { n: 0, d: 1 } }, value: { n: 1, d: 2 } },
      { start: { col: 1, frac: { n: 0, d: 1 } }, value: { n: 1, d: 4 } },
    ]
    expect(() => projectFromString(JSON.stringify(bad))).toThrow(/duplicate/i)
  })
})

describe('BoardStore.setGridRange', () => {
  it('is one command, and undo restores the previous grid', () => {
    const store = new BoardStore(createEmptyProject(), { width: 800, height: 600 })
    const id = store.activeLayer().id
    store.setGridRange(id, pos(0), pos(4), frac(1, 3))
    expect(store.gridFor(id)).toHaveLength(2)
    store.undo()
    expect(store.gridFor(id)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/io/project.test.ts`
Expected: FAIL — `grid` is not a property of `Layer`

- [ ] **Step 3: Write the implementation**

In `src/core/types.ts`, replace the `subdivs` field:

```ts
  /** Rhythmic grid: sorted regions, empty means one line per quarter. See design §3.2. */
  readonly grid: readonly GridRegion[]
```

In `src/io/project.ts`: bump `const VERSION = 2`; write regions as `[{start: writePos(r.start), value: writeFrac(r.value)}]` in list order (already canonical, so no sorting at write time — assert it instead); read them with `validateGridValue` and a duplicate-start check; and when `o.version === 1`, read `subdivs` with the existing `readSubdiv` path and pass the resulting map through `subdivsToRegions`. Keep `writeMap`/`readMap` for `colVel`, which is unchanged.

In `src/state/boardStore.ts`, replace `subdivFor`/`setSubdiv`:

```ts
  gridFor(layerId: LayerId): readonly GridRegion[] {
    return this.layer(layerId)?.grid ?? []
  }

  slotAt(layerId: LayerId, at: Pos): GridSlot {
    return slotAt(this.gridFor(layerId), at)
  }

  /** §7.3: one command, however many regions the edit touches. */
  setGridRange(layerId: LayerId, from: Pos, to: Pos | undefined, value: Frac): void {
    const l = this.layer(layerId)
    if (!l) return
    const prev = l.grid
    const next = setGridRange(prev, from, to, value)
    const swap = (grid: readonly GridRegion[]) => {
      this.project = {
        ...this.project,
        layers: this.project.layers.map((x) => (x.id === layerId ? { ...x, grid } : x)),
      }
      this.touch()
    }
    this.run({ label: 'Set grid', do: () => swap(next), undo: () => swap(prev) })
  }
```

Update `createEmptyProject` to emit `grid: []`.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: the four consumer files (`hitTest`, `lane`, `grid`, `stones`) now fail to compile. That is expected and is Tasks 6–9. Run `npx vitest run src/io src/core src/state` and expect PASS for those.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/io/project.ts src/io/project.test.ts src/state/boardStore.ts
git commit -m "model: layers hold grid regions; .go.json v2 with a v1 migration"
```

---

## Phase B — consumers (Tasks 6–9)

### Task 6: Hit testing on regions

**Files:**
- Modify: `src/board/hitTest.ts` (`pointToSlot` signature, `noteRect` slot-width assumption)
- Test: `src/board/hitTest.test.ts`

**Interfaces:**
- Consumes: `GridCursor` (Task 3)
- Produces: `pointToSlot(vp: Viewport, cursor: GridCursor, x: number, y: number): SlotHit | null` — now snapping to the **nearest** intersection, per the design's "stones sit on intersections"

- [ ] **Step 1: Write the failing test**

```ts
// add to src/board/hitTest.test.ts
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { createGridCursor } from '../core/gridCursor'

describe('pointToSlot on grid regions', () => {
  const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }

  it('snaps to the nearest intersection, not the containing cell', () => {
    const cursor = createGridCursor([])          // quarter grid
    // 0.6 of a quarter in: nearer to the NEXT intersection.
    expect(pointToSlot(vp, cursor, 0.6 * 96, 100)?.pos).toEqual(pos(1))
    expect(pointToSlot(vp, cursor, 0.4 * 96, 100)?.pos).toEqual(pos(0))
  })

  it('snaps on a coarse grid', () => {
    const cursor = createGridCursor([{ start: pos(0), value: frac(2) }])
    expect(pointToSlot(vp, cursor, 1.2 * 96, 100)?.pos).toEqual(pos(2))
    expect(pointToSlot(vp, cursor, 0.7 * 96, 100)?.pos).toEqual(pos(0))
  })

  it('reports the slot duration of the intersection it chose, clipped', () => {
    const cursor = createGridCursor([{ start: pos(0), value: frac(2, 3) }, { start: pos(1), value: frac(1, 4) }])
    const hit = pointToSlot(vp, cursor, (2 / 3) * 96 + 2, 100)
    expect(hit?.pos).toEqual(pos(0, 2, 3))
    expect(hit?.dur).toEqual(frac(1, 3)) // clipped by the region boundary at col 1
  })
})

describe('noteRect with slots wider than a column', () => {
  const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }

  it('does not clamp the stone to one quarter on a whole-note grid', () => {
    const note = { id: 'n', layerId: 'l', pos: pos(0), dur: frac(4), pitch: 60 }
    const rect = noteRect(vp, note, 4 * 96)
    expect(rect.width).toBeGreaterThan(3 * 96)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/board/hitTest.test.ts`
Expected: FAIL — `pointToSlot` still takes a `SubdivFor`

- [ ] **Step 3: Write the implementation**

Replace `pointToSlot`'s body: convert `x` to quarters, build a `Pos` from the exact rational at that x (`quartersToPos` in `src/core/tempo.ts:216` already does the float→`Pos` conversion with a bounded denominator), ask the cursor for the containing slot, then compare the distance to `slot.start` against the distance to `slot.start + slot.dur` and return the nearer, with the duration of whichever slot starts there. Delete the `SubdivFor` type and its import. In `noteRect`, drop the `vp.pxPerQuarter` fallback in favour of the caller-provided slot width, and remove the comment asserting a slot is never wider than a column.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/board/hitTest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add src/board/hitTest.ts src/board/hitTest.test.ts
git commit -m "board: hit testing snaps to grid intersections"
```

---

### Task 7: Gridlines and off-grid flagging

**Files:**
- Modify: `src/board/grid.ts` (`drawGridlines` from regions), `src/board/stones.ts` (`isOffGrid`)
- Test: `src/board/grid.test.ts` (create), `src/board/stones.test.ts` (create if absent)

**Interfaces:**
- Consumes: `slotStartsIn`, `isOnGrid` (Task 2), `GridCursor` (Task 3)
- Produces: `drawGridlines(ctx, vp, size, regions, dpr)`; `isOffGrid(regions: readonly GridRegion[], note: Note): boolean`; `gridlineXs(vp, size, regions): number[]` exported for test

- [ ] **Step 1: Write the failing test**

```ts
// src/board/grid.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { gridlineXs } from './grid'

const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }
const size = { width: 384, height: 300 }

describe('gridlineXs', () => {
  it('draws one line per intersection of the active grid', () => {
    expect(gridlineXs(vp, size, [{ start: pos(0), value: frac(1, 2) }])).toEqual([
      0, 48, 96, 144, 192, 240, 288, 336, 384,
    ])
  })

  it('follows a coarse grid', () => {
    expect(gridlineXs(vp, size, [{ start: pos(0), value: frac(2) }])).toEqual([0, 192, 384])
  })

  it('drops lines closer together than 4px, per §5.3 guard 6', () => {
    const dense = [{ start: pos(0), value: frac(1, 32) }] // 3px at this zoom
    expect(gridlineXs(vp, size, dense)).toEqual([0, 96, 192, 288, 384])
  })
})
```

```ts
// src/board/stones.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { isOffGrid } from './stones'

const note = (at: ReturnType<typeof pos>) => ({ id: 'n', layerId: 'l', pos: at, dur: frac(1), pitch: 60 })

describe('isOffGrid on regions', () => {
  it('flags an onset that is not a slot start', () => {
    const regions = [{ start: pos(0), value: frac(1, 3) }]
    expect(isOffGrid(regions, note(pos(0, 1, 3)))).toBe(false)
    expect(isOffGrid(regions, note(pos(0, 1, 4)))).toBe(true)
  })

  it('treats the implicit quarter default as a grid', () => {
    expect(isOffGrid([], note(pos(3)))).toBe(false)
    expect(isOffGrid([], note(pos(3, 1, 2)))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/board/grid.test.ts src/board/stones.test.ts`
Expected: FAIL — `gridlineXs` is not exported; `isOffGrid` takes a `Subdiv`

- [ ] **Step 3: Write the implementation**

Extract `gridlineXs(vp, size, regions): number[]` from `drawGridlines`: call `slotStartsIn` over the visible column span, map through `quartersToX`, and apply §5.3's guard — skip any line closer than 4 px to the previous one. `drawGridlines` then batches those into one `Path2D` per weight (bar lines stay on the meter path until Task 12; until then keep `col % 4 === 0`). In `stones.ts`, `isOffGrid(regions, note)` becomes `!isOnGrid(regions, note.pos)`, and `drawStones` takes `regions` plus a cursor instead of `subdivFor`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/board/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add src/board/grid.ts src/board/grid.test.ts src/board/stones.ts src/board/stones.test.ts
git commit -m "board: gridlines and off-grid flagging read regions"
```

---

### Task 8: The velocity lane becomes slot-scoped

**Files:**
- Modify: `src/board/lane.ts` (`slotKey`, `bucketBySlot`, `drawLane`, `laneSlotAt`, `laneVelocities`)
- Modify: `src/state/boardStore.ts` (`setColVelRange`)
- Modify: `src/ui/VelocityLane.tsx` (commit path)
- Test: `src/board/lane.test.ts`

This is the worst-affected file. Its draw loop iterates **columns** and buckets notes by slot-within-column (`lane.ts:329-352`); a slot spanning two columns breaks that structure, not just its data.

**Interfaces:**
- Consumes: `GridCursor`, `slotStartsIn`, `GridSlot`
- Produces: `slotKey(start: Pos): string` (was `(col, slotIndex)`); `bucketBySlot(regions, notes): Map<string, Note[]>`; `BoardStore.setColVelRange(layerId, fromCol, toCol, vel): void`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/board/lane.test.ts
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { bucketBySlot, slotKey } from './lane'

describe('lane bucketing on regions', () => {
  it('keys buckets by slot start, not by column and index', () => {
    const regions = [{ start: pos(0), value: frac(1, 2) }]
    const notes = [
      { id: 'a', layerId: 'l', pos: pos(0), dur: frac(1, 2), pitch: 60 },
      { id: 'b', layerId: 'l', pos: pos(0, 1, 2), dur: frac(1, 2), pitch: 62 },
    ]
    const buckets = bucketBySlot(regions, notes)
    expect([...buckets.keys()]).toEqual([slotKey(pos(0)), slotKey(pos(0, 1, 2))])
  })

  it('puts both columns of a half-note slot in one bucket', () => {
    const regions = [{ start: pos(0), value: frac(2) }]
    const notes = [
      { id: 'a', layerId: 'l', pos: pos(0), dur: frac(2), pitch: 60 },
      { id: 'b', layerId: 'l', pos: pos(1), dur: frac(1), pitch: 62 }, // off-grid, inside the slot
    ]
    expect(bucketBySlot(regions, notes).get(slotKey(pos(0)))).toHaveLength(2)
  })
})

describe('BoardStore.setColVelRange (design §3.4)', () => {
  it('writes the value to every column a slot covers', () => {
    const store = new BoardStore(createEmptyProject(), { width: 800, height: 600 })
    const id = store.activeLayer().id
    store.setColVelRange(id, 0, 2, 40)
    expect(store.layer(id)!.colVel.get(0)).toBe(40)
    expect(store.layer(id)!.colVel.get(1)).toBe(40)
    expect(store.layer(id)!.colVel.get(2)).toBeUndefined() // half-open
  })

  it('is one command', () => {
    const store = new BoardStore(createEmptyProject(), { width: 800, height: 600 })
    const id = store.activeLayer().id
    store.setColVelRange(id, 0, 4, 55)
    store.undo()
    expect(store.layer(id)!.colVel.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/board/lane.test.ts`
Expected: FAIL — `bucketBySlot` still takes a `Subdiv`

- [ ] **Step 3: Write the implementation**

`slotKey(start: Pos)` delegates to `posKey` from `src/core/pos.ts:92`. `bucketBySlot(regions, notes)` resolves each note's slot with a cursor and buckets by that key. `drawLane` walks `slotStartsIn` over the visible span instead of `for (col...)`, drawing one cell per slot; cell geometry comes from the slot's start and (clipped) duration rather than `slotCellX(vp, col, slot)`. The ghost value for a slot is `colVel.get(slot.start.col) ?? defaultVel` — the slot's **starting** column, per design §3.4. In `VelocityLane.tsx`'s `commit`, replace `board.setColVel(layer.id, plan.col, plan.vel)` with `board.setColVelRange(layer.id, slot.start.col, endCol, plan.vel)` where `endCol = ceil(toQuarters(slot.start + slot.dur))`, inside the existing `board.batch('Velocity', ...)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/board/lane.test.ts && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add src/board/lane.ts src/board/lane.test.ts src/state/boardStore.ts src/ui/VelocityLane.tsx
git commit -m "lane: slot-scoped buckets and range velocity writes"
```

---

### Task 9: The grid menu, interaction, and kit durations

**Files:**
- Create: `src/ui/GridMenu.tsx`
- Delete: `src/ui/SubdivMenu.tsx`
- Modify: `src/board/interaction.ts` (placement duration, kit cap, quick-splits), `src/ui/App.tsx` and `src/ui/BoardView.tsx` (menu wiring)
- Test: `src/board/interaction.test.ts` (create)

**Interfaces:**
- Consumes: `GRID_PRESETS`, `validateGridValue`, `BoardStore.setGridRange`
- Produces: `GridMenu` with props `{ board, layerId, from: Pos, to: Pos | undefined, x, y, onClose }`; `KIT_MAX_DUR = frac(1, 4)`

- [ ] **Step 1: Write the failing test**

```ts
// src/board/interaction.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { placementDuration, KIT_MAX_DUR } from './interaction'

describe('placementDuration (design §3.5)', () => {
  it('is the slot duration on a pitched layer', () => {
    expect(placementDuration({ start: pos(0), dur: frac(2) }, false)).toEqual(frac(2))
  })

  it('caps kit layers at a 16th, however coarse the grid', () => {
    expect(placementDuration({ start: pos(0), dur: frac(4) }, true)).toEqual(KIT_MAX_DUR)
    expect(placementDuration({ start: pos(0), dur: frac(1, 12) }, true)).toEqual(frac(1, 12))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/board/interaction.test.ts`
Expected: FAIL — `placementDuration` is not exported

- [ ] **Step 3: Write the implementation**

Export from `interaction.ts`:

```ts
/** §9.3 says drum durations are not a degree of freedom; a whole-note grid would give a
 *  four-quarter kick, so kit placement takes the lesser of the slot and a 16th. */
export const KIT_MAX_DUR: Frac = frac(1, 4)

export function placementDuration(slot: GridSlot, isKit: boolean): Frac {
  return isKit && fracCmp(slot.dur, KIT_MAX_DUR) > 0 ? KIT_MAX_DUR : slot.dur
}
```

Use it in `placeAt` and `paint`. Replace `SubdivMenu` with `GridMenu`: a list of `GRID_PRESETS` chips plus a custom `n/d` entry, applying to `[from, to)` via `board.setGridRange`. Default range: the bar containing the click (until Task 12 lands meter, use the clicked column to the next). Redefine the `1`–`9` quick-splits in `interaction.ts` as "set the hovered slot's region to `1/n` quarters" and update the §7.2 table in `go-spec.md`.

- [ ] **Step 4: Run tests, typecheck, and the smoke suite**

```bash
npx vitest run
npx tsc -b --noEmit
npx playwright test --project=chromium
```
Expected: PASS — all four smoke flows still place, undo, export and autosave.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ui: grid menu replaces the subdivision menu; kit durations capped"
```

---

### Task 10: Retire `subdiv.ts` and re-run the benchmark

**Files:**
- Modify: `src/core/subdiv.ts` (keep only what `gridMigrate` uses), `src/core/subdiv.test.ts` (trim to the retained surface)
- Modify: `bench/latest.json` (regenerated), `go-spec.md` §3.2

- [ ] **Step 1: Find every remaining reference**

Run: `grep -rn "Subdiv\|subdiv" src/ --include=*.ts --include=*.tsx | grep -v gridMigrate`
Expected: only `types.ts`'s `Subdiv`/`SubdivL2` (still needed to read v1 files) and `subdiv.ts` itself.

- [ ] **Step 2: Delete what nothing uses**

Remove `slotIndexAt`, `slotAt`, `slotCount` and their tests from `subdiv.ts` — `enumerateSlots` and `validateSubdiv` stay, since the v1 reader needs both. Add a header comment: "v1 import only; the live model is `core/grid.ts`."

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run && npx tsc -b --noEmit`
Expected: PASS

- [ ] **Step 4: Re-run the benchmark, per design §3.6**

Run: `npx playwright test --project=bench`
Expected: PASS, with `pan @ min zoom` p95 still under 12 ms. If it regressed, the draw path is calling `slotAt` directly instead of going through the cursor — check `drawStones` and `drawLane`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "core: retire the subdivision tree; regions are the model"
```

---

## Phase C — meter (Tasks 11–14)

### Task 11: The meter map

**Files:**
- Create: `src/core/meter.ts`, `src/core/meter.test.ts`
- Modify: `src/core/types.ts` (`Project.meterMap`)

**Interfaces:**
- Produces: `Meter`, `DEFAULT_METER`, `validateMeter(v, where): Meter`, `buildMeterMap(events): readonly Meter[]`, `barLinesIn(map, from, to): Pos[]`, `groupLinesIn(map, from, to): Pos[]`, `barNumberAt(map, at): { bar: number; beat: number }`, `midiDenominator(beatUnit: Frac): number`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/meter.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from './frac'
import { pos } from './pos'
import { DEFAULT_METER, barLinesIn, barNumberAt, groupLinesIn, midiDenominator, validateMeter } from './meter'

const fourFour = DEFAULT_METER                                     // [1,1,1,1] quarters
const sixEight = { pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }
const sevenEight = { pos: pos(0), beatUnit: frac(1, 2), groups: [2, 2, 3] }

describe('barLinesIn', () => {
  it('places a bar line every sum(groups) * beatUnit quarters', () => {
    expect(barLinesIn([fourFour], pos(0), pos(9))).toEqual([pos(0), pos(4), pos(8)])
    expect(barLinesIn([sixEight], pos(0), pos(7))).toEqual([pos(0), pos(3), pos(6)])
  })

  it('follows a meter change mid-piece', () => {
    const map = [fourFour, { ...sevenEight, pos: pos(8) }]
    expect(barLinesIn(map, pos(0), pos(12))).toEqual([pos(0), pos(4), pos(8), pos(11, 1, 2)])
  })
})

describe('groupLinesIn', () => {
  it('marks the internal group starts of a compound bar', () => {
    expect(groupLinesIn([sevenEight], pos(0), pos(4))).toEqual([pos(1), pos(2)]) // 2+2+3 eighths
  })

  it('never repeats a bar line as a group line', () => {
    expect(groupLinesIn([sixEight], pos(0), pos(6))).toEqual([pos(1, 1, 2), pos(4, 1, 2)])
  })
})

describe('barNumberAt', () => {
  it('counts bars from 1 at the origin', () => {
    expect(barNumberAt([fourFour], pos(0))).toEqual({ bar: 1, beat: 1 })
    expect(barNumberAt([fourFour], pos(5))).toEqual({ bar: 2, beat: 2 })
  })
})

describe('validateMeter', () => {
  it('rejects a beatUnit whose SMF denominator is not a power of two', () => {
    expect(() => validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 3 }, groups: [3] }, 'm'))
      .toThrow(/power of two/)
  })

  it('rejects empty or non-positive groups', () => {
    expect(() => validateMeter({ pos: { col: 0, frac: { n: 0, d: 1 } }, beatUnit: { n: 1, d: 2 }, groups: [] }, 'm'))
      .toThrow(RangeError)
  })
})

describe('midiDenominator', () => {
  it('maps beat units to SMF denominators', () => {
    expect(midiDenominator(frac(1))).toBe(4)
    expect(midiDenominator(frac(1, 2))).toBe(8)
    expect(midiDenominator(frac(2))).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/meter.test.ts`
Expected: FAIL — `Cannot find module './meter'`

- [ ] **Step 3: Write the implementation**

`barLength = sum(groups) * beatUnit`. `barLinesIn` walks from the first meter at or before `from`, stepping by `barLength` and switching when the next meter's position is reached; a meter change **starts a new bar** at its position. `groupLinesIn` walks the groups inside each bar and omits offset 0. `barNumberAt` counts bars from 1 at the origin. `midiDenominator(beatUnit)` is `4 / toNumber(beatUnit)` with a power-of-two check, and `validateMeter` rejects anything else — the grid ladder's triplet values must never leak into `beatUnit`.

Add to `types.ts`: `readonly meterMap: readonly Meter[]` on `Project`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/meter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add src/core/meter.ts src/core/meter.test.ts src/core/types.ts
git commit -m "core: meter map with grouped bars"
```

---

### Task 12: Meter in persistence and on the board

**Files:**
- Modify: `src/io/project.ts` (read/write `meterMap`, default when absent)
- Modify: `src/board/grid.ts` (bar and group line weights), `src/board/ruler.ts` (bar numbers)
- Test: `src/io/project.test.ts`, `src/board/grid.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/io/project.test.ts
describe('meterMap persistence', () => {
  it('round-trips a compound meter', () => {
    const p = { ...createEmptyProject(), meterMap: [{ pos: pos(0), beatUnit: frac(1, 2), groups: [2, 2, 3] }] }
    expect(projectFromString(projectToBlobString(p)).meterMap).toEqual(p.meterMap)
  })

  it('defaults to one 4/4 at the origin when absent', () => {
    const old = JSON.parse(projectToBlobString(createEmptyProject())) as Record<string, unknown>
    delete old.meterMap
    expect(projectFromString(JSON.stringify(old)).meterMap).toEqual([
      { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] },
    ])
  })
})
```

```ts
// add to src/board/grid.test.ts
import { barLineXs } from './grid'

describe('barLineXs', () => {
  it('puts the heavy line on beat one of each bar', () => {
    const meter = [{ pos: pos(0), beatUnit: frac(1, 2), groups: [3, 3] }]
    expect(barLineXs(vp, size, meter)).toEqual([0, 288]) // every 3 quarters at 96px
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/io/project.test.ts src/board/grid.test.ts`
Expected: FAIL — `meterMap` is not read; `barLineXs` is not exported

- [ ] **Step 3: Write the implementation**

`project.ts`: write `meterMap` after `tempoMap`, read it with `validateMeter`, default to `[DEFAULT_METER]` when the key is absent. `grid.ts`: export `barLineXs(vp, size, meterMap)` and `groupLineXs(vp, size, meterMap)`, and draw three weights — bar (thickest, `theme.gridLineBar`), group (`theme.gridLine`), intersection (`theme.gridLineSub`). Delete the `col % 4 === 0` rule. `ruler.ts`: label bars with `barNumberAt` instead of raw column numbers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add -A
git commit -m "meter: persistence, bar lines and bar numbers"
```

---

### Task 13: Ruler meter markers with drag-and-drop

**Files:**
- Create: `src/board/meterMarkers.ts`, `src/board/meterMarkers.test.ts`
- Modify: `src/board/ruler.ts` (draw markers), `src/ui/BoardView.tsx` (pointer handlers), `src/state/boardStore.ts` (`setMeter`, `moveMeter`, `removeMeter`)

The ruler already owns click-seek, drag-loop and right-click-menu (§7.1, §7.2). Markers take the top band and win there; below the band, today's behaviour is unchanged.

**Interfaces:**
- Produces: `MARKER_BAND_HEIGHT = 12`, `markerAt(vp, meterMap, x, y): number | null`, `BoardStore.setMeter(meter): void`, `BoardStore.moveMeter(index, to: Pos): void`, `BoardStore.removeMeter(index): void`

- [ ] **Step 1: Write the failing test**

```ts
// src/board/meterMarkers.test.ts
import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { MARKER_BAND_HEIGHT, markerAt } from './meterMarkers'

const vp = { xQuarters: 0, yPitch: 60, pxPerQuarter: 96, pxPerSemitone: 16 }
const map = [
  { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] },
  { pos: pos(8), beatUnit: frac(1, 2), groups: [2, 2, 3] },
]

describe('markerAt', () => {
  it('hits a marker inside the top band', () => {
    expect(markerAt(vp, map, 8 * 96 + 2, 3)).toBe(1)
  })

  it('misses below the band, so seek and loop keep the rest of the ruler', () => {
    expect(markerAt(vp, map, 8 * 96 + 2, MARKER_BAND_HEIGHT + 4)).toBeNull()
  })

  it('misses between markers', () => {
    expect(markerAt(vp, map, 4 * 96, 3)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/board/meterMarkers.test.ts`
Expected: FAIL — `Cannot find module './meterMarkers'`

- [ ] **Step 3: Write the implementation**

`markerAt` returns the index whose `quartersToX` is within a marker half-width of `x`, and only when `y < MARKER_BAND_HEIGHT`. `ruler.ts` draws each marker as a chip labelled `sum(groups)/midiDenominator(beatUnit)`. In `BoardView.tsx`'s `onRulerDown`, check `markerAt` **before** the existing seek/loop branches; a marker drag calls `board.moveMeter(index, quantized)` on pointerup as one command; the first meter (index 0) cannot move off the origin. Right-click a marker to remove it; drop a new one from the grid menu's meter section.

- [ ] **Step 4: Run tests and the smoke suite**

```bash
npx vitest run
npx playwright test --project=chromium
```
Expected: PASS — the seek and loop flows must still work below the band.

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add -A
git commit -m "ruler: meter markers, dragged to move"
```

---

### Task 14: MIDI time signatures

**Files:**
- Modify: `src/io/midi.ts` (`denominators`, `exportMidi`)
- Test: `src/io/midi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/io/midi.test.ts
describe('time signatures (design §3.7)', () => {
  it('writes one event per meter change', () => {
    const p = project({
      meterMap: [
        { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] },
        { pos: pos(8), beatUnit: frac(1, 2), groups: [2, 2, 3] },
      ],
    })
    const midi = new Midi(exportMidi(p, { ppq: 480 }))
    expect(midi.header.timeSignatures.map((t) => [t.ticks, ...t.timeSignature])).toEqual([
      [0, 4, 4],
      [3840, 7, 8],
    ])
  })

  it('feeds meter positions into the PPQ lcm', () => {
    const p = project({
      meterMap: [
        { pos: pos(0), beatUnit: frac(1), groups: [1, 1, 1, 1] },
        { pos: pos(4, 1, 3), beatUnit: frac(1, 2), groups: [3, 3] },
      ],
    })
    expect(chooseTicksPerQuarter(p).lcm % 3).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/io/midi.test.ts`
Expected: FAIL — `timeSignatures` is hardcoded to `[[0, 4, 4]]`

- [ ] **Step 3: Write the implementation**

In `denominators()`, push `m.pos.frac.d` for every meter. In `exportMidi`, replace the hardcoded array with `project.meterMap.map((m) => ({ ticks: tickOf(m.pos, ppq), timeSignature: [sum(m.groups), midiDenominator(m.beatUnit)] }))`. Add a comment recording that grouping is lost at the SMF boundary — 7/8 [2,2,3] exports as 7/8 — and that it survives in `.go.json`.

- [ ] **Step 4: Run the full suite and the bench**

```bash
npx vitest run && npx tsc -b --noEmit
npx playwright test
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/io/midi.ts src/io/midi.test.ts
git commit -m "midi: time signature events from the meter map"
```

---

### Task 15: Update the spec and the README

**Files:**
- Modify: `go-spec.md` (§3.2, §3.4, §6.1, §7.2, §11), `README.md`

- [ ] **Step 1: Rewrite §3.2**

Replace "Subdivision tree" with "Grid regions": the region list, the implicit quarter default, phase anchoring, clipped slots, the `[1/256, 4]` bound, and the note that regions subsume depth-2 nesting.

- [ ] **Step 2: Rewrite §3.4**

Replace "No time signatures in v1" with the meter map: grouped meters, a map that changes through the piece, bar and group line weights, and the SMF grouping loss.

- [ ] **Step 3: Amend §6.1 and §7.2**

§6.1 gains the multi-column slot rule from design §3.4. §7.2's gesture table gains the redefined quick-splits and the ruler marker band.

- [ ] **Step 4: Update the README**

Bump the test count, and replace "per-layer nested subdivision (≤2 deep, splits 1–16)" in the v1 scope line with the region model.

- [ ] **Step 5: Commit**

```bash
git add go-spec.md README.md
git commit -m "spec: grid regions and meter replace the subdivision tree"
```

---

## Self-Review

**Spec coverage.** Design §3.1 → Task 1. §3.2 → Tasks 2, 5. §3.3 → Tasks 2, 6, 7. §3.4 → Task 8. §3.5 → Task 9. §3.6 → Tasks 3, 10. §3.7 → Tasks 11, 14. §3.8 → Tasks 4, 5, 12. §5's ruler changes → Task 13. §8 step 1 → Tasks 1–10; step 2 → Tasks 11–14. Documentation → Task 15. No section is unimplemented.

**Type consistency.** `GridRegion`, `GridSlot`, `GridCursor`, `slotAt`, `slotStartsIn`, `isOnGrid`, `canonicalizeGrid`, `setGridRange`, `subdivsToRegions`, `slotKey`, `bucketBySlot`, `setColVelRange`, `placementDuration`, `KIT_MAX_DUR`, `Meter`, `barLinesIn`, `groupLinesIn`, `barNumberAt`, `midiDenominator`, `markerAt`, `MARKER_BAND_HEIGHT` are each defined once and used with the same signature throughout.

**Known follow-up, deliberately out of scope here:** design §8 steps 3–6 (the `layout.ts` extraction, the theme object, and the Three.js renderer) are a separate plan, written after this one lands.
