import { create } from 'zustand'
import type { NoteId } from '../core/types'

/**
 * The React store. See go-spec.md §2.
 *
 * Chrome state only — never note data. It holds derived scalars the panels need
 * (`canUndo`, `isDirty`, the inspector's target) which a subscriber pushes here
 * from the vanilla store on `commitVersion` changes, so React re-renders once per
 * gesture rather than once per frame.
 */

export type AudioState = 'locked' | 'loading' | 'ready' | 'error'

export type UiState = {
  /** Bumped from the board store's commitVersion, to refresh derived panels. */
  commitTick: number
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | undefined
  isDirty: boolean

  activeLayerId: string
  selectedNoteId: NoteId | null

  playing: boolean
  bpm: number
  loopEnabled: boolean
  auditionEnabled: boolean

  audio: AudioState
  audioError: string | null
  loadProgress: number

  /** User-tunable playhead nudge in ms, per §8.1 — no formula beats a slider. */
  latencyNudgeMs: number

  showVelocityLane: boolean
  showGhostBars: boolean

  status: string | null

  set: (patch: Partial<UiState>) => void
}

export const useUiStore = create<UiState>((set) => ({
  commitTick: 0,
  canUndo: false,
  canRedo: false,
  undoLabel: undefined,
  isDirty: false,

  activeLayerId: '',
  selectedNoteId: null,

  playing: false,
  bpm: 120,
  loopEnabled: false,
  auditionEnabled: true,

  audio: 'locked',
  audioError: null,
  loadProgress: 0,

  latencyNudgeMs: 0,

  showVelocityLane: true,
  showGhostBars: false,

  status: null,

  set: (patch) => set(patch),
}))

/** Imperative setter for non-React callers (the board store subscriber, the engine). */
export const uiSet = (patch: Partial<UiState>): void => useUiStore.getState().set(patch)
