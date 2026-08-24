import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { LayerId, Note, NoteId } from '../core/types'
import type { BoardStore } from '../state/boardStore'
import { effectiveVelocity } from '../audio/scheduler'
import { toString as fracToString } from '../core/frac'
import { pitchName } from '../board/theme'
import { useUiStore } from '../state/uiStore'
import './chrome.css'

/**
 * The inspector (§6.1).
 *
 * Shows the selected stone — pitch, position, duration, and the velocity that will
 * actually sound, with the rung of the §6.1 ladder it came from — and lets that
 * velocity be typed exactly. Resolution itself is `effectiveVelocity` from the
 * scheduler; it is deliberately not reimplemented here, so the number shown and the
 * number played can never disagree.
 *
 * Per §2 nothing here subscribes to note data. The single board subscription
 * ignores any notification whose `commitVersion` has not moved (drag frames bump
 * `renderVersion` only), and what is pulled out is one note's worth of scalars.
 */

/** The active-layer note count is a document-wide scalar; refresh it lazily. */
const COUNT_THROTTLE_MS = 250

const MAX_VEL = 127

/**
 * "Inherit" is the *absence* of `vel` (§4/§6.1) — not zero. The store's spread does
 * exactly the right thing with an explicit `undefined`, but `exactOptionalPropertyTypes`
 * will not let one through `Partial<Omit<Note, 'id'>>`, so the assertion is confined
 * here. A `BoardStore.clearNoteVel(id)` would retire it.
 */
const INHERIT_VEL = { vel: undefined } as unknown as Partial<Omit<Note, 'id'>>

/**
 * Re-render once per *commit*, never per render frame (§2).
 * `throttleMs > 0` coalesces bursts — used because this panel shows a note count.
 */
function useCommitTick(board: BoardStore, throttleMs = 0): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let seen = board.commitVersion
    let firedAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const fire = (): void => {
      timer = undefined
      firedAt = Date.now()
      setTick((t) => t + 1)
    }
    const unsub = board.subscribe(() => {
      if (board.commitVersion === seen) return // drag frame: renderVersion only
      seen = board.commitVersion
      if (throttleMs <= 0) return fire()
      const wait = throttleMs - (Date.now() - firedAt)
      if (wait <= 0) fire()
      else if (timer === undefined) timer = setTimeout(fire, wait)
    })
    // Anything committed between the first render and this effect.
    fire()
    return () => {
      unsub()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [board, throttleMs])
  return tick
}

/** Which rung of the §6.1 ladder supplied the velocity. */
type VelSource = 'note' | 'column' | 'layer'

type NoteView = {
  readonly kind: 'note'
  readonly id: NoteId
  readonly pitch: number
  readonly col: number
  readonly fracN: number
  readonly fracD: number
  readonly durText: string
  readonly vel: number
  readonly source: VelSource
  readonly hasOwnVel: boolean
  readonly layerName: string
  readonly layerColor: string
  readonly colVel: number | undefined
  readonly layerVel: number
}

type LayerView = {
  readonly kind: 'layer'
  readonly id: LayerId
  readonly name: string
  readonly color: string
  readonly instrumentId: string
  readonly noteCount: number
  readonly defaultVel: number
  readonly visible: boolean
  readonly audible: boolean
}

function readActiveLayer(board: BoardStore): LayerView | null {
  const project = board.getProject()
  const layer = board.layer(project.activeLayerId)
  if (layer === undefined) return null
  return {
    kind: 'layer',
    id: layer.id,
    name: layer.name,
    color: layer.color,
    instrumentId: layer.instrumentId,
    noteCount: board.getIndex().notesByLayer.get(layer.id)?.length ?? 0,
    defaultVel: layer.defaultVel,
    visible: layer.visible,
    audible: layer.audible,
  }
}

function readSelection(board: BoardStore, selectedNoteId: NoteId | null): NoteView | LayerView | null {
  if (selectedNoteId !== null) {
    const note = board.getIndex().byId.get(selectedNoteId)
    const layer = note ? board.layer(note.layerId) : undefined
    if (note !== undefined && layer !== undefined) {
      const colVel = layer.colVel.get(note.pos.col)
      const source: VelSource =
        note.vel !== undefined ? 'note' : colVel !== undefined ? 'column' : 'layer'
      return {
        kind: 'note',
        id: note.id,
        pitch: note.pitch,
        col: note.pos.col,
        fracN: note.pos.frac.n,
        fracD: note.pos.frac.d,
        durText: fracToString(note.dur),
        vel: effectiveVelocity(note, layer),
        source,
        hasOwnVel: note.vel !== undefined,
        layerName: layer.name,
        layerColor: layer.color,
        colVel,
        layerVel: layer.defaultVel,
      }
    }
    // The selection is stale (the stone was deleted or undone away) — fall through
    // to the layer summary rather than showing an empty shell.
  }
  return readActiveLayer(board)
}

function sourceLabel(view: NoteView): string {
  if (view.source === 'note') return 'own override'
  if (view.source === 'column') return `column ${view.col}`
  return 'layer default'
}

function clampVel(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.min(MAX_VEL, Math.max(0, Math.round(parsed)))
}

export function Inspector({ board }: { board: BoardStore }): JSX.Element {
  const tick = useCommitTick(board, COUNT_THROTTLE_MS)
  const selectedNoteId = useUiStore((s) => s.selectedNoteId)
  const view = useMemo(() => readSelection(board, selectedNoteId), [board, selectedNoteId, tick])

  /** Non-null while a velocity field is being typed in. */
  const [draft, setDraft] = useState<string | null>(null)
  const focusKey = view?.kind === 'note' ? view.id : (view?.id ?? '')
  const [draftFor, setDraftFor] = useState('')
  const activeDraft = draftFor === focusKey ? draft : null

  const beginDraft = (value: string): void => {
    setDraftFor(focusKey)
    setDraft(value)
  }

  const commitNoteVel = (raw: string): void => {
    setDraft(null)
    if (view?.kind !== 'note') return
    const vel = clampVel(raw)
    if (vel === null) return
    board.updateNote(view.id, { vel }, 'Note velocity')
  }

  const commitLayerVel = (raw: string): void => {
    setDraft(null)
    if (view?.kind !== 'layer') return
    const vel = clampVel(raw)
    if (vel === null) return
    board.setLayerDefaultVel(view.id, vel)
  }

  if (view === null) {
    return (
      <section className="inspector chrome-panel" aria-label="Inspector">
        <header className="inspector__head chrome-panel__head">
          <h2 className="inspector__title chrome-panel__title">Inspector</h2>
        </header>
        <p className="inspector__empty chrome-dim">No layer</p>
      </section>
    )
  }

  if (view.kind === 'layer') {
    return (
      <section className="inspector chrome-panel inspector--layer" aria-label="Inspector">
        <header className="inspector__head chrome-panel__head">
          <h2 className="inspector__title chrome-panel__title">Inspector</h2>
          <span className="inspector__scope chrome-dim">active layer</span>
        </header>

        <div className="inspector__identity">
          <span className="inspector__chip" style={{ background: view.color }} aria-hidden="true" />
          <span className="inspector__name">{view.name}</span>
        </div>

        <dl className="inspector-grid">
          <dt className="inspector-grid__key">Instrument</dt>
          <dd className="inspector-grid__val">{view.instrumentId}</dd>

          <dt className="inspector-grid__key">Stones</dt>
          <dd className="inspector-grid__val chrome-num">{view.noteCount}</dd>

          <dt className="inspector-grid__key">State</dt>
          <dd className="inspector-grid__val">
            {view.visible ? 'visible' : 'hidden'} · {view.audible ? 'audible' : 'muted'}
          </dd>
        </dl>

        <label className="inspector-vel chrome-field" title="Layer-wide default velocity (§6.1)">
          <span className="inspector-vel__label chrome-field__label">Default velocity</span>
          <input
            className="inspector-vel__input chrome-input chrome-input--num"
            type="number"
            min={0}
            max={MAX_VEL}
            step={1}
            value={activeDraft ?? String(view.defaultVel)}
            onChange={(e) => beginDraft(e.target.value)}
            onBlur={(e) => commitLayerVel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLayerVel(e.currentTarget.value)
              else if (e.key === 'Escape') setDraft(null)
              e.stopPropagation()
            }}
          />
        </label>

        <p className="inspector__hint chrome-dim">Select a stone to edit it.</p>
      </section>
    )
  }

  const posText = view.fracN === 0 ? `${view.col}` : `${view.col} + ${view.fracN}/${view.fracD}`

  return (
    <section className="inspector chrome-panel inspector--note" aria-label="Inspector">
      <header className="inspector__head chrome-panel__head">
        <h2 className="inspector__title chrome-panel__title">Inspector</h2>
        <span className="inspector__scope chrome-dim">stone</span>
      </header>

      <div className="inspector__identity">
        <span className="inspector__chip" style={{ background: view.layerColor }} aria-hidden="true" />
        <span className="inspector__pitch">{pitchName(view.pitch)}</span>
        <span className="inspector__layer chrome-dim">{view.layerName}</span>
      </div>

      <dl className="inspector-grid">
        <dt className="inspector-grid__key">Position</dt>
        <dd className="inspector-grid__val chrome-num" title="column + fraction of a quarter">
          {posText}
        </dd>

        <dt className="inspector-grid__key">Duration</dt>
        <dd className="inspector-grid__val chrome-num" title="quarter notes">
          {view.durText} <span className="inspector-grid__unit chrome-dim">q</span>
        </dd>

        <dt className="inspector-grid__key">MIDI</dt>
        <dd className="inspector-grid__val chrome-num">{view.pitch}</dd>
      </dl>

      <label className="inspector-vel chrome-field" title="Effective velocity, 0–127">
        <span className="inspector-vel__label chrome-field__label">Velocity</span>
        <input
          className="inspector-vel__input chrome-input chrome-input--num"
          type="number"
          min={0}
          max={MAX_VEL}
          step={1}
          value={activeDraft ?? String(view.vel)}
          onChange={(e) => beginDraft(e.target.value)}
          onBlur={(e) => commitNoteVel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitNoteVel(e.currentTarget.value)
            else if (e.key === 'Escape') setDraft(null)
            e.stopPropagation()
          }}
        />
        <span className={`inspector-vel__source inspector-vel__source--${view.source}`}>
          {sourceLabel(view)}
        </span>
      </label>

      <div className="inspector-chain" title="§6.1 resolution order: note → column → layer">
        <span className={`inspector-chain__step ${view.source === 'note' ? 'is-live' : ''}`}>
          note {view.hasOwnVel ? view.vel : '—'}
        </span>
        <span className="inspector-chain__arrow" aria-hidden="true">
          →
        </span>
        <span className={`inspector-chain__step ${view.source === 'column' ? 'is-live' : ''}`}>
          col {view.colVel ?? '—'}
        </span>
        <span className="inspector-chain__arrow" aria-hidden="true">
          →
        </span>
        <span className={`inspector-chain__step ${view.source === 'layer' ? 'is-live' : ''}`}>
          layer {view.layerVel}
        </span>
      </div>

      <button
        type="button"
        className="btn-vel-inherit chrome-btn"
        disabled={!view.hasOwnVel}
        title="Drop this stone's override and inherit from the column or layer (§6.1)"
        onClick={() => board.updateNote(view.id, INHERIT_VEL, 'Clear note velocity')}
      >
        Inherit velocity
      </button>
    </section>
  )
}
