import { useCallback, useEffect, useRef } from 'react'
import type { Layer, LayerId, Note, NoteId } from '../core/types'
import { toNumber } from '../core/frac'
import { toQuarters } from '../core/pos'
import { StoneAtlas } from '../board/atlas'
import { FrameLoop, makeSurface, sizeSurface } from '../board/canvasHost'
import type { Surface } from '../board/canvasHost'
import { drawGridlines, drawRows } from '../board/grid'
import { GUTTER_WIDTH, drawGutter } from '../board/gutter'
import { BoardInteraction } from '../board/interaction'
import { RULER_HEIGHT, drawRuler } from '../board/ruler'
import { drawStones } from '../board/stones'
import { theme } from '../board/theme'
import { pitchToCenterY, posToX, quartersToX, quartersToWidth, xToQuarters } from '../board/viewport'
import type { BoardStore } from '../state/boardStore'
import { uiSet, useUiStore } from '../state/uiStore'

/**
 * The board surface. See go-spec.md §5.2, §5.3 and §7.
 *
 * Four stacked canvases — gutter, ruler, board, overlay — driven by ONE rAF loop
 * (§5.3), sharing one `Viewport` from the vanilla store. The playhead and hover
 * ghost live on the overlay so a moving playhead does not dirty the whole board
 * every frame for the length of a song.
 *
 * This component renders once and never again: everything below is imperative.
 */

export type BoardViewProps = {
  readonly board: BoardStore
  readonly allowsPitch: (layerId: LayerId, pitch: number) => boolean
  readonly isKit: (layerId: LayerId) => boolean
  readonly kitLabel: (layerId: LayerId, pitch: number) => string | null
  readonly audition: (layerId: LayerId, pitch: number, note: Note) => void
  readonly onSelect: (id: NoteId | null) => void
  readonly onSeek: (quarters: number) => void
  readonly onToggleTransport: () => void
  /** Absolute playhead position in quarters while playing, else null. */
  readonly playheadRef: { current: number | null }
  readonly onSubdivMenu: (col: number, clientX: number, clientY: number) => void
  /**
   * The velocity lane's imperative draw hook. §5.3 allows exactly one rAF owner, so
   * the lane registers here instead of running its own loop.
   */
  readonly laneRef: { current: { drawLane: (dpr: number, forced: boolean) => void } | null }
}

export function BoardView(props: BoardViewProps): React.ReactElement {
  const { board } = props
  const gutterRef = useRef<HTMLCanvasElement | null>(null)
  const rulerRef = useRef<HTMLCanvasElement | null>(null)
  const boardRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const interactionRef = useRef<BoardInteraction | null>(null)

  useEffect(() => {
    const gutterCanvas = gutterRef.current
    const rulerCanvas = rulerRef.current
    const boardCanvas = boardRef.current
    const overlayCanvas = overlayRef.current
    const wrap = wrapRef.current
    if (!gutterCanvas || !rulerCanvas || !boardCanvas || !overlayCanvas || !wrap) return

    const gutter = makeSurface(gutterCanvas)
    const ruler = makeSurface(rulerCanvas)
    const main = makeSurface(boardCanvas)
    const overlay = makeSurface(overlayCanvas)
    // The overlay must composite over the board, so it keeps its alpha channel.
    const overlayCtx = overlayCanvas.getContext('2d')
    const surfaces: Surface[] = [gutter, ruler, main, overlay]

    let atlas = new StoneAtlas(1)
    let lastZoomKey = ''

    const interaction = new BoardInteraction({
      board,
      size: () => main.size,
      audition: (l, p, n) => propsRef.current.audition(l, p, n),
      onSelect: (id) => propsRef.current.onSelect(id),
      allowsPitch: (l, p) => propsRef.current.allowsPitch(l, p),
      isKit: (l) => propsRef.current.isKit(l),
    })
    interactionRef.current = interaction

    // --- drawing ---

    const frame = (dpr: number, forced: boolean) => {
      if (forced) {
        for (const s of surfaces) sizeSurface(s, dpr)
        atlas = new StoneAtlas(dpr)
        lastZoomKey = ''
      }
      const vp = board.getViewport()
      const project = board.getProject()
      const active = board.activeLayer()

      // Radius buckets shift with zoom, so the atlas is rebuilt at zoom change
      // rather than accumulating dead sprites (§5.3).
      const zoomKey = `${vp.pxPerQuarter}|${vp.pxPerSemitone}`
      if (zoomKey !== lastZoomKey) {
        atlas.clear()
        lastZoomKey = zoomKey
      }

      drawRows(main.ctx, vp, main.size)
      drawGridlines(main.ctx, vp, main.size, (col) => active.subdivs.get(col), dpr)
      drawStones(main.ctx, vp, main.size, atlas, {
        index: board.getIndex(),
        layers: board.drawOrder(),
        activeLayerId: active.id,
        subdivFor: (layerId, col) => board.subdivFor(layerId, col),
        isKit: (layerId) => propsRef.current.isKit(layerId),
        maxDurQuarters: board.maxDur(),
      })

      drawGutter(
        gutter.ctx, vp, gutter.size,
        propsRef.current.isKit(active.id)
          ? (pitch) => propsRef.current.kitLabel(active.id, pitch)
          : null,
      )

      const playhead = propsRef.current.playheadRef.current
      drawRuler(ruler.ctx, vp, ruler.size, {
        loop: project.loop,
        playheadQuarters: playhead ?? undefined,
      })

      // Overlay: playhead line and hover ghost only.
      if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlay.size.width, overlay.size.height)
        const hover = interaction.hover
        if (hover) {
          const w = quartersToWidth(vp, toNumber(hover.dur))
          overlayCtx.fillStyle = theme.hoverGhost
          overlayCtx.fillRect(
            posToX(vp, hover.pos), pitchToCenterY(vp, hover.pitch) - vp.pxPerSemitone / 2,
            Math.max(2, w), vp.pxPerSemitone,
          )
        }
        if (playhead !== null) {
          const x = Math.round(quartersToX(vp, playhead)) + 0.5
          overlayCtx.strokeStyle = theme.playhead
          overlayCtx.lineWidth = 1.5
          overlayCtx.beginPath()
          overlayCtx.moveTo(x, 0)
          overlayCtx.lineTo(x, overlay.size.height)
          overlayCtx.stroke()
        }
      }

      // The lane draws last, inside this same callback — one rAF owner (§5.3).
      propsRef.current.laneRef.current?.drawLane(dpr, forced)
    }

    let lastVersion = -1
    const loop = new FrameLoop(
      () => {
        const playing = useUiStore.getState().playing
        return playing || board.renderVersion !== lastVersion
      },
      (dpr, forced) => {
        lastVersion = board.renderVersion
        frame(dpr, forced)
      },
    )
    loop.start()

    const unsubscribe = board.subscribe(() => {})
    const ro = new ResizeObserver(() => loop.invalidate())
    ro.observe(wrap)

    // --- events ---

    const local = (el: HTMLElement, e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const onDown = (e: PointerEvent) => {
      boardCanvas.setPointerCapture(e.pointerId)
      const { x, y } = local(boardCanvas, e)
      interaction.pointerDown(e, x, y)
    }
    const onMove = (e: PointerEvent) => {
      const { x, y } = local(boardCanvas, e)
      interaction.pointerMove(e, x, y)
      board.touch()
    }
    const onUp = (e: PointerEvent) => {
      if (boardCanvas.hasPointerCapture(e.pointerId)) boardCanvas.releasePointerCapture(e.pointerId)
      interaction.pointerUp()
    }
    const onWheel = (e: WheelEvent) => {
      const { x, y } = local(boardCanvas, e)
      interaction.wheel(e, x, y)
    }
    const onContext = (e: MouseEvent) => e.preventDefault()

    boardCanvas.addEventListener('pointerdown', onDown)
    boardCanvas.addEventListener('pointermove', onMove)
    boardCanvas.addEventListener('pointerup', onUp)
    boardCanvas.addEventListener('pointercancel', onUp)
    // React's onWheel cannot reliably preventDefault browser page zoom (§7.3).
    boardCanvas.addEventListener('wheel', onWheel, { passive: false })
    boardCanvas.addEventListener('contextmenu', onContext)

    // Ruler: click seeks, drag sets the loop, shift-click clears, right-click
    // opens the subdivision editor (§7.2).
    let loopAnchor: number | null = null
    const onRulerDown = (e: PointerEvent) => {
      const { x } = local(rulerCanvas, e)
      const vp = board.getViewport()
      const q = xToQuarters(vp, x)
      if (e.button === 2) {
        e.preventDefault()
        propsRef.current.onSubdivMenu(Math.floor(q), e.clientX, e.clientY)
        return
      }
      if (e.button !== 0) return
      if (e.shiftKey) {
        board.setLoop(undefined)
        uiSet({ loopEnabled: false })
        return
      }
      rulerCanvas.setPointerCapture(e.pointerId)
      loopAnchor = q
    }
    const onRulerMove = (e: PointerEvent) => {
      if (loopAnchor === null) return
      const { x } = local(rulerCanvas, e)
      const q = xToQuarters(board.getViewport(), x)
      if (Math.abs(q - loopAnchor) * board.getViewport().pxPerQuarter < 4) return
      const lo = Math.min(loopAnchor, q)
      const hi = Math.max(loopAnchor, q)
      board.setLoop({ start: quantizeQuarter(lo), end: quantizeQuarter(hi) })
      uiSet({ loopEnabled: true })
    }
    const onRulerUp = (e: PointerEvent) => {
      if (rulerCanvas.hasPointerCapture(e.pointerId)) rulerCanvas.releasePointerCapture(e.pointerId)
      if (loopAnchor === null) return
      const { x } = local(rulerCanvas, e)
      const q = xToQuarters(board.getViewport(), x)
      if (Math.abs(q - loopAnchor) * board.getViewport().pxPerQuarter < 4) {
        propsRef.current.onSeek(q)
      }
      loopAnchor = null
    }

    rulerCanvas.addEventListener('pointerdown', onRulerDown)
    rulerCanvas.addEventListener('pointermove', onRulerMove)
    rulerCanvas.addEventListener('pointerup', onRulerUp)
    rulerCanvas.addEventListener('contextmenu', onContext)

    return () => {
      loop.stop()
      ro.disconnect()
      unsubscribe()
      boardCanvas.removeEventListener('pointerdown', onDown)
      boardCanvas.removeEventListener('pointermove', onMove)
      boardCanvas.removeEventListener('pointerup', onUp)
      boardCanvas.removeEventListener('pointercancel', onUp)
      boardCanvas.removeEventListener('wheel', onWheel)
      boardCanvas.removeEventListener('contextmenu', onContext)
      rulerCanvas.removeEventListener('pointerdown', onRulerDown)
      rulerCanvas.removeEventListener('pointermove', onRulerMove)
      rulerCanvas.removeEventListener('pointerup', onRulerUp)
      rulerCanvas.removeEventListener('contextmenu', onContext)
      interactionRef.current = null
    }
  }, [board])

  // Keyboard lives on window so it works regardless of focus (§7.2).
  const onKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    const interaction = interactionRef.current
    if (!interaction) return

    if (e.code === 'Space') {
      // Autorepeat would toggle the transport dozens of times (§7.3).
      e.preventDefault()
      if (e.repeat) return
      propsRef.current.onToggleTransport()
      return
    }
    if (e.key === 'Escape') {
      interaction.cancel()
      board.touch()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) board.redo()
      else board.undo()
      return
    }
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      if (interaction.quickSplit(Number(e.key), false)) e.preventDefault()
      return
    }
    // Shift+1..6 reaches splits 11–16 (§7.2); the shifted key is a symbol.
    const shifted = ['!', '@', '#', '$', '%', '^'].indexOf(e.key)
    if (shifted >= 0 && interaction.quickSplit(shifted + 1, true)) e.preventDefault()
  }, [board])

  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  return (
    <div className="board-view" ref={wrapRef}>
      <div className="board-corner" style={{ width: GUTTER_WIDTH, height: RULER_HEIGHT }} />
      <canvas className="board-ruler" ref={rulerRef} style={{ height: RULER_HEIGHT }} />
      <canvas className="board-gutter" ref={gutterRef} style={{ width: GUTTER_WIDTH }} />
      <div className="board-stage">
        <canvas className="board-main" ref={boardRef} />
        <canvas className="board-overlay" ref={overlayRef} />
      </div>
    </div>
  )
}

/** Loop edges snap to whole quarters in v1 — meter is a v2 concern (§3.4). */
function quantizeQuarter(q: number) {
  return { col: Math.round(q), frac: { n: 0, d: 1 } }
}

/** Absolute quarters of a note's onset, for the transport readout. */
export const noteQuarters = (n: Note): number => toQuarters(n.pos)

/** Layer lookup helper shared by the panels. */
export const layerById = (layers: readonly Layer[], id: LayerId): Layer | undefined =>
  layers.find((l) => l.id === id)
