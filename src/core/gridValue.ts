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
