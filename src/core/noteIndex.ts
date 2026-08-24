import type { Frac, LayerId, Note, NoteId, Pos } from './types'
import { ZERO, cmp as fcmp, isZero, toNumber } from './frac'
import { add as padd, cmp as pcmp, eq as peq } from './pos'

/**
 * Runtime note indexes. See go-spec.md §4.1.
 *
 * Three views over the same notes, all maintained incrementally:
 *   - `notesByLayer` sorted by `pos` — playback iteration and viewport queries.
 *   - `notesByCell` keyed by `${layerId}:${col}:${pitch}`, each bucket sorted by
 *     `frac` — placement, toggle and exact lookup. The key drops `frac` on purpose,
 *     so a bucket holds every note at that pitch in that column; the scan is short
 *     but not O(1), and it has no ceiling because changing a subdivision
 *     re-quantizes nothing (§7.3).
 *   - `byId` — the identity map the command layer undoes against.
 *
 * **Long notes are indexed at their onset only.** A note at col 5 with `dur = 4`
 * draws across cols 5–8 but has entries at col 5 alone. Every column-addressed
 * lookup therefore begins its scan at `col - ceil(maxDurQuarters)`, which is exact
 * (nothing on the layer can reach further back) and far cheaper than an interval
 * tree, because `maxDurQuarters` stays ~1–8 in practice. Without the widening,
 * clicking a lozenge's body finds nothing and long notes vanish when panning right.
 */

/** Bucket key for `notesByCell`. `frac` is deliberately absent — see the note above. */
export function cellKey(layerId: LayerId, col: number, pitch: number): string {
  return `${layerId}:${col}:${pitch}`
}

/** End of a note's span, exclusive: `pos + dur`. */
function endOf(note: Note): Pos {
  return padd(note.pos, note.dur)
}

/**
 * Does `note` cover any part of `[from, to)`?
 *
 * Zero-duration notes have an empty half-open span, so they are treated as covering
 * the instant of their onset — otherwise a `dur = 0` note would be unhittable and
 * unrenderable rather than merely degenerate.
 */
function overlaps(note: Note, from: Pos, to: Pos): boolean {
  if (pcmp(note.pos, to) >= 0) return false
  if (isZero(note.dur)) return pcmp(note.pos, from) >= 0
  return pcmp(endOf(note), from) > 0
}

/** First index in a pos-sorted array whose `pos` is `>= p`. */
function lowerBoundByPos(notes: readonly Note[], p: Pos): number {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (pcmp(notes[mid]!.pos, p) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index just past the last entry whose `pos` is `<= p`. Insertion here keeps ties in arrival order. */
function upperBoundByPos(notes: readonly Note[], p: Pos): number {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (pcmp(notes[mid]!.pos, p) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class NoteIndex {
  /** Per layer, sorted by `pos`; ties keep arrival order. */
  readonly notesByLayer = new Map<LayerId, Note[]>()

  /** Per `${layerId}:${col}:${pitch}`, sorted by `frac`; empty buckets are dropped. */
  readonly notesByCell = new Map<string, NoteId[]>()

  readonly byId = new Map<NoteId, Note>()

  /**
   * Longest duration seen on the layer, in quarters. Raised on insert; **never
   * lowered** by `remove` or a shrinking `update`, so it can go stale-*high*.
   * That is safe by construction — it only widens the scan, costing a few extra
   * comparisons — whereas stale-*low* would silently drop long notes from the
   * viewport and from hit-testing, which is the §4.1 correctness bug. Call
   * `recomputeMaxDur` when the slack is worth one linear pass (e.g. after a bulk
   * delete, or when idle).
   *
   * `toNumber` is used only here, and only as a scan bound: the value is fed to
   * `Math.ceil`, and IEEE division is exact whenever the quotient is an integer,
   * so an integer duration can never round down across the ceiling.
   */
  readonly maxDurQuarters = new Map<LayerId, number>()

  /**
   * Arrival order, for the §7.3 "most-recently-added" tiebreak. Preserved across
   * `update`, which moves or resizes an existing note rather than adding one.
   */
  private readonly seqById = new Map<NoteId, number>()
  private nextSeq = 0

  /** Rebuild from scratch — load, import, undo of a bulk edit. */
  static build(notes: readonly Note[]): NoteIndex {
    const index = new NoteIndex()
    for (const note of notes) index.insert(note)
    return index
  }

  insert(note: Note): void {
    if (this.byId.has(note.id)) {
      throw new Error(`NoteIndex: duplicate note id ${note.id}`)
    }
    this.seqById.set(note.id, this.nextSeq++)
    this.link(note)
  }

  /** Returns the removed note, or `undefined` if the id is unknown. */
  remove(noteId: NoteId): Note | undefined {
    const note = this.byId.get(noteId)
    if (note === undefined) return undefined
    this.unlink(note)
    this.seqById.delete(noteId)
    return note
  }

  /**
   * Replace a note. `Note` is readonly, so callers pass a whole new object.
   *
   * The old entries are unlinked *before* the new ones are linked — the move/resize
   * desync of §4.1. Doing it the other way round strands the old cell key, and the
   * note stays clickable at the column it left.
   */
  update(noteId: NoteId, next: Note): void {
    if (next.id !== noteId) {
      throw new Error(`NoteIndex: update id mismatch (${noteId} vs ${next.id})`)
    }
    const prev = this.byId.get(noteId)
    if (prev === undefined) {
      throw new Error(`NoteIndex: update of unknown note id ${noteId}`)
    }
    this.unlink(prev)
    this.link(next)
  }

  /** Exact per-layer max duration, in quarters. Also repairs a stale-high `maxDurQuarters`. */
  recomputeMaxDur(layerId: LayerId): number {
    const notes = this.notesByLayer.get(layerId)
    let max = 0
    if (notes !== undefined) {
      for (const note of notes) {
        const d = toNumber(note.dur)
        if (d > max) max = d
      }
    }
    this.maxDurQuarters.set(layerId, max)
    return max
  }

  /**
   * Every note on the layer overlapping `[startCol, endCol)`, sorted by `pos`.
   *
   * The scan starts at `startCol - ceil(maxDurQuarters)` so that a note whose onset
   * is left of the range but whose duration reaches into it is still found.
   */
  queryRange(layerId: LayerId, startCol: number, endCol: number): Note[] {
    const notes = this.notesByLayer.get(layerId)
    if (notes === undefined || notes.length === 0 || endCol <= startCol) return []

    const from: Pos = { col: startCol, frac: ZERO }
    const to: Pos = { col: endCol, frac: ZERO }
    const scanFrom: Pos = { col: startCol - this.widening(layerId), frac: ZERO }

    const out: Note[] = []
    for (let i = lowerBoundByPos(notes, scanFrom); i < notes.length; i++) {
      const note = notes[i]!
      if (pcmp(note.pos, to) >= 0) break
      if (overlaps(note, from, to)) out.push(note)
    }
    return out
  }

  /**
   * Every note on `pitch` whose span covers any part of column `col` — the lozenge
   * body and right edge included, which is what makes click-to-remove and the
   * resize gesture work on a long note.
   *
   * Sorted by the §7.3 tie rule: shortest duration first, then most-recently-added.
   */
  hitCandidates(layerId: LayerId, col: number, pitch: number): Note[] {
    const candidates = this.queryRange(layerId, col, col + 1).filter((n) => n.pitch === pitch)
    return candidates.sort((a, b) => {
      const byDur = fcmp(a.dur, b.dur)
      if (byDur !== 0) return byDur
      return (this.seqById.get(b.id) ?? 0) - (this.seqById.get(a.id) ?? 0)
    })
  }

  /**
   * The note at exactly `(layerId, pitch, pos)`, if any — the lookup behind the
   * command layer's "no two notes at an identical position" rule.
   */
  findExact(layerId: LayerId, pitch: number, at: Pos): Note | undefined {
    const bucket = this.notesByCell.get(cellKey(layerId, at.col, pitch))
    if (bucket === undefined) return undefined
    for (let i = this.lowerBoundByFrac(bucket, at.frac); i < bucket.length; i++) {
      const note = this.byId.get(bucket[i]!)!
      if (fcmp(note.pos.frac, at.frac) !== 0) break
      if (peq(note.pos, at)) return note
    }
    return undefined
  }

  /** Columns the scan must reach back by to catch every note that can span `col`. */
  private widening(layerId: LayerId): number {
    const max = this.maxDurQuarters.get(layerId) ?? 0
    return max > 0 ? Math.ceil(max) : 0
  }

  /** Add a note to all three views and raise `maxDurQuarters`. */
  private link(note: Note): void {
    this.byId.set(note.id, note)

    let notes = this.notesByLayer.get(note.layerId)
    if (notes === undefined) {
      notes = []
      this.notesByLayer.set(note.layerId, notes)
    }
    notes.splice(upperBoundByPos(notes, note.pos), 0, note)

    const key = cellKey(note.layerId, note.pos.col, note.pitch)
    let bucket = this.notesByCell.get(key)
    if (bucket === undefined) {
      bucket = []
      this.notesByCell.set(key, bucket)
    }
    bucket.splice(this.upperBoundByFrac(bucket, note.pos.frac), 0, note.id)

    const max = this.maxDurQuarters.get(note.layerId) ?? 0
    this.maxDurQuarters.set(note.layerId, Math.max(max, toNumber(note.dur)))
  }

  /** Remove a note from all three views. `maxDurQuarters` is deliberately left alone. */
  private unlink(note: Note): void {
    this.byId.delete(note.id)

    const notes = this.notesByLayer.get(note.layerId)
    if (notes !== undefined) {
      // Ties at one `pos` share a slot range, so scan it for the id rather than
      // trusting the binary search to land on the right one.
      for (let i = lowerBoundByPos(notes, note.pos); i < notes.length; i++) {
        const candidate = notes[i]!
        if (pcmp(candidate.pos, note.pos) > 0) break
        if (candidate.id === note.id) {
          notes.splice(i, 1)
          break
        }
      }
    }

    const key = cellKey(note.layerId, note.pos.col, note.pitch)
    const bucket = this.notesByCell.get(key)
    if (bucket !== undefined) {
      const at = bucket.indexOf(note.id)
      if (at >= 0) bucket.splice(at, 1)
      if (bucket.length === 0) this.notesByCell.delete(key)
    }
  }

  /** First index in a frac-sorted bucket whose note's `frac` is `>= f`. */
  private lowerBoundByFrac(bucket: readonly NoteId[], f: Frac): number {
    let lo = 0
    let hi = bucket.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (fcmp(this.byId.get(bucket[mid]!)!.pos.frac, f) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Index just past the last entry whose `frac` is `<= f`, keeping ties in arrival order. */
  private upperBoundByFrac(bucket: readonly NoteId[], f: Frac): number {
    let lo = 0
    let hi = bucket.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (fcmp(this.byId.get(bucket[mid]!)!.pos.frac, f) <= 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}
