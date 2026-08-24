import { useCallback, useEffect, useRef } from 'react'
import type { Note, NoteId } from '../core/types'
import { slotCount } from '../core/subdiv'
import { makeSurface, sizeSurface } from '../board/canvasHost'
import type { Surface } from '../board/canvasHost'
import {
  LANE_HEIGHT,
  bucketBySlot,
  drawLane as paintLane,
  laneSlotAt,
  laneVelocities,
  noteSegments,
  segmentIndexAt,
  slotBarX,
  slotCellX,
  slotKey,
  velocityAtY,
} from '../board/lane'
import type { LaneScene, LaneSlot } from '../board/lane'
import type { BoardStore } from '../state/boardStore'
import { useUiStore } from '../state/uiStore'
import './lane.css'

/**
 * The velocity lane's React wrapper. See go-spec.md §6.2, §5.3, §7.3.
 *
 * This component renders **once**. It owns a canvas and the lane's pointer gestures,
 * and nothing else: note data never reaches React (§2), and the lane deliberately does
 * NOT run a `requestAnimationFrame` loop of its own — §5.3 allows exactly one rAF
 * owner, because three independent loops tear visibly during a fast pan. The parent
 * registers the canvas through `onCanvas` and calls `api.drawLane(dpr, forced)` from
 * inside its own frame callback.
 *
 * Gestures follow §7.3's one-command-per-drag rule the only way an asynchronous drag
 * can: the moves accumulate into a local preview that the lane draws from, and
 * `pointerup` writes the whole gesture through a single `board.batch(...)`. Applying
 * each move directly would put one undo entry per mouse sample on the stack.
 */

/** What the parent's frame callback drives. */
export type LaneApi = {
  /** Draw one lane frame. Resizes the backing store first, per §5.3. */
  drawLane: (dpr: number, forced: boolean) => void
  /** The live canvas, or null once unmounted. */
  canvas: () => HTMLCanvasElement | null
}

export type VelocityLaneProps = {
  readonly board: BoardStore
  /**
   * Register the lane's canvas with the single rAF owner. Called with `(null, null)`
   * on unmount. The `api` argument is optional to consume — a parent typed as
   * `(canvas) => void` satisfies this.
   */
  readonly onCanvas: (canvas: HTMLCanvasElement | null, api: LaneApi | null) => void
  /** §6.2: ~96 px. */
  readonly height?: number
  /** §11 open question 3. Defaults to the `showGhostBars` UI toggle. */
  readonly showGhosts?: boolean
  readonly className?: string
}

/** Everything one drag accumulates before it becomes a single command. */
type DragState = {
  pointerId: number
  /** Alt-drag targets one note for the whole gesture — §6.2's chord-internal override. */
  altNoteId: NoteId | null
  /** `slotKey(col, slotIndex)` -> the slot and the velocity the drag last set on it. */
  slots: Map<string, { col: number; slotIndex: number; vel: number }>
  notes: Map<NoteId, number>
  cancelled: boolean
}

export function VelocityLane({
  board,
  onCanvas,
  height = LANE_HEIGHT,
  showGhosts,
  className,
}: VelocityLaneProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const surfaceRef = useRef<Surface | null>(null)
  const dragRef = useRef<DragState | null>(null)

  // The toggle is chrome state, so React may own it — but the imperative draw reads it
  // through a ref, or a frame drawn between renders would use a stale flag.
  const ghostToggle = useUiStore((s) => s.showGhostBars)
  const ghostsRef = useRef(showGhosts ?? ghostToggle)
  ghostsRef.current = showGhosts ?? ghostToggle

  /** Notes of the active layer whose onset is in `col`. */
  const notesInCol = useCallback(
    (layerId: string, col: number): Note[] =>
      board.getIndex().queryRange(layerId, col, col + 1).filter((n) => n.pos.col === col),
    [board],
  )

  const scene = useCallback((): LaneScene => {
    const layer = board.activeLayer()
    const drag = dragRef.current
    return {
      layer,
      subdivFor: (col) => board.subdivFor(layer.id, col),
      notesInRange: (start, end) => board.getIndex().queryRange(layer.id, start, end),
      showGhosts: ghostsRef.current,
      preview: drag
        ? {
            slots: new Map([...drag.slots].map(([k, v]) => [k, v.vel])),
            notes: drag.notes,
          }
        : undefined,
    }
  }, [board])

  // --- gestures (§6.2) ---

  /** Pointer position in lane CSS px, and the lane's own height. */
  const local = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, h: rect.height }
  }

  const slotNotes = (layerId: string, hit: LaneSlot): Note[] =>
    bucketBySlot(board.subdivFor(layerId, hit.col), notesInCol(layerId, hit.col)).get(
      hit.slotIndex,
    ) ?? []

  /** Record one sample of the drag. Nothing is committed here — see the header. */
  const sample = (e: React.PointerEvent<HTMLCanvasElement>, drag: DragState): void => {
    const { x, y, h } = local(e)
    const layer = board.activeLayer()
    const hit = laneSlotAt(board.getViewport(), (col) => board.subdivFor(layer.id, col), x)
    if (!hit) return
    const vel = velocityAtY(h, y)

    if (drag.altNoteId !== null) {
      // The target is locked at pointerdown: dragging vertically must not slide onto a
      // neighbouring note halfway through the gesture.
      drag.notes.set(drag.altNoteId, vel)
    } else {
      drag.slots.set(slotKey(hit.col, hit.slotIndex), {
        col: hit.col,
        slotIndex: hit.slotIndex,
        vel,
      })
    }
    // Mark the board dirty so the shared rAF owner repaints; React is not involved.
    board.touch()
  }

  /** The note an Alt-drag grabs: the drawn segment under the pointer (§6.2). */
  const altTarget = (e: React.PointerEvent<HTMLCanvasElement>, hit: LaneSlot): NoteId | null => {
    const layer = board.activeLayer()
    const notes = slotNotes(layer.id, hit)
    if (notes.length === 0) return null
    const { velOf } = laneVelocities(layer)
    const segments = noteSegments(notes, (n) => velOf(n, hit.col, hit.slotIndex))
    const cell = slotCellX(board.getViewport(), hit.col, hit)
    const bar = slotBarX(cell.x, cell.width)
    const { x } = local(e)
    return segments[segmentIndexAt(segments.length, bar.x, bar.width, x)]?.noteIds[0] ?? null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 || dragRef.current) return
    const layer = board.activeLayer()
    const { x } = local(e)
    const hit = laneSlotAt(board.getViewport(), (col) => board.subdivFor(layer.id, col), x)
    if (!hit) return

    e.currentTarget.setPointerCapture(e.pointerId)
    const drag: DragState = {
      pointerId: e.pointerId,
      altNoteId: e.altKey ? altTarget(e, hit) : null,
      slots: new Map(),
      notes: new Map(),
      cancelled: false,
    }
    // Alt over an empty slot has no note to override, so it is a no-op rather than a
    // silent fall-through to the whole-slot edit.
    if (e.altKey && drag.altNoteId === null) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      return
    }
    dragRef.current = drag
    sample(e, drag)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    sample(e, drag)
  }

  /** One command for the whole gesture (§7.3). */
  const commit = (drag: DragState): void => {
    const layer = board.activeLayer()
    if (drag.cancelled || (drag.slots.size === 0 && drag.notes.size === 0)) return

    board.batch('Velocity', () => {
      for (const [id, vel] of drag.notes) board.updateNote(id, { vel }, 'Note velocity')

      for (const plan of drag.slots.values()) {
        const sd = board.subdivFor(layer.id, plan.col)
        const notes = bucketBySlot(sd, notesInCol(layer.id, plan.col)).get(plan.slotIndex) ?? []
        // §6.2: an undivided column edits the column value. So does an empty slot —
        // that is what makes a ghost bar draggable, and pre-shaping dynamics is the
        // reason ghosts exist at all.
        if (notes.length === 0 || slotCount(sd) === 1) {
          board.setColVel(layer.id, plan.col, plan.vel)
        } else {
          for (const note of notes) board.updateNote(note.id, { vel: plan.vel }, 'Slot velocity')
        }
      }
    })
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    commit(drag)
    board.touch()
  }

  // Escape cancels the gesture and restores the pre-drag state (§7.2), which here means
  // dropping the preview before it can ever reach the command stack.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const drag = dragRef.current
      if (!drag) return
      drag.cancelled = true
      dragRef.current = null
      board.touch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [board])

  // --- canvas registration ---

  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas
      surfaceRef.current = canvas ? makeSurface(canvas) : null
    },
    [],
  )

  useEffect(() => {
    const api: LaneApi = {
      drawLane: (dpr) => {
        const surface = surfaceRef.current
        if (!surface) return
        sizeSurface(surface, dpr)
        paintLane(surface.ctx, board.getViewport(), surface.size, scene(), dpr)
      },
      canvas: () => canvasRef.current,
    }
    onCanvas(canvasRef.current, api)
    // StrictMode double-invokes effects; deregistering on cleanup keeps the parent from
    // holding a stale api across the second mount.
    return () => onCanvas(null, null)
  }, [board, onCanvas, scene])

  return (
    <div
      className={`velocity-lane lane-strip${className ? ` ${className}` : ''}`}
      style={{ height: `${height}px` }}
    >
      <canvas
        ref={attach}
        className="velocity-lane-canvas lane-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
      />
      <span className="velocity-lane-label lane-badge">vel</span>
    </div>
  )
}
