import { useCallback, useEffect, useRef } from 'react'
import type { Layer, LayerId, Note, NoteId } from '../core/types'
import { toNumber } from '../core/frac'
import { toQuarters } from '../core/pos'
import { StoneAtlas } from '../board/atlas'
import { FrameLoop, makeSurface, sizeSurface } from '../board/canvasHost'
import { boardFrameStats } from '../board/frameStats'
import type { Surface } from '../board/canvasHost'
import { drawGridlines, drawRows } from '../board/grid'
import { GUTTER_WIDTH, drawGutter } from '../board/gutter'
import { BoardInteraction } from '../board/interaction'
import { RULER_HEIGHT, drawRuler } from '../board/ruler'
import { drawStones } from '../board/stones'
import type { StoneRegion } from '../board/stones'
import { theme } from '../board/theme'
import {
  panDelta, pitchToCenterY, posToX, quartersToX, quartersToWidth, shiftedViewport, xToQuarters,
} from '../board/viewport'
import type { Viewport } from '../board/viewport'
import type { BoardStore } from '../state/boardStore'
import { uiSet, useUiStore } from '../state/uiStore'

/** How long the zoom must hold still before the atlas is rebuilt (§5.3). */
const ZOOM_SETTLE_MS = 200

/** Sprites kept across a zoom gesture before the set is dropped. */
const ZOOM_ATLAS_BUDGET = 1024

/**
 * The strips a blit exposed: a vertical band on the leading edge, a horizontal one, or
 * both. Each is widened by a pixel because the offset can be a fraction of a CSS pixel
 * on a 2x display, and a clip edge landing mid-pixel would leave a hairline unpainted.
 */
function exposedRegions(
  size: { width: number; height: number },
  delta: { dx: number; dy: number },
): StoneRegion[] {
  const regions: StoneRegion[] = []
  if (delta.dx > 0) {
    regions.push({ x: 0, y: 0, width: Math.ceil(delta.dx) + 1, height: size.height })
  } else if (delta.dx < 0) {
    const width = Math.ceil(-delta.dx) + 1
    regions.push({ x: size.width - width, y: 0, width, height: size.height })
  }
  if (delta.dy > 0) {
    regions.push({ x: 0, y: 0, width: size.width, height: Math.ceil(delta.dy) + 1 })
  } else if (delta.dy < 0) {
    const height = Math.ceil(-delta.dy) + 1
    regions.push({ x: 0, y: size.height - height, width: size.width, height })
  }
  return regions
}

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
  readonly onGridMenu: (col: number, clientX: number, clientY: number) => void
  /**
   * The velocity lane's imperative draw hook. §5.3 allows exactly one rAF owner, so
   * the lane registers here instead of running its own loop.
   */
  readonly laneRef: {
    current: { drawLane: (dpr: number, forced: boolean, vp?: Viewport) => void } | null
  }
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
    // The overlay must composite over the board, so it keeps its alpha channel.
    const overlay = makeSurface(overlayCanvas, { alpha: true })
    const overlayCtx = overlay.ctx
    const surfaces: Surface[] = [gutter, ruler, main, overlay]

    let atlas = new StoneAtlas(1)
    let lastZoomKey = ''
    let zoomChangedAt = 0
    let atlasStale = false
    /**
     * What the board canvas currently shows (§5.3 #3). `null` means "unknown", which
     * forces a full redraw — after a resize, a DPR change, or the first frame.
     */
    let drawnVp: Viewport | null = null
    let drawnCommit = -1

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
        atlasStale = false
        drawnVp = null
      }
      const vp = board.getViewport()
      const project = board.getProject()
      const active = board.activeLayer()

      /*
       * §5.3: radius buckets shift with zoom, so the atlas is rebuilt "on zoom-end" —
       * not on zoom *change*. Clearing on every changed frame was throwing away every
       * sprite mid-gesture and re-baking each one, glow included, 60 times a second:
       * measured at ~17 ms/frame during a zoom sweep with only ~200 stones on screen.
       * Sprites for stale buckets are simply kept until the gesture settles; a few
       * hundred small sprites cost far less than re-baking them.
       */
      const zoomKey = `${vp.pxPerQuarter}|${vp.pxPerSemitone}`
      const nowMs = performance.now()
      if (zoomKey !== lastZoomKey) {
        lastZoomKey = zoomKey
        zoomChangedAt = nowMs
        atlasStale = true
        // A long gesture would otherwise deposit a sprite for every bucket it passes
        // through and pay for a texture growth mid-frame. Dropping the set at a budget
        // keeps the worst zoom frame to one screen's worth of bakes.
        if (atlas.size > ZOOM_ATLAS_BUDGET) atlas.clear()
      } else if (atlasStale && nowMs - zoomChangedAt >= ZOOM_SETTLE_MS) {
        atlas.clear()
        atlasStale = false
      }

      /** One board repaint, optionally restricted to the strip a pan exposed. */
      const paintBoard = (v: Viewport, region: StoneRegion | null): void => {
        main.ctx.save()
        if (region) {
          main.ctx.beginPath()
          main.ctx.rect(region.x, region.y, region.width, region.height)
          main.ctx.clip()
        }
        drawRows(main.ctx, v, main.size)
        drawGridlines(main.ctx, v, main.size, board.gridFor(active.id), dpr)
        drawStones(
          main.ctx, v, main.size, atlas,
          {
            index: board.getIndex(),
            layers: board.drawOrder(),
            activeLayerId: active.id,
            gridFor: (layerId) => board.gridFor(layerId),
            isKit: (layerId) => propsRef.current.isKit(layerId),
            maxDurQuarters: board.maxDur(),
          },
          region ?? undefined,
        )
        main.ctx.restore()
      }

      /*
       * §5.3 #3: pan is pure translation, so the previous frame is blitted at an offset
       * and only the newly exposed strip is repainted — the single biggest win in the
       * renderer, because pan is the dominant gesture. Three conditions have to hold:
       * the zoom is unchanged (`panDelta` checks), nothing was edited (a committed note
       * can appear anywhere, including under the blitted region), and the previous frame
       * is still on the canvas.
       *
       * `boardVp` is the *shifted* viewport rather than the live one: the blit moved by
       * a whole number of device pixels, so the picture on screen corresponds to a
       * viewport up to half a device pixel from `vp`, and drawing the strip with `vp`
       * would leave a hairline seam where the two disagree. Every surface in this frame
       * therefore draws with `boardVp`, and the rounding never accumulates because the
       * next delta is measured from what was actually drawn.
       */
      const edited = board.commitVersion !== drawnCommit
      const delta = forced || drawnVp === null || edited
        ? null
        : panDelta(drawnVp, vp, main.size, dpr)

      let boardVp = vp
      if (delta === null) {
        paintBoard(vp, null)
      } else if (delta.dx !== 0 || delta.dy !== 0) {
        boardVp = shiftedViewport(drawnVp!, delta)
        main.ctx.save()
        // Identity transform: the source bitmap is in device pixels and the offset is
        // already a whole number of them, so this copy neither scales nor resamples.
        main.ctx.setTransform(1, 0, 0, 1, 0, 0)
        main.ctx.imageSmoothingEnabled = false
        main.ctx.drawImage(main.canvas, Math.round(delta.dx * dpr), Math.round(delta.dy * dpr))
        main.ctx.restore()
        for (const region of exposedRegions(main.size, delta)) paintBoard(boardVp, region)
      } else {
        // A dirty frame with no pan and no edit — a hover ghost moving, say. The board
        // is already correct; only the overlay below needs the work.
        boardVp = drawnVp!
      }
      drawnVp = boardVp
      drawnCommit = board.commitVersion

      drawGutter(
        gutter.ctx, boardVp, gutter.size,
        propsRef.current.isKit(active.id)
          ? (pitch) => propsRef.current.kitLabel(active.id, pitch)
          : null,
      )

      const playhead = propsRef.current.playheadRef.current
      drawRuler(ruler.ctx, boardVp, ruler.size, {
        loop: project.loop,
        playheadQuarters: playhead ?? undefined,
      })

      // Overlay: playhead line and hover ghost only.
      if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlay.size.width, overlay.size.height)
        const hover = interaction.hover
        if (hover) {
          const w = quartersToWidth(boardVp, toNumber(hover.dur))
          overlayCtx.fillStyle = theme.hoverGhost
          overlayCtx.fillRect(
            posToX(boardVp, hover.pos),
            pitchToCenterY(boardVp, hover.pitch) - boardVp.pxPerSemitone / 2,
            Math.max(2, w), boardVp.pxPerSemitone,
          )
        }
        if (playhead !== null) {
          const x = Math.round(quartersToX(boardVp, playhead)) + 0.5
          overlayCtx.strokeStyle = theme.playhead
          overlayCtx.lineWidth = 1.5
          overlayCtx.beginPath()
          overlayCtx.moveTo(x, 0)
          overlayCtx.lineTo(x, overlay.size.height)
          overlayCtx.stroke()
        }
      }

      // The lane draws last, inside this same callback — one rAF owner (§5.3).
      // §5.3: the lane is horizontally locked to the board, so it gets the same
      // viewport the board just drew with, not the live one.
      propsRef.current.laneRef.current?.drawLane(dpr, forced, boardVp)
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
      // §5.3's "benchmark, not prose": every drawn frame is timed, so the number can
      // be read back by the bench page (and by a future debug HUD) instead of guessed.
      (ms) => boardFrameStats.record(ms),
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
    // opens the grid editor (§7.2).
    let loopAnchor: number | null = null
    const onRulerDown = (e: PointerEvent) => {
      const { x } = local(rulerCanvas, e)
      const vp = board.getViewport()
      const q = xToQuarters(vp, x)
      if (e.button === 2) {
        e.preventDefault()
        propsRef.current.onGridMenu(Math.floor(q), e.clientX, e.clientY)
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
      if (interaction.quickGrid(Number(e.key), false)) e.preventDefault()
      return
    }
    // Shift+1..6 reaches 1/11–1/16 (§7.2); the shifted key is a symbol.
    const shifted = ['!', '@', '#', '$', '%', '^'].indexOf(e.key)
    if (shifted >= 0 && interaction.quickGrid(shifted + 1, true)) e.preventDefault()
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
