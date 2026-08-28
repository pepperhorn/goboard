import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LayerId, Note, NoteId } from '../core/types'
import { toQuarters } from '../core/pos'
import { pos } from '../core/pos'
import { createEmptyProject } from '../io/project'
import { createAutosave, createIdbStore, restoreAutosave } from '../io/autosave'
import type { Autosave } from '../io/autosave'
import { createEngine } from '../audio/engine'
import { createScheduler } from '../audio/scheduler'
import type { Scheduler } from '../audio/scheduler'
import { isKit as manifestIsKit, kitLabelFor, loadManifest } from '../audio/manifest'
import type { InstrumentManifest } from '../audio/manifest'
import { BoardStore } from '../state/boardStore'
import { uiSet, useUiStore } from '../state/uiStore'
import { BoardView } from './BoardView'
import { FileMenu } from './FileMenu'
import { Inspector } from './Inspector'
import { LayerPanel } from './LayerPanel'
import { GridMenu } from './GridMenu'
import { Transport } from './Transport'
import { VelocityLane } from './VelocityLane'
import type { LaneApi } from './VelocityLane'
import '../styles.css'

/**
 * The app shell. Owns the singletons — board store, audio engine, scheduler — and
 * the wiring between them; everything else is imperative below this line (§2).
 */

export function App(): React.ReactElement {
  const board = useMemo(
    () => new BoardStore(createEmptyProject(), { width: 1200, height: 700 }),
    [],
  )
  const engine = useMemo(() => createEngine(), [])
  const playheadRef = useRef<number | null>(null)
  const laneRef = useRef<LaneApi | null>(null)
  const schedulerRef = useRef<Scheduler | null>(null)

  const [manifests, setManifests] = useState<ReadonlyMap<string, InstrumentManifest>>(new Map())
  const [menu, setMenu] = useState<{ col: number; x: number; y: number } | null>(null)

  // --- manifests, so the gutter and placement rules know which layers are kits ---

  useEffect(() => {
    let live = true
    // Opening a project (or adding a layer) can introduce an instrument nothing has
    // fetched yet, so this follows the layer set rather than running once at mount.
    // `loadManifest` is a bare fetch, so only ids never seen before are requested —
    // and `seen` is marked before the await, or a burst of commits would stack
    // duplicate requests for the same file.
    const seen = new Map<string, Promise<readonly [string, InstrumentManifest]>>()

    const sync = (): void => {
      const ids = [...new Set(board.getProject().layers.map((l) => l.instrumentId))]
      if (ids.every((id) => seen.has(id))) return
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.set(
          id,
          loadManifest(id)
            .then((m) => [id, m] as const)
            // Drop the failure so a transient network error is retried on the next
            // commit rather than cached for the life of the session.
            .catch((err: unknown) => {
              seen.delete(id)
              throw err
            }),
        )
      }
      Promise.all(ids.map((id) => seen.get(id)!))
        .then((pairs) => {
          if (live) setManifests(new Map(pairs))
        })
        .catch((err: unknown) => {
          uiSet({ status: `Instrument manifests failed to load: ${String(err)}` })
        })
    }

    sync()
    const unsub = board.subscribe(sync)
    return () => {
      live = false
      unsub()
    }
  }, [board])

  const manifestForLayer = useCallback(
    (layerId: LayerId) => {
      const layer = board.layer(layerId)
      return layer ? manifests.get(layer.instrumentId) : undefined
    },
    [board, manifests],
  )

  const isKit = useCallback(
    (layerId: LayerId) => {
      const m = manifestForLayer(layerId)
      return m !== undefined && manifestIsKit(m)
    },
    [manifestForLayer],
  )

  const kitLabel = useCallback(
    (layerId: LayerId, pitch: number) => {
      const m = manifestForLayer(layerId)
      return m ? kitLabelFor(m, pitch) : null
    },
    [manifestForLayer],
  )

  /** Kit layers reject placement on rows with no mapped piece (§9.3). */
  const allowsPitch = useCallback(
    (layerId: LayerId, pitch: number) => !isKit(layerId) || kitLabel(layerId, pitch) !== null,
    [isKit, kitLabel],
  )

  // --- scheduler ---

  useEffect(() => {
    const scheduler = createScheduler({
      now: () => engine.now(),
      voice: engine.sink,
      tempoMap: () => board.getTempoMap(),
      layers: () => board.getProject().layers,
      notes: (layerId) => board.getIndex().notesByLayer.get(layerId) ?? [],
      loop: () => (useUiStore.getState().loopEnabled ? board.getProject().loop : undefined),
    })
    schedulerRef.current = scheduler
    return () => {
      scheduler.dispose()
      schedulerRef.current = null
    }
  }, [board, engine])

  // --- bind layers to instruments and mirror mute into the audio graph ---

  useEffect(() => {
    const sync = () => {
      for (const layer of board.getProject().layers) {
        engine.pool.bindLayer(layer.id, layer.instrumentId)
        engine.pool.setLayerMuted(layer.id, !layer.audible)
      }
    }
    sync()
    return board.subscribe(sync)
  }, [board, engine])

  // --- push derived scalars into the React store on commit (§2) ---

  useEffect(() => {
    let lastCommit = -1
    const push = () => {
      if (board.commitVersion === lastCommit) return
      lastCommit = board.commitVersion
      uiSet({
        commitTick: board.commitVersion,
        canUndo: board.commands.canUndo,
        canRedo: board.commands.canRedo,
        undoLabel: board.commands.undoLabel,
        isDirty: true,
        activeLayerId: board.getProject().activeLayerId,
      })
    }
    push()
    return board.subscribe(push)
  }, [board])

  // --- autosave (§10) ---

  const autosaveStore = useMemo(() => createIdbStore(), [])
  // Created inside the effect, not in a `useMemo`: StrictMode mounts, unmounts and
  // remounts, and a memoized instance survives that cycle — so its own cleanup would
  // dispose it permanently and every later edit would sit at "Saving…" forever.
  const autosaveRef = useRef<Autosave | null>(null)

  useEffect(() => {
    let live = true
    const autosave = createAutosave({
      store: autosaveStore,
      onSaved: (snap) => uiSet({ savedAt: snap.savedAt, saving: false, isDirty: false }),
      onError: (err) => uiSet({ saving: false, status: `Autosave failed: ${String(err)}` }),
    })
    autosaveRef.current = autosave

    // Restore before the first `schedule`, so a fresh empty project cannot overwrite
    // the snapshot it is about to replace.
    const ready = restoreAutosave(autosaveStore, (err) =>
      uiSet({ status: `Could not restore autosave: ${String(err)}` }),
    ).then((restored) => {
      if (!live || !restored) return
      board.load(restored.project)
      uiSet({
        activeLayerId: restored.project.activeLayerId,
        savedAt: restored.snapshot.savedAt,
        status: `Restored your last session (${restored.snapshot.name})`,
      })
    })

    let lastAutosaved = board.commitVersion
    const unsub = board.subscribe(() => {
      // Autosave follows commits only: a drag bumps `renderVersion` every frame.
      if (board.commitVersion === lastAutosaved) return
      lastAutosaved = board.commitVersion
      void ready.then(() => {
        if (!live) return
        uiSet({ saving: true })
        autosave.schedule(board.getProject())
      })
    })

    // A tab can be discarded without ever firing `beforeunload`; `pagehide` is the
    // one event mobile Safari reliably delivers. The write is best-effort either way —
    // IndexedDB is async — which is why the debounce is a second, not a minute.
    const onHide = () => void autosave.flush()
    window.addEventListener('pagehide', onHide)

    return () => {
      live = false
      window.removeEventListener('pagehide', onHide)
      unsub()
      void autosave.flush()
      autosave.dispose()
      if (autosaveRef.current === autosave) autosaveRef.current = null
    }
  }, [board, autosaveStore])

  /** Replaced document: drop the old snapshot rather than diffing against it. */
  const onProjectReplaced = useCallback(() => {
    const autosave = autosaveRef.current
    if (!autosave) return
    void autosave.clear().then(() => {
      uiSet({ savedAt: null, saving: false })
      autosave.schedule(board.getProject())
    })
  }, [board])

  // --- instrument load progress ---

  useEffect(() => {
    return engine.pool.subscribe(() => {
      const p = engine.pool.progress()
      const failed = engine.pool.statuses().find((s) => s.state === 'error')
      uiSet({
        // `progress()` counts bytes, so a pool with nothing queued reads as 1 (done),
        // not 0 (stalled) — the bar only appears while `pending > 0` anyway.
        loadProgress: p.total > 0 ? p.loaded / p.total : 1,
        audio:
          failed ? 'error'
          : p.pending > 0 ? 'loading'
          : engine.isUnlocked() ? 'ready'
          : 'locked',
        audioError: failed ? `Failed to load ${failed.id}` : null,
      })
    })
  }, [engine])

  // --- playhead, read from the audio clock in a rAF (§8.1) ---

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const scheduler = schedulerRef.current
      if (scheduler?.isPlaying) {
        const nudge = useUiStore.getState().latencyNudgeMs / 1000
        playheadRef.current = toQuarters(scheduler.currentPos(engine.now() - nudge))
      } else if (playheadRef.current !== null && !useUiStore.getState().playing) {
        playheadRef.current = null
        board.touch()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [board, engine])

  // --- transport ---

  const enableAudio = useCallback(() => {
    uiSet({ audio: 'loading' })
    engine
      .unlock()
      .then(() => uiSet({ audio: 'ready', audioError: null }))
      .catch((err: unknown) => uiSet({ audio: 'error', audioError: String(err) }))
  }, [engine])

  const play = useCallback(() => {
    const scheduler = schedulerRef.current
    if (!scheduler) return
    if (!engine.isUnlocked()) enableAudio()
    scheduler.play()
    uiSet({ playing: true })
    board.touch()
  }, [board, engine, enableAudio])

  const stop = useCallback(() => {
    schedulerRef.current?.stop()
    uiSet({ playing: false })
    playheadRef.current = null
    board.touch()
  }, [board])

  const toggleTransport = useCallback(() => {
    if (useUiStore.getState().playing) stop()
    else play()
  }, [play, stop])

  const seek = useCallback(
    (quarters: number) => {
      const target = pos(Math.floor(quarters))
      schedulerRef.current?.seek(target)
      playheadRef.current = toQuarters(target)
      board.touch()
    },
    [board],
  )

  // --- audition on placement (§8.2) ---

  const audition = useCallback(
    (layerId: LayerId, pitch: number, note: Note) => {
      if (!useUiStore.getState().auditionEnabled) return
      const layer = board.layer(layerId)
      if (!layer || !layer.audible) return
      const vel = note.vel ?? layer.colVel.get(note.pos.col) ?? layer.defaultVel
      engine.pool.audition(layer.instrumentId, pitch, vel)
    },
    [board, engine],
  )

  const onSelect = useCallback((id: NoteId | null) => {
    uiSet({ selectedNoteId: id })
  }, [])

  const onGridMenu = useCallback((col: number, x: number, y: number) => {
    setMenu({ col, x, y })
  }, [])

  const onLaneCanvas = useCallback((_canvas: HTMLCanvasElement | null, api: LaneApi | null) => {
    laneRef.current = api
  }, [])

  const audio = useUiStore((s) => s.audio)

  return (
    <div className="app-shell">
      <div className="app-transport">
        <FileMenu board={board} instruments={manifests} onProjectReplaced={onProjectReplaced} />
        <Transport board={board} onPlay={play} onStop={stop} onEnableAudio={enableAudio} />
      </div>

      <div className="app-layers">
        <LayerPanel board={board} />
        <Inspector board={board} />
      </div>

      <div className="app-board">
        <BoardView
          board={board}
          allowsPitch={allowsPitch}
          isKit={isKit}
          kitLabel={kitLabel}
          audition={audition}
          onSelect={onSelect}
          onSeek={seek}
          onToggleTransport={toggleTransport}
          playheadRef={playheadRef}
          onGridMenu={onGridMenu}
          laneRef={laneRef}
        />
        {audio === 'locked' && (
          <div className="audio-gate">
            <button className="audio-gate__button" type="button" onClick={enableAudio}>
              Click to enable audio
            </button>
            <span className="audio-gate__hint">
              Browsers only allow sound after a gesture — the board works either way.
            </span>
          </div>
        )}
      </div>

      <div className="app-lane">
        <VelocityLane board={board} onCanvas={onLaneCanvas} />
      </div>

      {menu && (
        <GridMenu
          board={board}
          layerId={board.activeLayer().id}
          from={pos(menu.col)}
          /* Default range: the clicked column to the next. The bar containing the
             click needs the meter map, which is not built yet. */
          to={pos(menu.col + 1)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
