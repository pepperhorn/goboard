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
