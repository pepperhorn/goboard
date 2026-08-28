import type { GridRegion } from './grid'
import type { Meter } from './meter'

/** Canonical time and project types. See go-spec.md §3–§4. */

/** A rational number, always gcd-normalized with `d > 0`. Zero is always `{n:0,d:1}`. */
export type Frac = { readonly n: number; readonly d: number }

/**
 * A point in musical time.
 * `col` is a quarter-note index — integer, boundless, may be negative.
 * `frac` is the offset within that column, canonically `0 <= frac < 1`.
 */
export type Pos = { readonly col: number; readonly frac: Frac }

/** Depth-2 subdivision node. The absence of `children` is what enforces the depth limit. */
export type SubdivL2 = { readonly split: number }

/** Depth-1 subdivision node: `children.length === split` when present. */
export type Subdiv = {
  readonly split: number
  readonly children?: readonly (SubdivL2 | null)[]
}

/** One enumerated slot within a column, in quarter-note units relative to the column start. */
export type Slot = { readonly start: Frac; readonly dur: Frac }

export type TempoEvent = { readonly pos: Pos; readonly bpm: number }

export type NoteId = string
export type LayerId = string

export type Note = {
  readonly id: NoteId
  readonly layerId: LayerId
  readonly pos: Pos
  readonly dur: Frac
  readonly pitch: number
  readonly vel?: number
}

/**
 * One layer: an instrument, its board appearance, and the per-column state (§4).
 * `colVel` is keyed by `col`; an absent entry means the layer default (`defaultVel`).
 */
export type Layer = {
  readonly id: LayerId
  readonly name: string
  readonly color: string
  readonly instrumentId: string
  /** MIDI export channel, 0-indexed: the spec's "channel 10" for drums is 9 here. */
  readonly channel: number
  /** Mute is `!audible`; `visible` is independent of it — all four combinations are legal. */
  readonly audible: boolean
  readonly visible: boolean
  readonly defaultVel: number
  readonly colVel: Map<number, number>
  /** Rhythmic grid: sorted regions, empty means one line per quarter. See design §3.2. */
  readonly grid: readonly GridRegion[]
  /** Z-order in the layer panel and draw order. */
  readonly order: number
}

/** A whole project — the storage form. Runtime indexes (§4.1) are rebuilt on load. */
export type Project = {
  readonly version: 2
  readonly name: string
  readonly tempoMap: readonly TempoEvent[]
  readonly layers: readonly Layer[]
  readonly notes: readonly Note[]
  readonly activeLayerId: LayerId
  /** Bar lines, bar numbers and MIDI time signatures: sorted by `pos`. See design §3.7. */
  readonly meterMap: readonly Meter[]
  readonly loop?: { readonly start: Pos; readonly end: Pos }
}
