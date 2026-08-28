import { nanoid } from 'nanoid'
import type { Frac, Layer, LayerId, Note, NoteId, Pos, Project } from '../core/types'
import { CommandStack } from '../core/command'
import type { Command } from '../core/command'
import { NoteIndex } from '../core/noteIndex'
import { buildTempoMap } from '../core/tempo'
import type { TempoMap } from '../core/tempo'
import type { Meter } from '../core/meter'
import { buildMeterMap, validateMeter } from '../core/meter'
import { ORIGIN, cmp as posCmp, eq as posEq, key as posKey } from '../core/pos'
import type { GridRegion, GridSlot } from '../core/grid'
import { setGridRange as computeGridRange, slotAt as slotAtGrid } from '../core/grid'
import { initialViewport } from '../board/viewport'
import type { Size, Viewport } from '../board/viewport'

/**
 * The vanilla store. See go-spec.md §2.
 *
 * This module exports NO React hook, by design. That is what makes "a note edit
 * never triggers a React render" structural rather than a rule people remember: a
 * component cannot subscribe to note data even by accident, because there is
 * nothing to subscribe with.
 *
 * Two counters, per §2:
 *  - `renderVersion` bumps on every mutation, including each intermediate frame of
 *    a drag. The canvas watches it.
 *  - `commitVersion` bumps only when a command commits. React watches it, so the
 *    inspector updates once per gesture instead of sixty times a second.
 */

export type BoardListener = () => void

export class BoardStore {
  private project: Project
  private index: NoteIndex
  private tempo: TempoMap
  /**
   * The **built** meter map — `buildMeterMap(project.meterMap)`, kept beside the
   * project the way `tempo` is.
   *
   * Two reasons it lives here rather than being rebuilt by each reader. It is the
   * only form with the anchoring invariant `barLinesIn` / `groupLinesIn` /
   * `barNumberAt` require, so a reader that forgot to build would throw from a draw
   * path (`assertAnchored`). And it is the form the UI indexes into: a marker the user
   * grabs is `meter[i]`, so `moveMeter` / `removeMeter` must mean the same `i`.
   * Rebuilding per reader would let a prepended default shift the indices apart.
   */
  private meter: readonly Meter[]
  private viewport: Viewport
  private readonly listeners = new Set<BoardListener>()

  renderVersion = 0
  commitVersion = 0

  readonly commands: CommandStack

  constructor(project: Project, size: Size) {
    this.project = project
    this.index = NoteIndex.build(project.notes)
    this.tempo = buildTempoMap(project.tempoMap)
    this.meter = buildMeterMap(project.meterMap)
    this.viewport = initialViewport(size)
    this.commands = new CommandStack({
      onCommit: () => {
        this.commitVersion++
        this.touch()
      },
    })
  }

  // --- subscription ---

  subscribe(fn: BoardListener): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Mark the board dirty. The rAF loop redraws only when this has moved (§2). */
  touch(): void {
    this.renderVersion++
    for (const fn of this.listeners) fn()
  }

  // --- reads ---

  getProject(): Project {
    return this.project
  }

  getIndex(): NoteIndex {
    return this.index
  }

  getTempoMap(): TempoMap {
    return this.tempo
  }

  /**
   * The built meter map (§3.7). Safe to hand straight to `barLinesIn`, `groupLinesIn`
   * and `barNumberAt`, and the list marker indices refer to.
   */
  getMeterMap(): readonly Meter[] {
    return this.meter
  }

  getViewport(): Viewport {
    return this.viewport
  }

  activeLayer(): Layer {
    const found = this.project.layers.find((l) => l.id === this.project.activeLayerId)
    if (!found) throw new Error('BoardStore: activeLayerId does not resolve')
    return found
  }

  layer(id: LayerId): Layer | undefined {
    return this.project.layers.find((l) => l.id === id)
  }

  /** Layers in draw order: by `order`, with the active layer last so it sits on top. */
  drawOrder(): Layer[] {
    const visible = this.project.layers.filter((l) => l.visible)
    const active = this.project.activeLayerId
    return [...visible].sort((a, b) =>
      a.id === active ? 1 : b.id === active ? -1 : a.order - b.order)
  }

  gridFor(layerId: LayerId): readonly GridRegion[] {
    return this.layer(layerId)?.grid ?? []
  }

  slotAt(layerId: LayerId, at: Pos): GridSlot {
    return slotAtGrid(this.gridFor(layerId), at)
  }

  /** Longest duration on any visible layer — the §4.1 cull/hit widening. */
  maxDur(): number {
    let max = 0
    for (const l of this.project.layers) {
      max = Math.max(max, this.index.maxDurQuarters.get(l.id) ?? 0)
    }
    return max
  }

  // --- viewport (not a command: pan/zoom is not undoable) ---

  setViewport(vp: Viewport): void {
    if (vp === this.viewport) return
    this.viewport = vp
    this.touch()
  }

  // --- note edits, all through commands (§4.2) ---

  private run(cmd: Command): void {
    this.commands.execute(cmd)
  }

  /** Fold a gesture into one undo entry — the §7.3 one-command-per-drag rule. */
  batch(label: string, fn: () => void): void {
    this.commands.batch(label, fn)
  }

  placeNote(partial: Omit<Note, 'id'>): NoteId {
    const note: Note = { ...partial, id: nanoid(10) }
    this.run({
      label: 'Place stone',
      do: () => {
        this.index.insert(note)
        this.syncNotes()
      },
      undo: () => {
        this.index.remove(note.id)
        this.syncNotes()
      },
    })
    return note.id
  }

  removeNote(id: NoteId): void {
    const note = this.index.byId.get(id)
    if (!note) return
    this.run({
      label: 'Remove stone',
      do: () => {
        this.index.remove(id)
        this.syncNotes()
      },
      undo: () => {
        this.index.insert(note)
        this.syncNotes()
      },
    })
  }

  /** Move or resize. `next` must carry the same id (§4.1 unlink-then-link). */
  updateNote(id: NoteId, next: Partial<Omit<Note, 'id'>>, label = 'Edit stone'): void {
    const prev = this.index.byId.get(id)
    if (!prev) return
    const updated: Note = { ...prev, ...next, id }
    if (
      updated.pitch === prev.pitch && posEq(updated.pos, prev.pos) &&
      updated.dur === prev.dur && updated.vel === prev.vel &&
      updated.layerId === prev.layerId
    ) return
    this.run({
      label,
      do: () => {
        this.index.update(id, updated)
        this.syncNotes()
      },
      undo: () => {
        this.index.update(id, prev)
        this.syncNotes()
      },
    })
  }

  /** The §7 duplicate gesture: same note, new id, so undo removes only the copy. */
  duplicateNote(id: NoteId, at: Pos, pitch: number): NoteId | undefined {
    const src = this.index.byId.get(id)
    if (!src) return undefined
    return this.placeNote({ ...src, pos: at, pitch })
  }

  noteAt(layerId: LayerId, pitch: number, at: Pos): Note | undefined {
    return this.index.findExact(layerId, pitch, at)
  }

  private syncNotes(): void {
    // The index is authoritative at runtime; the project's array is the storage
    // form and is refreshed from it (§4, §4.1).
    const notes: Note[] = []
    for (const list of this.index.notesByLayer.values()) notes.push(...list)
    this.project = { ...this.project, notes }
    this.touch()
  }

  // --- layer edits ---

  private putLayer(next: Layer, label: string): void {
    const prev = this.layer(next.id)
    if (!prev) return
    const swap = (l: Layer) => {
      this.project = {
        ...this.project,
        layers: this.project.layers.map((x) => (x.id === l.id ? l : x)),
      }
      this.touch()
    }
    this.run({ label, do: () => swap(next), undo: () => swap(prev) })
  }

  setLayerFlag(id: LayerId, key: 'audible' | 'visible', value: boolean): void {
    const l = this.layer(id)
    if (!l || l[key] === value) return
    this.putLayer({ ...l, [key]: value }, value ? `Show ${key}` : `Hide ${key}`)
  }

  renameLayer(id: LayerId, name: string): void {
    const l = this.layer(id)
    if (!l || l.name === name) return
    this.putLayer({ ...l, name }, 'Rename layer')
  }

  setLayerColor(id: LayerId, color: string): void {
    const l = this.layer(id)
    if (!l || l.color === color) return
    this.putLayer({ ...l, color }, 'Recolor layer')
  }

  setLayerDefaultVel(id: LayerId, defaultVel: number): void {
    const l = this.layer(id)
    if (!l || l.defaultVel === defaultVel) return
    this.putLayer({ ...l, defaultVel }, 'Layer velocity')
  }

  setActiveLayer(id: LayerId): void {
    if (this.project.activeLayerId === id || !this.layer(id)) return
    const prev = this.project.activeLayerId
    const swap = (to: LayerId) => {
      this.project = { ...this.project, activeLayerId: to }
      this.touch()
    }
    this.run({ label: 'Select layer', do: () => swap(id), undo: () => swap(prev) })
  }

  /** §7.3: one command, however many regions the edit touches. Re-quantizes nothing. */
  setGridRange(layerId: LayerId, from: Pos, to: Pos | undefined, value: Frac): void {
    const l = this.layer(layerId)
    if (!l) return
    const prev = l.grid
    const next = computeGridRange(prev, from, to, value)
    const swap = (grid: readonly GridRegion[]) => {
      this.project = {
        ...this.project,
        layers: this.project.layers.map((x) => (x.id === layerId ? { ...x, grid } : x)),
      }
      this.touch()
    }
    this.run({ label: 'Set grid', do: () => swap(next), undo: () => swap(prev) })
  }

  setColVel(layerId: LayerId, col: number, vel: number | undefined): void {
    const l = this.layer(layerId)
    if (!l) return
    const prev = l.colVel.get(col)
    const swap = (to: number | undefined) => {
      const colVel = new Map(l.colVel)
      if (to === undefined) colVel.delete(col)
      else colVel.set(col, to)
      this.project = {
        ...this.project,
        layers: this.project.layers.map((x) => (x.id === layerId ? { ...x, colVel } : x)),
      }
      this.touch()
    }
    this.run({ label: 'Column velocity', do: () => swap(vel), undo: () => swap(prev) })
  }

  /**
   * Set every column in the half-open range `[fromCol, toCol)` to `vel` (design §3.4).
   *
   * Velocity storage stays column-keyed even though the lane is slot-scoped, so a lane
   * edit on a slot spanning several columns has to write all of them — otherwise a note
   * later placed in the slot's second column would inherit a stale value from before
   * the edit. Passing `undefined` clears the range instead.
   *
   * One command for the whole range (§7.3): the previous map is captured whole, so undo
   * restores columns the range overwrote as well as those it created.
   */
  setColVelRange(layerId: LayerId, fromCol: number, toCol: number, vel: number | undefined): void {
    const l = this.layer(layerId)
    if (!l || toCol <= fromCol) return
    const prev = new Map(l.colVel)
    const next = new Map(l.colVel)
    for (let col = fromCol; col < toCol; col++) {
      if (vel === undefined) next.delete(col)
      else next.set(col, vel)
    }
    const swap = (colVel: ReadonlyMap<number, number>) => {
      this.project = {
        ...this.project,
        layers: this.project.layers.map((x) =>
          x.id === layerId ? { ...x, colVel: new Map(colVel) } : x),
      }
      this.touch()
    }
    this.run({ label: 'Column velocity', do: () => swap(next), undo: () => swap(prev) })
  }

  // --- meter (§3.7), every edit a command ---

  /*
   * Why all three of these go through `run` rather than assigning `project.meterMap`
   * directly: `BoardView` caches the map against `commitVersion`, which only moves in
   * the command stack's `onCommit`. A mutation outside a command would leave the board
   * drawing last commit's bar lines until something unrelated committed. It is also
   * the §7.3 rule — one undoable command per gesture — and a meter change that could
   * not be undone would be the only edit on the ruler that could not.
   */

  /** Both maps at once, so `project.meterMap` and `this.meter` can never disagree. */
  private swapMeter(next: readonly Meter[]): void {
    this.project = { ...this.project, meterMap: next }
    this.meter = next
    this.touch()
  }

  /** The map with `m` inserted, replacing any meter already at the same position. */
  private meterMapWith(m: Meter): readonly Meter[] {
    const kept = this.meter.filter((x) => !posEq(x.pos, m.pos))
    return buildMeterMap([...kept, m].sort((a, b) => posCmp(a.pos, b.pos)))
  }

  /**
   * Add a meter change, or replace the one already at that position.
   *
   * Throws a `RangeError` naming the failing field for anything `validateMeter` would
   * reject — a triplet `beatUnit`, one off the §3.1 lattice, an empty or non-integer
   * `groups` — so the grid menu can report it the way it reports an off-lattice tuplet,
   * rather than letting an unrenderable meter into the project.
   *
   * The validator is deliberately the *same* function the file reader calls
   * (`readMeterMap`, `project.ts`): a rule enforced only here would be a rule a
   * hand-edited `.go.json` could walk straight past.
   *
   * **A position before the origin is refused**, the same invariant `moveMeter`
   * enforces for a later meter. Exactly the origin is still allowed — that's how a
   * caller restates the anchor meter itself (see the test of that name) — but a
   * negative column would become the new `map[0]` once `buildMeterMap` sorts it in,
   * silently exiling the *real* anchor to index 1. From there `removeMeter(0)` and
   * `moveMeter(0, …)` both refuse it (by design — see `moveMeter`), `GridMenu` hides
   * the Remove button for it, and the only way out is undo. Ruler columns left of the
   * origin are reachable by panning, so this is reachable in the running app, not just
   * in theory.
   */
  setMeter(meter: Meter): void {
    const m = validateMeter(meter, 'meter')
    if (posCmp(m.pos, ORIGIN) < 0) {
      throw new RangeError(`meter.pos: must not be before the origin, got ${posKey(m.pos)}`)
    }
    const prev = this.meter
    const next = this.meterMapWith(m)
    this.run({
      label: 'Set meter',
      do: () => this.swapMeter(next),
      undo: () => this.swapMeter(prev),
    })
  }

  /**
   * Move meter `index` to `to`. One command for the whole drag (§7.3).
   *
   * **Index 0 is refused.** `buildMeterMap` guarantees `map[0].pos` is at or before
   * the origin, and every function in `meter.ts`'s bar arithmetic asserts it
   * (`assertAnchored`). Moving the first meter off the origin would therefore not
   * misdraw the board, it would throw a `RangeError` out of `barLinesIn` on the very
   * next frame. For the same reason a move onto or before the origin is refused: that
   * position belongs to the anchor, and letting another meter land there would delete
   * it. A move onto a position another meter already occupies is refused too — merging
   * two meters is not what a drag looks like it does.
   */
  moveMeter(index: number, to: Pos): void {
    const prev = this.meter
    const m = prev[index]
    if (index <= 0 || m === undefined) return
    if (posCmp(to, ORIGIN) <= 0) return
    if (posEq(m.pos, to)) return
    if (prev.some((x, i) => i !== index && posEq(x.pos, to))) return

    const moved: Meter = { ...m, pos: to }
    const next = buildMeterMap(
      [...prev.filter((_, i) => i !== index), moved].sort((a, b) => posCmp(a.pos, b.pos)),
    )
    this.run({
      label: 'Move meter',
      do: () => this.swapMeter(next),
      undo: () => this.swapMeter(prev),
    })
  }

  /** Delete meter `index`. Index 0 is refused — see `moveMeter` for why. */
  removeMeter(index: number): void {
    const prev = this.meter
    if (index <= 0 || index >= prev.length) return
    const next = buildMeterMap(prev.filter((_, i) => i !== index))
    this.run({
      label: 'Remove meter',
      do: () => this.swapMeter(next),
      undo: () => this.swapMeter(prev),
    })
  }

  // --- transport-adjacent project state ---

  setLoop(loop: { start: Pos; end: Pos } | undefined): void {
    const prev = this.project.loop
    const swap = (to: { start: Pos; end: Pos } | undefined) => {
      const next = { ...this.project }
      if (to) next.loop = to
      else delete (next as { loop?: unknown }).loop
      this.project = next as Project
      this.touch()
    }
    this.run({ label: to(loop), do: () => swap(loop), undo: () => swap(prev) })
    function to(l: unknown): string {
      return l ? 'Set loop' : 'Clear loop'
    }
  }

  setBpm(bpm: number): void {
    const prev = this.project.tempoMap
    const next = prev.length > 0 ? [{ ...prev[0]!, bpm }, ...prev.slice(1)] : prev
    const swap = (to: readonly { pos: Pos; bpm: number }[]) => {
      this.project = { ...this.project, tempoMap: to }
      this.tempo = buildTempoMap(to)
      this.touch()
    }
    this.run({ label: 'Tempo', do: () => swap(next), undo: () => swap(prev) })
  }

  // --- history ---

  undo(): void {
    this.commands.undo()
  }

  redo(): void {
    this.commands.redo()
  }

  /** Replace the whole document, e.g. on import. Clears history (§4.2). */
  load(project: Project): void {
    this.project = project
    this.index = NoteIndex.build(project.notes)
    this.tempo = buildTempoMap(project.tempoMap)
    this.meter = buildMeterMap(project.meterMap)
    this.commands.clear()
    this.commitVersion++
    this.touch()
  }
}

/** Duration helper: the slot duration a freshly placed stone inherits (§7). */
export type PlacementSlot = { pos: Pos; dur: Frac; pitch: number }
