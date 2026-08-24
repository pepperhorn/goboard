import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { BoardStore } from '../state/boardStore'
import { MAX_BPM, MIN_BPM } from '../core/tempo'
import { uiSet, useUiStore } from '../state/uiStore'
import './chrome.css'

/**
 * The transport bar (§3.3, §8.1, §8.2).
 *
 * Everything here except the tempo comes from `useUiStore` — transport state is
 * chrome state. The tempo is read back out of the board store because it lives in
 * the document (`tempoMap[0]`) and is undoable; the UI store copy is kept in sync
 * so the audio engine can read it without touching the document.
 *
 * Per §2 this component never subscribes to note data: its one board subscription
 * ignores every notification whose `commitVersion` has not moved.
 */

/** §8.1's user-tunable playhead offset, in milliseconds. */
const NUDGE_RANGE_MS = 100

/** Re-render once per *commit*, never per render frame (§2). */
function useCommitTick(board: BoardStore): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let seen = board.commitVersion
    const bump = (): void => setTick((t) => t + 1)
    const unsub = board.subscribe(() => {
      if (board.commitVersion === seen) return // drag frame: renderVersion only
      seen = board.commitVersion
      bump()
    })
    // Anything committed between the first render and this effect.
    bump()
    return unsub
  }, [board])
  return tick
}

function readBpm(board: BoardStore): number {
  return board.getProject().tempoMap[0]?.bpm ?? 120
}

/** Trim the float tail: 120 shows as "120", 3.576 keeps its decimals. */
function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 1000) / 1000)
}

export type TransportProps = {
  readonly board: BoardStore
  /** Start playback. Falls back to flipping `playing` in the UI store. */
  readonly onPlay?: () => void
  /** Stop playback. Falls back to flipping `playing` in the UI store. */
  readonly onStop?: () => void
  /** First-gesture `AudioContext` unlock (§8.2). Shown as an explicit affordance. */
  readonly onEnableAudio?: () => void
  /** Notified when the latency nudge moves, so the engine can re-offset (§8.1). */
  readonly onLatencyNudge?: (ms: number) => void
}

export function Transport({
  board,
  onPlay,
  onStop,
  onEnableAudio,
  onLatencyNudge,
}: TransportProps): JSX.Element {
  const tick = useCommitTick(board)
  const bpm = useMemo(() => readBpm(board), [board, tick])
  /** Non-null while the field is being typed in; the board stays authoritative otherwise. */
  const [bpmDraft, setBpmDraft] = useState<string | null>(null)

  const playing = useUiStore((s) => s.playing)
  const canUndo = useUiStore((s) => s.canUndo)
  const canRedo = useUiStore((s) => s.canRedo)
  const undoLabel = useUiStore((s) => s.undoLabel)
  const loopEnabled = useUiStore((s) => s.loopEnabled)
  const auditionEnabled = useUiStore((s) => s.auditionEnabled)
  const audio = useUiStore((s) => s.audio)
  const audioError = useUiStore((s) => s.audioError)
  const loadProgress = useUiStore((s) => s.loadProgress)
  const latencyNudgeMs = useUiStore((s) => s.latencyNudgeMs)

  // Mirror the document tempo into the UI store, including after an undo.
  useEffect(() => {
    uiSet({ bpm })
  }, [bpm])

  const commitBpm = (raw: string): void => {
    setBpmDraft(null)
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, parsed))
    board.setBpm(clamped)
  }

  const togglePlay = (): void => {
    // §8.2: nothing sounds before the first gesture, so play *is* the gesture.
    if (audio === 'locked') onEnableAudio?.()
    if (playing) {
      if (onStop) onStop()
      else uiSet({ playing: false })
    } else {
      if (onPlay) onPlay()
      else uiSet({ playing: true })
    }
  }

  const progressPct = Math.round(Math.min(1, Math.max(0, loadProgress)) * 100)

  return (
    <section className="transport chrome-bar" aria-label="Transport">
      <button
        type="button"
        className={`btn-play chrome-btn chrome-btn--primary ${playing ? 'is-playing' : ''}`}
        title={playing ? 'Stop (Space)' : 'Play (Space)'}
        aria-label={playing ? 'Stop' : 'Play'}
        aria-pressed={playing}
        onClick={togglePlay}
      >
        <span className="btn-play__glyph" aria-hidden="true">
          {playing ? '■' : '▶'}
        </span>
        <span className="btn-play__label">{playing ? 'Stop' : 'Play'}</span>
      </button>

      <label className="transport-bpm chrome-field" title="Tempo, quarter notes per minute">
        <span className="transport-bpm__label chrome-field__label">BPM</span>
        <input
          className="transport-bpm__input chrome-input chrome-input--num"
          type="number"
          inputMode="decimal"
          min={MIN_BPM}
          max={MAX_BPM}
          step={0.5}
          value={bpmDraft ?? formatBpm(bpm)}
          onChange={(e) => setBpmDraft(e.target.value)}
          onBlur={(e) => commitBpm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitBpm(e.currentTarget.value)
            else if (e.key === 'Escape') setBpmDraft(null)
            e.stopPropagation()
          }}
        />
      </label>

      <div className="transport-toggles">
        <button
          type="button"
          className={`btn-loop chrome-btn chrome-btn--toggle ${loopEnabled ? 'is-on' : ''}`}
          title={loopEnabled ? 'Loop on' : 'Loop off'}
          aria-pressed={loopEnabled}
          onClick={() => uiSet({ loopEnabled: !loopEnabled })}
        >
          Loop
        </button>
        <button
          type="button"
          className={`btn-audition chrome-btn chrome-btn--toggle ${auditionEnabled ? 'is-on' : ''}`}
          title="Sound each stone as it is placed or moved (§8.2)"
          aria-pressed={auditionEnabled}
          onClick={() => uiSet({ auditionEnabled: !auditionEnabled })}
        >
          Audition
        </button>
      </div>

      <div className="transport-history">
        <button
          type="button"
          className="btn-undo chrome-btn"
          disabled={!canUndo}
          title={canUndo ? `Undo ${undoLabel ?? ''}`.trim() : 'Nothing to undo'}
          onClick={() => board.undo()}
        >
          <span className="btn-undo__glyph" aria-hidden="true">
            ⟲
          </span>
          <span className="btn-undo__label">{canUndo && undoLabel ? undoLabel : 'Undo'}</span>
        </button>
        <button
          type="button"
          className="btn-redo chrome-btn"
          disabled={!canRedo}
          title={canRedo ? 'Redo' : 'Nothing to redo'}
          aria-label="Redo"
          onClick={() => board.redo()}
        >
          <span className="btn-redo__glyph" aria-hidden="true">
            ⟳
          </span>
        </button>
      </div>

      <label className="transport-nudge chrome-field" title="Playhead offset — nudge until sight and sound agree (§8.1)">
        <span className="transport-nudge__label chrome-field__label">Latency</span>
        <input
          className="transport-nudge__slider"
          type="range"
          min={-NUDGE_RANGE_MS}
          max={NUDGE_RANGE_MS}
          step={1}
          value={latencyNudgeMs}
          onChange={(e) => {
            const ms = Number(e.target.value)
            uiSet({ latencyNudgeMs: ms })
            onLatencyNudge?.(ms)
          }}
        />
        <span className="transport-nudge__value chrome-num">
          {latencyNudgeMs > 0 ? `+${latencyNudgeMs}` : latencyNudgeMs} ms
        </span>
      </label>

      <div className={`transport-audio transport-audio--${audio}`}>
        {audio === 'locked' ? (
          <button
            type="button"
            className="btn-enable-audio chrome-btn chrome-btn--alert"
            title="A browser will not start audio until you click (§8.2)"
            onClick={() => onEnableAudio?.()}
          >
            Click to enable audio
          </button>
        ) : null}

        {audio === 'loading' ? (
          <div className="audio-loading" role="status" aria-live="polite">
            <span className="audio-loading__label">Loading samples</span>
            <span className="audio-loading__track" aria-hidden="true">
              <span className="audio-loading__fill" style={{ width: `${progressPct}%` }} />
            </span>
            <span className="audio-loading__pct chrome-num">{progressPct}%</span>
          </div>
        ) : null}

        {audio === 'ready' ? (
          <span className="audio-ready" title="Audio running">
            <span className="audio-ready__dot" aria-hidden="true" />
            Audio ready
          </span>
        ) : null}

        {audio === 'error' ? (
          <span className="audio-error" role="alert" title={audioError ?? 'Audio failed'}>
            Audio failed{audioError ? ` — ${audioError}` : ''}
          </span>
        ) : null}
      </div>
    </section>
  )
}
