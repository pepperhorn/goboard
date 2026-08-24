import { nanoid } from 'nanoid'
import type { Frac, Layer, LayerId, Note, NoteId, Pos, Project, Subdiv } from '../core/types'
import { CommandStack } from '../core/command'
import type { Command } from '../core/command'
import { NoteIndex } from '../core/noteIndex'
import { buildTempoMap } from '../core/tempo'
import type { TempoMap } from '../core/tempo'
import { eq as posEq } from '../core/pos'
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
  private viewport: Viewport
  private readonly listeners = new Set<BoardListener>()

  renderVersion = 0
  commitVersion = 0

  readonly commands: CommandStack

  constructor(project: Project, size: Size) {
    this.project = project
    this.index = NoteIndex.build(project.notes)
    this.tempo = buildTempoMap(project.tempoMap)
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

  subdivFor(layerId: LayerId, col: number): Subdiv | undefined {
    return this.layer(layerId)?.subdivs.get(col)
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

  /** Per-column subdivision for a layer. Re-quantizes nothing (§7). */
  setSubdiv(layerId: LayerId, col: number, sd: Subdiv | undefined): void {
    const l = this.layer(layerId)
    if (!l) return
    const prev = l.subdivs.get(col)
    const swap = (to: Subdiv | undefined) => {
      const subdivs = new Map(l.subdivs)
      if (to === undefined || to.split === 1) subdivs.delete(col)
      else subdivs.set(col, to)
      this.project = {
        ...this.project,
        layers: this.project.layers.map((x) => (x.id === layerId ? { ...x, subdivs } : x)),
      }
      this.touch()
    }
    this.run({ label: 'Subdivide column', do: () => swap(sd), undo: () => swap(prev) })
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
    this.commands.clear()
    this.commitVersion++
    this.touch()
  }
}

/** Duration helper: the slot duration a freshly placed stone inherits (§7). */
export type PlacementSlot = { pos: Pos; dur: Frac; pitch: number }
