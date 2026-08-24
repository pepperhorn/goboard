import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../core/types'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import type { AutosaveSnapshot, AutosaveStore } from './autosave'
import { DEFAULT_AUTOSAVE_DELAY_MS, createAutosave, restoreAutosave } from './autosave'
import { createEmptyProject, projectToBlobString } from './project'

// --- a store that records every write and can be made to fail or hang ------------

type FakeStore = AutosaveStore & {
  readonly writes: AutosaveSnapshot[]
  slot: AutosaveSnapshot | null
  failNext: boolean
  /** When set, `write` blocks on this until it is resolved. */
  gate: { promise: Promise<void>; release: () => void } | null
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    writes: [],
    slot: null,
    failNext: false,
    gate: null,
    async read() {
      return store.slot
    },
    async write(snapshot) {
      if (store.gate) await store.gate.promise
      if (store.failNext) {
        store.failNext = false
        throw new Error('quota exceeded')
      }
      store.writes.push(snapshot)
      store.slot = snapshot
    },
    async clear() {
      store.slot = null
    },
  }
  return store
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const withNote = (p: Project, col: number): Project => ({
  ...p,
  notes: [
    ...p.notes,
    { id: `n${col}`, layerId: p.activeLayerId, pos: pos(col), dur: frac(1), pitch: 60 },
  ],
})

/** Let queued microtasks (the write chain) settle. */
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('createAutosave (§10)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes once after the quiet period, not once per edit', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store, now: () => 5 })
    const p = createEmptyProject()

    auto.schedule(p)
    auto.schedule(withNote(p, 0))
    auto.schedule(withNote(p, 1))
    expect(store.writes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]!.data).toBe(projectToBlobString(withNote(p, 1)))
    expect(store.writes[0]!.savedAt).toBe(5)
    expect(auto.lastSavedAt).toBe(5)
  })

  it('reports pending between the edit and the write', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })

    expect(auto.pending).toBe(false)
    auto.schedule(createEmptyProject())
    expect(auto.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(auto.pending).toBe(false)
  })

  it('skips the write when the serialized project is unchanged', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })
    const p = createEmptyProject()

    auto.schedule(withNote(p, 0))
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(1)

    // An edit and its exact undo: same bytes, so nothing to store.
    auto.schedule(withNote(p, 0))
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(1)

    auto.schedule(withNote(p, 1))
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(2)
  })

  it('flush writes immediately and cancels the pending timer', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })

    auto.schedule(createEmptyProject())
    await auto.flush()
    expect(store.writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(1)
  })

  it('flush is a no-op when nothing changed', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })
    await auto.flush()
    expect(store.writes).toHaveLength(0)
  })

  it('keeps overlapping writes in order', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })
    const p = createEmptyProject()
    const g = gate()
    store.gate = g

    auto.schedule(withNote(p, 0))
    const first = auto.flush()
    auto.schedule(withNote(p, 1))
    const second = auto.flush()

    store.gate = null
    g.release()
    await first
    await second

    expect(store.writes.map((w) => w.data)).toEqual([
      projectToBlobString(withNote(p, 0)),
      projectToBlobString(withNote(p, 1)),
    ])
    expect(store.slot!.data).toBe(projectToBlobString(withNote(p, 1)))
  })

  it('reports a failed write and retries the same bytes next time', async () => {
    const store = fakeStore()
    const errors: unknown[] = []
    const auto = createAutosave({ store, onError: (e) => errors.push(e) })
    const p = withNote(createEmptyProject(), 0)

    store.failNext = true
    auto.schedule(p)
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(errors).toHaveLength(1)
    expect(store.writes).toHaveLength(0)
    expect(auto.lastSavedAt).toBeNull()

    // The same project again: because nothing was recorded as written, it retries.
    auto.schedule(p)
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(1)
  })

  it('dispose cancels the pending write', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })

    auto.schedule(createEmptyProject())
    auto.dispose()
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(0)

    auto.schedule(createEmptyProject())
    expect(auto.pending).toBe(false)
  })

  it('clear empties the slot and lets identical bytes be written again', async () => {
    const store = fakeStore()
    const auto = createAutosave({ store })
    const p = withNote(createEmptyProject(), 0)

    auto.schedule(p)
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    await auto.clear()
    expect(store.slot).toBeNull()

    auto.schedule(p)
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS)
    expect(store.writes).toHaveLength(2)
    await settle()
  })
})

describe('restoreAutosave', () => {
  it('returns null when the slot is empty', async () => {
    expect(await restoreAutosave(fakeStore())).toBeNull()
  })

  it('round-trips a saved project', async () => {
    const store = fakeStore()
    const p = withNote(createEmptyProject(), 3)
    store.slot = { name: p.name, savedAt: 1, data: projectToBlobString(p) }

    const restored = await restoreAutosave(store)
    expect(restored).not.toBeNull()
    expect(projectToBlobString(restored!.project)).toBe(projectToBlobString(p))
    expect(restored!.snapshot.savedAt).toBe(1)
  })

  it('reports corruption instead of throwing at startup', async () => {
    const store = fakeStore()
    store.slot = { name: 'x', savedAt: 1, data: '{"version":1,' }
    const errors: unknown[] = []

    expect(await restoreAutosave(store, (e) => errors.push(e))).toBeNull()
    expect(errors).toHaveLength(1)
  })
})
