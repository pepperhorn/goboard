import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import type { LayerId, Note } from '../core/types'
import { BoardStore } from '../state/boardStore'
import { BoardView } from '../ui/BoardView'
import { VelocityLane } from '../ui/VelocityLane'
import type { LaneApi } from '../ui/VelocityLane'
import { boardFrameStats } from '../board/frameStats'
import type { FrameSnapshot } from '../board/frameStats'
import {
  MIN_PX_PER_QUARTER, MIN_PX_PER_SEMITONE, panBy, visibleCols, visiblePitches, zoomAbout,
} from '../board/viewport'
import type { Size } from '../board/viewport'
import { countInWindow, createBenchProject } from './fixture'
import '../styles.css'

/**
 * The §5.3 benchmark page — "a scripted frame-time number at a fixed viewport and DPR,
 * re-run at every subsequent milestone".
 *
 * It mounts the *real* board and velocity lane, not a stripped copy: the number is
 * meant to move when the playhead, lane, or subdivision passes add work, so a harness
 * that skipped them would report a healthier board than the app has. What it drops is
 * everything React-side (transport, panels, inspector), which never draws per frame.
 *
 * Driven from Playwright at a pinned viewport and `deviceScaleFactor`, because §5.3
 * caps the backing store at `min(dpr, 2)` and a 2x machine draws four times the pixels
 * of a 1x one. Comparing across DPRs is comparing nothing.
 */

const project = createBenchProject()
const board = new BoardStore(project, { width: 1280, height: 700 })

/** No audio, no selection, no kits — the bench measures drawing, not editing. */
const noop = (): void => {}

function BenchShell(): React.ReactElement {
  const playheadRef = useRef<number | null>(null)
  const laneRef = useRef<LaneApi | null>(null)

  return (
    <div className="app-shell bench-shell">
      <div className="app-board">
        <BoardView
          board={board}
          allowsPitch={() => true}
          isKit={() => false}
          kitLabel={() => null}
          audition={(_l: LayerId, _p: number, _n: Note) => {}}
          onSelect={noop}
          onSeek={noop}
          onToggleTransport={noop}
          playheadRef={playheadRef}
          onGridMenu={noop}
          laneRef={laneRef}
        />
      </div>
      <div className="app-lane">
        <VelocityLane
          board={board}
          onCanvas={(_canvas, api) => {
            laneRef.current = api
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The scripted run
// ---------------------------------------------------------------------------

export type PhaseResult = {
  readonly name: string
  readonly frames: FrameSnapshot
  /** Notes inside the culled window during the phase — the number the frames bought. */
  readonly notesInView: number
  readonly pxPerQuarter: number
  readonly pxPerSemitone: number
}

export type BenchResult = {
  readonly totalNotes: number
  readonly board: Size
  readonly dpr: number
  readonly phases: readonly PhaseResult[]
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

function boardSize(): Size {
  const canvas = document.querySelector('.board-main') as HTMLCanvasElement | null
  return { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 }
}

/** Notes the cull leaves for the draw pass, at the current viewport. */
function notesInView(): number {
  const vp = board.getViewport()
  const size = boardSize()
  // The same margin the renderer culls with (§4.1): a note starting left of the screen
  // can still have a lozenge inside it.
  const margin = Math.ceil(board.maxDur())
  const cols = visibleCols(vp, size, margin)
  const pitches = visiblePitches(vp, size)
  return countInWindow(
    board.getProject(),
    { from: cols.start, to: cols.end },
    { from: pitches.lo, to: pitches.hi },
  )
}

/**
 * Run one phase: warm up without recording, then record exactly `frames` drawn frames.
 *
 * The warm-up is not padding. The first frames of a phase pay for a sprite-atlas
 * rebuild (zoom changed the radius bucket) and for whatever the JIT has not seen yet;
 * folding those into the p95 would report a number the user never experiences after
 * the first half second of a gesture.
 */
async function phase(
  name: string,
  frames: number,
  step: (i: number, size: Size) => void,
  warmup = 20,
): Promise<PhaseResult> {
  const size = boardSize()
  for (let i = 0; i < warmup; i++) {
    step(i, size)
    await nextFrame()
  }
  boardFrameStats.reset()
  for (let i = 0; i < frames; i++) {
    step(warmup + i, size)
    await nextFrame()
  }
  // One more frame so the last step's draw is recorded before the snapshot.
  await nextFrame()
  const vp = board.getViewport()
  return {
    name,
    frames: boardFrameStats.snapshot(),
    notesInView: notesInView(),
    pxPerQuarter: vp.pxPerQuarter,
    pxPerSemitone: vp.pxPerSemitone,
  }
}

function setZoom(pxPerQuarter: number, pxPerSemitone: number): void {
  const size = boardSize()
  const vp = board.getViewport()
  board.setViewport(
    zoomAbout(vp, 0, size.height / 2, pxPerQuarter / vp.pxPerQuarter, pxPerSemitone / vp.pxPerSemitone, size),
  )
}

async function run(): Promise<BenchResult> {
  const phases: PhaseResult[] = []

  // §5.3's stated worst case: minimum zoom, ~5k notes on screen, panning.
  setZoom(MIN_PX_PER_QUARTER, MIN_PX_PER_SEMITONE)
  board.setViewport({ ...board.getViewport(), xQuarters: 0 })
  phases.push(await phase('pan @ min zoom', 180, (_i, size) => {
    board.setViewport(panBy(board.getViewport(), -4, 0, size))
  }))

  // The zoom the app actually opens at, panning — the common case.
  setZoom(96, 16)
  board.setViewport({ ...board.getViewport(), xQuarters: 0 })
  phases.push(await phase('pan @ default zoom', 120, (_i, size) => {
    board.setViewport(panBy(board.getViewport(), -6, 0, size))
  }))

  // Zoom is the one gesture that cannot self-blit and rebuilds the atlas (§5.3).
  phases.push(await phase('zoom sweep', 120, (i, size) => {
    const factor = Math.floor(i / 20) % 2 === 0 ? 1.04 : 1 / 1.04
    board.setViewport(zoomAbout(board.getViewport(), size.width / 2, size.height / 2, factor, factor, size))
  }))

  return {
    totalNotes: project.notes.length,
    board: boardSize(),
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    phases,
  }
}

declare global {
  interface Window {
    __bench: { run: () => Promise<BenchResult> }
  }
}

createRoot(document.getElementById('root')!).render(<BenchShell />)

// No StrictMode: its double mount would build two boards and two rAF loops, and the
// bench would measure both.
window.__bench = { run }
