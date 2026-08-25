import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { nanoid } from 'nanoid'
import type { Layer, LayerId } from '../core/types'
import type { BoardStore } from '../state/boardStore'
import { LAYER_COLORS } from '../board/theme'
import { uiSet } from '../state/uiStore'
import './chrome.css'

/**
 * The §4 layer panel.
 *
 * Architecture (§2): this component may read the board store imperatively, but it
 * never subscribes to note data. It subscribes once to `board.subscribe` and
 * ignores every notification whose `commitVersion` has not moved — those are the
 * drag frames that bump `renderVersion` sixty times a second. Note *counts* are a
 * derived scalar, and they are additionally throttled.
 *
 * `visible` and `audible` are deliberately two independent toggles: all four
 * combinations are legal (§4's table), so nothing here couples them.
 */

/** Note counts refresh at most this often, even if commits arrive faster. */
const COUNT_THROTTLE_MS = 250

/** MIDI channel reserved for drum kits (0-indexed; the spec's "channel 10", §4). */
const DRUM_CHANNEL = 9

const MAX_CHANNEL = 15

/** Instrument a freshly added layer starts on (§9.4). */
const NEW_LAYER_INSTRUMENT = 'ph-piano-1'

const INIT_VEL = 96

/**
 * Re-render once per *commit*, never per render frame (§2).
 * `throttleMs > 0` coalesces bursts — used because this panel shows note counts.
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

type LayerRow = {
  readonly id: LayerId
  readonly name: string
  readonly color: string
  readonly visible: boolean
  readonly audible: boolean
  readonly instrumentId: string
  readonly noteCount: number
}

function readRows(board: BoardStore): { rows: LayerRow[]; activeLayerId: LayerId } {
  const project = board.getProject()
  const index = board.getIndex()
  const rows = [...project.layers]
    .sort((a, b) => a.order - b.order)
    .map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      visible: l.visible,
      audible: l.audible,
      instrumentId: l.instrumentId,
      noteCount: index.notesByLayer.get(l.id)?.length ?? 0,
    }))
  return { rows, activeLayerId: project.activeLayerId }
}

// ---------------------------------------------------------------------------
// Structural layer edits
// ---------------------------------------------------------------------------

/**
 * Add / duplicate / delete / reorder as one undoable command.
 *
 * `BoardStore` has no structural layer API yet (it covers rename, color, flags,
 * default velocity and active layer, but not the list itself), so this replaces
 * the contents of the live `layers` array in place and pushes the inverse onto
 * the same command stack. In place matters: `syncNotes` and `setActiveLayer`
 * spread the project object and keep the *same* array reference, and `putLayer`
 * replaces it with a fresh one — hence the array is re-read on every apply
 * rather than captured. Lift this into `BoardStore` when it grows the methods.
 */
function replaceLayers(board: BoardStore, label: string, next: readonly Layer[]): void {
  const before = [...board.getProject().layers]
  const apply = (arr: readonly Layer[]): void => {
    const live = board.getProject().layers as Layer[]
    live.length = 0
    live.push(...arr)
    board.touch()
  }
  board.commands.execute({ label, do: () => apply(next), undo: () => apply(before) })
}

/** Layers in panel order, renumbered so `order` is dense and matches the array. */
function renumber(layers: readonly Layer[]): Layer[] {
  return layers.map((l, order) => (l.order === order ? l : { ...l, order }))
}

function sorted(board: BoardStore): Layer[] {
  return [...board.getProject().layers].sort((a, b) => a.order - b.order)
}

function nextChannel(layers: readonly Layer[]): number {
  const used = new Set(layers.map((l) => l.channel))
  for (let c = 0; c <= MAX_CHANNEL; c++) {
    if (c !== DRUM_CHANNEL && !used.has(c)) return c
  }
  return 0
}

function nextColor(layers: readonly Layer[]): string {
  const used = new Set(layers.map((l) => l.color))
  return LAYER_COLORS.find((c) => !used.has(c)) ?? LAYER_COLORS[layers.length % LAYER_COLORS.length]!
}

function addLayer(board: BoardStore): void {
  const layers = sorted(board)
  const layer: Layer = {
    id: nanoid(8),
    name: `Layer ${layers.length + 1}`,
    color: nextColor(layers),
    instrumentId: NEW_LAYER_INSTRUMENT,
    channel: nextChannel(layers),
    audible: true,
    visible: true,
    defaultVel: INIT_VEL,
    colVel: new Map<number, number>(),
    grid: [],
    order: layers.length,
  }
  board.batch('Add layer', () => {
    replaceLayers(board, 'Add layer', renumber([...layers, layer]))
    board.setActiveLayer(layer.id)
  })
}

function duplicateLayer(board: BoardStore, id: LayerId): void {
  const layers = sorted(board)
  const at = layers.findIndex((l) => l.id === id)
  const src = layers[at]
  if (src === undefined) return
  // The layer's settings are copied; its notes are not (§4 has no bulk note copy).
  // Fresh `Map`s, or the two layers would edit each other's columns.
  const copy: Layer = {
    ...src,
    id: nanoid(8),
    name: `${src.name} copy`,
    channel: nextChannel(layers),
    colVel: new Map(src.colVel),
    grid: [...src.grid],
    order: at + 1,
  }
  const next = [...layers.slice(0, at + 1), copy, ...layers.slice(at + 1)]
  board.batch('Duplicate layer', () => {
    replaceLayers(board, 'Duplicate layer', renumber(next))
    board.setActiveLayer(copy.id)
  })
}

/**
 * Delete a layer, its notes, and — if it was active — hand the active slot to a
 * neighbour first, so `activeLayerId` is never left dangling (§4: it must always
 * resolve, `BoardStore.activeLayer()` throws otherwise).
 */
function deleteLayer(board: BoardStore, id: LayerId): void {
  const layers = sorted(board)
  if (layers.length <= 1) return // a project always has at least one layer
  const at = layers.findIndex((l) => l.id === id)
  if (at < 0) return
  const neighbour = layers[at + 1] ?? layers[at - 1]
  if (neighbour === undefined) return
  const notes = [...(board.getIndex().notesByLayer.get(id) ?? [])]
  board.batch('Delete layer', () => {
    if (board.getProject().activeLayerId === id) board.setActiveLayer(neighbour.id)
    // Orphaned notes would survive in the index and re-appear in `project.notes`,
    // where export would emit a note referencing a layer that no longer exists.
    for (const n of notes) board.removeNote(n.id)
    replaceLayers(board, 'Delete layer', renumber(layers.filter((l) => l.id !== id)))
  })
}

function moveLayer(board: BoardStore, id: LayerId, delta: -1 | 1): void {
  const layers = sorted(board)
  const at = layers.findIndex((l) => l.id === id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= layers.length) return
  const next = [...layers]
  const [moved] = next.splice(at, 1)
  if (moved === undefined) return
  next.splice(to, 0, moved)
  replaceLayers(board, 'Reorder layers', renumber(next))
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function EyeIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg className="icon icon-eye" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
      {open ? null : (
        <path d="M3 13 13 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  )
}

function SpeakerIcon({ on }: { on: boolean }): JSX.Element {
  return (
    <svg className="icon icon-speaker" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 6.1h2.1L9 3.3v9.4L5.6 9.9H3.5z" fill="currentColor" />
      {on ? (
        <>
          <path d="M11 6.2a2.6 2.6 0 0 1 0 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M12.8 4.6a5 5 0 0 1 0 6.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : (
        <path
          d="M11.2 6.2 14 9m0-2.8L11.2 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LayerPanel({ board }: { board: BoardStore }): JSX.Element {
  const tick = useCommitTick(board, COUNT_THROTTLE_MS)
  const { rows, activeLayerId } = useMemo(() => readRows(board), [board, tick])

  const [renaming, setRenaming] = useState<{ id: LayerId; value: string } | null>(null)
  const [palette, setPalette] = useState<LayerId | null>(null)
  const paletteRef = useRef<HTMLDivElement | null>(null)

  // The board owns `activeLayerId` (it is undoable); the UI store mirrors it for
  // consumers that only hold the React store.
  useEffect(() => {
    uiSet({ activeLayerId })
  }, [activeLayerId])

  // Close the swatch palette on an outside press or Escape.
  useEffect(() => {
    if (palette === null) return
    const onDown = (e: PointerEvent): void => {
      if (!paletteRef.current?.contains(e.target as Node)) setPalette(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPalette(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [palette])

  const commitRename = (): void => {
    if (renaming === null) return
    const name = renaming.value.trim()
    if (name.length > 0) board.renameLayer(renaming.id, name)
    setRenaming(null)
  }

  const activeRow = rows.find((r) => r.id === activeLayerId)

  return (
    <section className="layer-panel chrome-panel" aria-label="Layers">
      <header className="layer-panel__head chrome-panel__head">
        <h2 className="layer-panel__title chrome-panel__title">Layers</h2>
        <span className="layer-panel__tally chrome-dim">{rows.length}</span>
      </header>

      <ul className="layer-list" role="listbox" aria-label="Layer list">
        {rows.map((row, i) => {
          const isActive = row.id === activeLayerId
          const cls = [
            'layer-row',
            isActive ? 'layer-row--active' : '',
            row.visible ? '' : 'layer-row--hidden',
            row.audible ? '' : 'layer-row--muted',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <li
              key={row.id}
              className={cls}
              role="option"
              aria-selected={isActive}
              onClick={() => board.setActiveLayer(row.id)}
            >
              <span className="layer-row__rail" style={{ background: row.color }} aria-hidden="true" />

              <div className="layer-swatch-wrap">
                <button
                  type="button"
                  className="layer-swatch"
                  style={{ background: row.color }}
                  title={`Color — ${row.color}`}
                  aria-label={`Change color of ${row.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPalette(palette === row.id ? null : row.id)
                  }}
                />
                {palette === row.id ? (
                  <div className="layer-palette" ref={paletteRef} onClick={(e) => e.stopPropagation()}>
                    {LAYER_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`layer-palette__chip ${c === row.color ? 'layer-palette__chip--on' : ''}`}
                        style={{ background: c }}
                        title={c}
                        aria-label={c}
                        onClick={() => {
                          board.setLayerColor(row.id, c)
                          setPalette(null)
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              {renaming?.id === row.id ? (
                <input
                  className="layer-row__rename chrome-input"
                  value={renaming.value}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenaming({ id: row.id, value: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setRenaming(null)
                    e.stopPropagation()
                  }}
                />
              ) : (
                <span
                  className="layer-row__name"
                  title={`${row.name} — ${row.instrumentId}. Double-click to rename.`}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenaming({ id: row.id, value: row.name })
                  }}
                >
                  {row.name}
                </span>
              )}

              <span className="layer-row__count chrome-dim" title={`${row.noteCount} stones`}>
                {row.noteCount}
              </span>

              <button
                type="button"
                className={`layer-toggle layer-toggle--visible ${row.visible ? 'is-on' : 'is-off'}`}
                title={row.visible ? 'Visible — click to hide' : 'Hidden — click to show'}
                aria-pressed={row.visible}
                aria-label={`${row.visible ? 'Hide' : 'Show'} ${row.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  board.setLayerFlag(row.id, 'visible', !row.visible)
                }}
              >
                <EyeIcon open={row.visible} />
              </button>

              <button
                type="button"
                className={`layer-toggle layer-toggle--audible ${row.audible ? 'is-on' : 'is-off'}`}
                title={row.audible ? 'Audible — click to mute' : 'Muted — click to unmute'}
                aria-pressed={row.audible}
                aria-label={`${row.audible ? 'Mute' : 'Unmute'} ${row.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  board.setLayerFlag(row.id, 'audible', !row.audible)
                }}
              >
                <SpeakerIcon on={row.audible} />
              </button>

              <span className="layer-row__move">
                <button
                  type="button"
                  className="btn-layer-up chrome-btn chrome-btn--nudge"
                  disabled={i === 0}
                  title="Move up"
                  aria-label={`Move ${row.name} up`}
                  onClick={(e) => {
                    e.stopPropagation()
                    moveLayer(board, row.id, -1)
                  }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="btn-layer-down chrome-btn chrome-btn--nudge"
                  disabled={i === rows.length - 1}
                  title="Move down"
                  aria-label={`Move ${row.name} down`}
                  onClick={(e) => {
                    e.stopPropagation()
                    moveLayer(board, row.id, 1)
                  }}
                >
                  ▼
                </button>
              </span>
            </li>
          )
        })}
      </ul>

      <footer className="layer-panel__foot">
        <button
          type="button"
          className="btn-layer-add chrome-btn"
          title="Add a layer"
          onClick={() => addLayer(board)}
        >
          + Layer
        </button>
        <button
          type="button"
          className="btn-layer-duplicate chrome-btn"
          title="Duplicate the active layer (settings only, not its stones)"
          disabled={activeRow === undefined}
          onClick={() => duplicateLayer(board, activeLayerId)}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="btn-layer-delete chrome-btn chrome-btn--danger"
          title="Delete the active layer and its stones"
          disabled={rows.length <= 1}
          onClick={() => deleteLayer(board, activeLayerId)}
        >
          Delete
        </button>
      </footer>
    </section>
  )
}
