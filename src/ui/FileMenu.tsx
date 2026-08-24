import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Project } from '../core/types'
import type { BoardStore } from '../state/boardStore'
import { uiSet, useUiStore } from '../state/uiStore'
import { PROJECT_FILE_EXT, createEmptyProject, projectFromString, projectToBlobString } from '../io/project'
import { MAX_PPQ, chooseTicksPerQuarter, exportMidi, midiFileName } from '../io/midi'
import type { InstrumentManifest } from '../audio/manifest'
import './chrome.css'

/**
 * File actions and the autosave indicator (§10).
 *
 * The two exports differ in one way that shows in the UI: `.go.json` is lossless and
 * needs no options, while MIDI has to pick a PPQ, and that choice can cost precision.
 * So the PPQ picker is a popover that states the consequence — "exact" or the lcm it
 * could not reach — rather than a bare number field (§10).
 *
 * Downloads go through an object URL revoked on the next frame. Revoking synchronously
 * races the download in Firefox; leaking it costs the blob until reload.
 */

export type FileMenuProps = {
  readonly board: BoardStore
  /** Manifests by instrument id — the MIDI exporter needs them for programs and kits. */
  readonly instruments: ReadonlyMap<string, InstrumentManifest>
  /** Called after the document is replaced, so the shell can reset autosave and audio. */
  readonly onProjectReplaced?: (project: Project, source: 'new' | 'open') => void
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

/** "Saved 14:03" — a time, not a countdown; the bar must not tick every second. */
function formatSavedAt(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function FileMenu({ board, instruments, onProjectReplaced }: FileMenuProps): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null)
  const [midiOpen, setMidiOpen] = useState(false)

  const savedAt = useUiStore((s) => s.savedAt)
  const saving = useUiStore((s) => s.saving)
  const status = useUiStore((s) => s.status)

  const replace = (project: Project, source: 'new' | 'open'): void => {
    board.load(project)
    uiSet({ selectedNoteId: null, activeLayerId: project.activeLayerId, status: null })
    onProjectReplaced?.(project, source)
  }

  const onNew = (): void => {
    // The board is boundless and undo is unbounded, so "New" is the only destructive
    // action in the app — and the only one that asks.
    if (board.getProject().notes.length > 0 && !window.confirm('Discard the current project?')) {
      return
    }
    replace(createEmptyProject(), 'new')
  }

  const onOpenFile = async (file: File): Promise<void> => {
    try {
      replace(projectFromString(await file.text()), 'open')
      uiSet({ status: `Opened ${file.name}` })
    } catch (err) {
      // `deserializeProject` names the failing path (`notes[2].pos.frac`); showing it
      // verbatim is more useful than "invalid file".
      uiSet({ status: `Could not open ${file.name}: ${String(err)}` })
    }
  }

  const onSave = (): void => {
    const project = board.getProject()
    const name = (project.name.trim() || 'Untitled').replace(/[/\\:*?"<>|]/g, '-')
    download(
      new Blob([projectToBlobString(project)], { type: 'application/json' }),
      `${name}${PROJECT_FILE_EXT}`,
    )
    uiSet({ isDirty: false, status: `Exported ${name}${PROJECT_FILE_EXT}` })
  }

  return (
    <section className="file-menu chrome-bar" aria-label="File">
      <button type="button" className="btn-new chrome-btn" onClick={onNew} title="Start an empty project">
        New
      </button>

      <button
        type="button"
        className="btn-open chrome-btn"
        onClick={() => fileInput.current?.click()}
        title={`Open a ${PROJECT_FILE_EXT} file`}
      >
        Open…
      </button>
      <input
        ref={fileInput}
        className="file-menu__input"
        type="file"
        accept={`${PROJECT_FILE_EXT},application/json`}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Clear first: picking the same file twice must fire `change` both times.
          e.target.value = ''
          if (file) void onOpenFile(file)
        }}
      />

      <button type="button" className="btn-save chrome-btn" onClick={onSave} title={`Download ${PROJECT_FILE_EXT}`}>
        Save
      </button>

      <div className="file-menu__midi">
        <button
          type="button"
          className={`btn-midi chrome-btn ${midiOpen ? 'is-on' : ''}`}
          aria-expanded={midiOpen}
          onClick={() => setMidiOpen((open) => !open)}
          title="Export a type 1 MIDI file (§10)"
        >
          MIDI…
        </button>
        {midiOpen && (
          <MidiDialog board={board} instruments={instruments} onClose={() => setMidiOpen(false)} />
        )}
      </div>

      <span className="file-menu__status chrome-dim" role="status" aria-live="polite">
        {status ??
          (saving ? 'Saving…' : savedAt !== null ? `Saved ${formatSavedAt(savedAt)}` : 'Not saved yet')}
      </span>
    </section>
  )
}

// ---------------------------------------------------------------------------

type MidiDialogProps = {
  readonly board: BoardStore
  readonly instruments: ReadonlyMap<string, InstrumentManifest>
  readonly onClose: () => void
}

/**
 * The PPQ chooser. Opens on the project's own optimum — the largest multiple of the
 * project's lcm that fits in the 16-bit division field — and lets it be overridden,
 * because a receiving DAW may prefer a familiar number to an exact one.
 */
function MidiDialog({ board, instruments, onClose }: MidiDialogProps): JSX.Element {
  const project = board.getProject()
  const choice = chooseTicksPerQuarter(project)
  const [ppq, setPpq] = useState(choice.ppq)
  const [includeMuted, setIncludeMuted] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Capture: the board's own pointer handlers stop propagation.
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const exact = ppq % choice.lcm === 0
  const presets = [...new Set([choice.ppq, 960, 480, 30240])].filter((p) => p >= 1 && p <= MAX_PPQ)

  const doExport = (): void => {
    const bytes = exportMidi(project, { ppq, instruments, includeMuted })
    download(new Blob([bytes as BlobPart], { type: 'audio/midi' }), midiFileName(project))
    uiSet({ status: `Exported ${midiFileName(project)} at ${ppq} PPQ` })
    onClose()
  }

  return (
    <div className="midi-dialog chrome-panel" ref={ref} role="dialog" aria-label="Export MIDI">
      <label className="midi-dialog__row chrome-field">
        <span className="chrome-field__label">PPQ</span>
        <input
          className="midi-dialog__ppq chrome-input chrome-input--num"
          type="number"
          min={1}
          max={MAX_PPQ}
          value={ppq}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10)
            if (Number.isFinite(n)) setPpq(Math.min(MAX_PPQ, Math.max(1, n)))
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>

      <div className="midi-dialog__presets">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className={`midi-dialog__preset chrome-btn ${p === ppq ? 'is-on' : ''}`}
            onClick={() => setPpq(p)}
          >
            {p}
            {p === choice.ppq ? ' ★' : ''}
          </button>
        ))}
      </div>

      <p className={`midi-dialog__note ${exact ? 'is-exact' : 'is-lossy'}`}>
        {exact
          ? 'Exact: every onset and duration lands on a tick.'
          : `Rounds to nearest tick — exact needs a multiple of ${choice.lcm}, above the ${MAX_PPQ} ceiling.`}
      </p>

      <label className="midi-dialog__row midi-dialog__check">
        <input
          type="checkbox"
          checked={includeMuted}
          onChange={(e) => setIncludeMuted(e.target.checked)}
        />
        Include muted layers
      </label>

      <div className="midi-dialog__actions">
        <button type="button" className="chrome-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="chrome-btn chrome-btn--primary" onClick={doExport}>
          Export
        </button>
      </div>
    </div>
  )
}
