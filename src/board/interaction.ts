import type { Frac, LayerId, Note, NoteId, Pos } from '../core/types'
import { add as fracAdd, cmp as fracCmp, frac, isPositive, toNumber } from '../core/frac'
import { add as posAdd, cmp as posCmp, diff as posDiff, key as posKey, pos } from '../core/pos'
import type { GridSlot } from '../core/grid'
import type { GridCursor } from '../core/gridCursor'
import { createGridCursor } from '../core/gridCursor'
import type { BoardStore } from '../state/boardStore'
import {
  DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH, createDragLatch, hitNote, pointToSlot, resizeZone,
} from './hitTest'
import type { DragLatch, SlotHit } from './hitTest'
import { slotWidthFor } from './stones'
import {
  MAX_PITCH, MIN_PITCH, panBy, posToX, xToQuarters, zoomAbout,
} from './viewport'
import type { Size } from './viewport'

/**
 * Board pointer and wheel handling. See go-spec.md §7.2 and §7.3.
 *
 * §7.3's rules are load-bearing rather than cosmetic, so they are implemented here
 * explicitly: the drag latch is one-way (a 2 px twitch mid-move must not delete a
 * note), every gesture commits exactly one command, and hit testing is geometric so
 * off-grid stones stay reachable.
 */

export type InteractionDeps = {
  readonly board: BoardStore
  readonly size: () => Size
  /** Fire a note immediately at its effective velocity (§8.2); no-op when disabled. */
  readonly audition: (layerId: LayerId, pitch: number, note: Note) => void
  readonly onSelect: (id: NoteId | null) => void
  /** Kit layers reject placement on unmapped rows (§9.3). */
  readonly allowsPitch: (layerId: LayerId, pitch: number) => boolean
  /** Kit layers force one-slot durations (§9.3), so resize is disabled there. */
  readonly isKit: (layerId: LayerId) => boolean
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'place'; latch: DragLatch; painted: Set<string>; first: SlotHit }
  | {
      kind: 'note'
      latch: DragLatch
      note: Note
      /** Pixel offset from the note's head to the grab point, so it does not jump. */
      grabDx: number
      duplicate: boolean
      createdId: NoteId | null
      moved: boolean
      lastPitch: number
    }
  | { kind: 'resize'; latch: DragLatch; note: Note; changed: boolean }

export class BoardInteraction {
  private mode: Mode = { kind: 'idle' }
  private hoverSlot: SlotHit | null = null

  constructor(private readonly deps: InteractionDeps) {}

  /** The slot under the pointer, for the hover ghost. */
  get hover(): SlotHit | null {
    return this.hoverSlot
  }

  /**
   * One grid cursor per layer, rebuilt when a command commits (§3.6). Every draw and
   * hit path resolves the grid through a cursor rather than a fresh binary search per
   * query; a hit test asks about several notes on the same layer in a row, so the
   * cursor's forward walk is exactly the access pattern it was written for.
   */
  private cursors = new Map<LayerId, GridCursor>()
  private cursorVersion = -1

  private cursorFor(layerId: LayerId): GridCursor {
    const board = this.deps.board
    if (board.commitVersion !== this.cursorVersion) {
      this.cursors.clear()
      this.cursorVersion = board.commitVersion
    }
    const existing = this.cursors.get(layerId)
    if (existing) return existing
    const cursor = createGridCursor(board.gridFor(layerId))
    this.cursors.set(layerId, cursor)
    return cursor
  }

  private activeCursor(): GridCursor {
    return this.cursorFor(this.deps.board.activeLayer().id)
  }

  private slotWidthOf = (note: Note): number => {
    const board = this.deps.board
    return slotWidthFor(board.getViewport(), this.cursorFor(note.layerId), note)
  }

  // --- pointer ---

  pointerDown(e: PointerEvent, x: number, y: number): void {
    const { board } = this.deps

    // Middle button is pan (§7.2); prevent the Linux paste / Windows autoscroll default.
    if (e.button === 1) {
      e.preventDefault()
      this.mode = { kind: 'pan', lastX: x, lastY: y }
      return
    }
    if (e.button !== 0) return

    const vp = board.getViewport()
    const active = board.activeLayer()
    const threshold = e.pointerType === 'touch' ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE
    const latch = createDragLatch(x, y, threshold)

    const hit = hitNote(vp, board.getIndex(), board.getProject().layers, active.id, x, y, {
      slotWidthPx: this.slotWidthOf,
    })

    if (hit) {
      this.deps.onSelect(hit.id)
      if (!this.deps.isKit(hit.layerId) && resizeZone(vp, hit, x, this.slotWidthOf(hit))) {
        this.mode = { kind: 'resize', latch, note: hit, changed: false }
        return
      }
      this.mode = {
        kind: 'note',
        latch,
        note: hit,
        grabDx: x - posToX(vp, hit.pos),
        // Ctrl/Cmd-drag duplicates. Alt is deliberately not used here — desktop
        // environments consume Alt+drag, and §6.2 already uses it in the lane (§7.2).
        duplicate: e.ctrlKey || e.metaKey,
        createdId: null,
        moved: false,
        lastPitch: hit.pitch,
      }
      return
    }

    const slot = pointToSlot(vp, this.activeCursor(), x, y)
    if (!slot) return
    this.deps.onSelect(null)
    this.mode = { kind: 'place', latch, painted: new Set(), first: slot }
  }

  pointerMove(_e: PointerEvent, x: number, y: number): void {
    const { board } = this.deps
    const vp = board.getViewport()

    if (this.mode.kind === 'idle') {
      this.hoverSlot = pointToSlot(vp, this.activeCursor(), x, y)
      return
    }

    if (this.mode.kind === 'pan') {
      board.setViewport(panBy(vp, x - this.mode.lastX, y - this.mode.lastY, this.deps.size()))
      this.mode = { kind: 'pan', lastX: x, lastY: y }
      return
    }

    if (!this.mode.latch.update(x, y)) return

    switch (this.mode.kind) {
      case 'place':
        this.paint(x, y)
        break
      case 'note':
        this.dragNote(x, y)
        break
      case 'resize':
        this.dragResize(x)
        break
    }
  }

  pointerUp(): void {
    const { board } = this.deps
    const mode = this.mode
    this.mode = { kind: 'idle' }

    // A click — the threshold was never crossed — is the toggle gesture (§7.2).
    if (mode.kind === 'place' && !mode.latch.dragging) {
      this.placeAt(mode.first)
      return
    }
    if (mode.kind === 'note' && !mode.latch.dragging) {
      board.removeNote(mode.note.id)
      this.deps.onSelect(null)
    }
  }

  /** Escape cancels an in-flight drag (§7.2). */
  cancel(): void {
    const mode = this.mode
    this.mode = { kind: 'idle' }
    if (mode.kind === 'note' || mode.kind === 'resize' || mode.kind === 'place') {
      // Every gesture is a single command, so one undo restores the pre-drag state.
      if (this.deps.board.commands.canUndo) this.deps.board.undo()
    }
  }

  // --- gesture bodies ---

  private placeAt(slot: SlotHit): void {
    const { board } = this.deps
    const layer = board.activeLayer()
    if (!this.deps.allowsPitch(layer.id, slot.pitch)) return

    const existing = board.noteAt(layer.id, slot.pitch, slot.pos)
    if (existing) {
      board.removeNote(existing.id)
      return
    }
    const id = board.placeNote({
      layerId: layer.id,
      pos: slot.pos,
      dur: placementDuration({ start: slot.pos, dur: slot.dur }, this.deps.isKit(layer.id)),
      pitch: slot.pitch,
    })
    const placed = board.getIndex().byId.get(id)
    if (placed) this.deps.audition(layer.id, slot.pitch, placed)
  }

  /** Drag from an empty slot paints stones — a large win on drum layers (§7.2). */
  private paint(x: number, y: number): void {
    if (this.mode.kind !== 'place') return
    const { board } = this.deps
    const layer = board.activeLayer()
    const slot = pointToSlot(board.getViewport(), this.activeCursor(), x, y)
    if (!slot) return

    const key = `${posKey(slot.pos)}:${slot.pitch}`
    if (this.mode.painted.has(key)) return
    this.mode.painted.add(key)
    if (!this.deps.allowsPitch(layer.id, slot.pitch)) return
    if (board.noteAt(layer.id, slot.pitch, slot.pos)) return

    board.batch('Paint stones', () => {
      const id = board.placeNote({
        layerId: layer.id,
        pos: slot.pos,
        dur: placementDuration({ start: slot.pos, dur: slot.dur }, this.deps.isKit(layer.id)),
        pitch: slot.pitch,
      })
      const placed = board.getIndex().byId.get(id)
      if (placed) this.deps.audition(layer.id, slot.pitch, placed)
    })
  }

  private dragNote(x: number, y: number): void {
    if (this.mode.kind !== 'note') return
    const { board } = this.deps
    const vp = board.getViewport()

    // Resolve the slot under the ORIGINAL grab point, so the stone tracks the
    // pointer instead of snapping its head there.
    const target = pointToSlot(vp, this.activeCursor(), x - this.mode.grabDx, y)
    if (!target) return
    if (!this.deps.allowsPitch(this.mode.note.layerId, target.pitch)) return

    if (this.mode.duplicate && this.mode.createdId === null) {
      const id = board.duplicateNote(this.mode.note.id, target.pos, target.pitch)
      if (id) this.mode = { ...this.mode, createdId: id, moved: true }
      return
    }

    const id = this.mode.createdId ?? this.mode.note.id
    const current = board.getIndex().byId.get(id)
    if (!current) return
    if (posCmp(current.pos, target.pos) === 0 && current.pitch === target.pitch) return

    board.updateNote(id, { pos: target.pos, pitch: target.pitch }, 'Move stone')
    if (target.pitch !== this.mode.lastPitch) {
      // Audition only when the pitch changes, or a drag machine-guns (§7.3).
      const moved = board.getIndex().byId.get(id)
      if (moved) this.deps.audition(moved.layerId, target.pitch, moved)
      this.mode = { ...this.mode, lastPitch: target.pitch, moved: true }
    }
  }

  private dragResize(x: number): void {
    if (this.mode.kind !== 'resize') return
    const { board } = this.deps
    const vp = board.getViewport()
    const note = this.mode.note

    const target = pointToSlot(vp, this.activeCursor(), x, 0)
    if (!target) return
    // The new end is the far edge of the slot under the pointer, so a resize always
    // lands on a slot boundary (§7.2 "in slot increments").
    const end = posAdd(target.pos, target.dur)
    const dur: Frac = posDiff(note.pos, end)
    if (!isPositive(dur)) return

    const current = board.getIndex().byId.get(note.id)
    if (!current || toNumber(current.dur) === toNumber(dur)) return
    board.updateNote(note.id, { dur }, 'Resize stone')
  }

  // --- wheel ---

  wheel(e: WheelEvent, x: number, y: number): void {
    const { board } = this.deps
    e.preventDefault()
    const vp = board.getViewport()
    const size = this.deps.size()

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+wheel and pinch both arrive here; zoom about the cursor (§5.1).
      const factor = Math.exp(-e.deltaY * 0.002)
      board.setViewport(zoomAbout(vp, x, y, factor, factor, size))
      return
    }
    if (e.shiftKey) {
      board.setViewport(panBy(vp, -e.deltaX - e.deltaY, 0, size))
      return
    }
    board.setViewport(panBy(vp, -e.deltaX, -e.deltaY, size))
  }

  // --- keyboard: quick-set grid (§7.2) ---

  /**
   * `1`–`9`,`0` set `n` = 1–10; Shift+`1`–`6` reach 11–16. The keys are unchanged from
   * the old per-column splits so muscle memory survives; only the *meaning* moved. `n`
   * now sets the grid to `1/n` quarters over the hovered slot's column — regions made
   * nesting meaningless, so there is no second level to fall through to.
   *
   * Every denominator 1–16 divides the §3.1 lattice, so no key can produce a value
   * `validateGridValue` would reject.
   *
   * `[col, col + 1)` is the same default range the grid menu uses, and
   * `setGridRange` is one command, so a keystroke is one undo (§7.3).
   */
  quickGrid(digit: number, shift: boolean): boolean {
    const n = shift ? digit + 10 : digit === 0 ? 10 : digit
    if (n < 1 || n > 16) return false
    const slot = this.hoverSlot
    if (!slot) return false

    const { board } = this.deps
    const col = slot.pos.col
    board.setGridRange(board.activeLayer().id, pos(col), pos(col + 1), frac(1, n))
    return true
  }
}

/**
 * §9.3 says drum durations are not a degree of freedom, and a whole-note grid would
 * otherwise give a four-quarter kick — so kit placement takes the lesser of the slot
 * and a 16th.
 */
export const KIT_MAX_DUR: Frac = frac(1, 4)

/** The duration a stone placed in `slot` inherits (design §3.5). */
export function placementDuration(slot: GridSlot, isKit: boolean): Frac {
  return isKit && fracCmp(slot.dur, KIT_MAX_DUR) > 0 ? KIT_MAX_DUR : slot.dur
}

/** Screen x on the ruler back to a quarter position, for seek and loop (§7.2). */
export function rulerQuarters(vpXQuarters: number, pxPerQuarter: number, x: number): number {
  return xToQuarters({ xQuarters: vpXQuarters, yPitch: 0, pxPerQuarter, pxPerSemitone: 1 }, x)
}

/** Clamp a pitch to the MIDI range, for keyboard nudges. */
export const clampPitch = (p: number): number =>
  p < MIN_PITCH ? MIN_PITCH : p > MAX_PITCH ? MAX_PITCH : p

/** Advance a position by a whole quarter, used by the loop-region helpers. */
export const nextQuarter = (p: Pos, dur: Frac): Pos => posAdd(p, fracAdd(dur, { n: 0, d: 1 }))
