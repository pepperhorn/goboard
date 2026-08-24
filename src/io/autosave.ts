import type { Project } from '../core/types'
import { projectFromString, projectToBlobString } from './project'

/**
 * Debounced autosave to IndexedDB. See go-spec.md §10.
 *
 * Three decisions carry the module:
 *
 * 1. **Serialize on the timer, not on the edit.** `schedule()` is called from every
 *    committed gesture — including the ones a drag fires at pointer rate — so it does
 *    nothing but remember the project and restart the timer. The `JSON.stringify` of a
 *    few thousand notes happens once per quiet period instead of once per frame.
 * 2. **Diff the serialized bytes, and skip the write when they match.** `project.ts`
 *    guarantees deterministic output (sorted `Map` entries, rebuilt key order), which is
 *    what makes the comparison meaningful: dragging a note away and back writes nothing.
 * 3. **One write at a time.** IndexedDB writes are async and can outlive the next
 *    timer, so writes are chained through a single promise. Without it, two overlapping
 *    puts can land out of order and leave the older snapshot as the stored one.
 *
 * The store is an interface rather than a hardcoded `idb` call so the timing logic is
 * testable in Node, where there is no IndexedDB.
 */

export type AutosaveSnapshot = {
  /** Project name at save time, so a restore prompt can name what it found. */
  readonly name: string
  /** `Date.now()` at save time. */
  readonly savedAt: number
  /** `.go.json` text — the same bytes a manual export would produce. */
  readonly data: string
}

export type AutosaveStore = {
  read(): Promise<AutosaveSnapshot | null>
  write(snapshot: AutosaveSnapshot): Promise<void>
  clear(): Promise<void>
}

export type AutosaveOptions = {
  readonly store: AutosaveStore
  /** Quiet period before a write. Default 1000 ms. */
  readonly delayMs?: number
  /** Injection seams for tests. */
  readonly now?: () => number
  readonly onSaved?: (snapshot: AutosaveSnapshot) => void
  /** Called instead of throwing: a failed autosave must never break an edit. */
  readonly onError?: (error: unknown) => void
}

export type Autosave = {
  /** Note that the project changed. Cheap; safe to call on every commit. */
  schedule(project: Project): void
  /** Write now if anything is pending, and resolve when the write has landed. */
  flush(): Promise<void>
  /** Forget the stored snapshot (after an explicit "new project"). */
  clear(): Promise<void>
  /** Cancel the pending timer. In-flight writes are left to finish. */
  dispose(): void
  readonly lastSavedAt: number | null
  /** True while an edit is waiting for its quiet period. */
  readonly pending: boolean
}

export const DEFAULT_AUTOSAVE_DELAY_MS = 1000

export function createAutosave(options: AutosaveOptions): Autosave {
  const { store, delayMs = DEFAULT_AUTOSAVE_DELAY_MS, now = () => Date.now(), onSaved, onError } =
    options

  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty: Project | null = null
  let lastWritten: string | null = null
  let lastSavedAt: number | null = null
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  const writeNow = (): Promise<void> => {
    const project = dirty
    dirty = null
    if (project === null) return queue

    // Chained, not fired: see (3) above.
    queue = queue.then(async () => {
      const data = projectToBlobString(project)
      if (data === lastWritten) return
      const snapshot: AutosaveSnapshot = { name: project.name, savedAt: now(), data }
      await store.write(snapshot)
      lastWritten = data
      lastSavedAt = snapshot.savedAt
      onSaved?.(snapshot)
    })
    queue = queue.catch((err: unknown) => {
      // Swallow so the chain survives; a failed write leaves `lastWritten` alone, so
      // the next quiet period retries the same bytes.
      onError?.(err)
    })
    return queue
  }

  return {
    schedule(project: Project): void {
      if (disposed) return
      dirty = project
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void writeNow()
      }, delayMs)
    },

    flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      return writeNow()
    },

    async clear(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      dirty = null
      lastWritten = null
      lastSavedAt = null
      queue = queue.then(() => store.clear()).catch((err: unknown) => onError?.(err))
      return queue
    },

    dispose(): void {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      dirty = null
    },

    get lastSavedAt(): number | null {
      return lastSavedAt
    },

    get pending(): boolean {
      return dirty !== null || timer !== null
    },
  }
}

/**
 * Parse a snapshot back into a project, or `null` when there is nothing to restore.
 *
 * A corrupt snapshot resolves to `null` rather than throwing: autosave is a safety net,
 * and a net that refuses to let the app start is worse than no net. `onError` sees the
 * reason so the shell can say "couldn't restore" instead of pretending nothing existed.
 */
export async function restoreAutosave(
  store: AutosaveStore,
  onError?: (error: unknown) => void,
): Promise<{ project: Project; snapshot: AutosaveSnapshot } | null> {
  try {
    const snapshot = await store.read()
    if (snapshot === null) return null
    return { project: projectFromString(snapshot.data), snapshot }
  } catch (err) {
    onError?.(err)
    return null
  }
}

// ---------------------------------------------------------------------------
// IndexedDB backing
// ---------------------------------------------------------------------------

export const AUTOSAVE_DB_NAME = 'go-board'
export const AUTOSAVE_STORE_NAME = 'autosave'
/** v1 keeps exactly one slot; a project list is v2's problem. */
export const AUTOSAVE_KEY = 'current'

/**
 * The real store. Lives behind a lazy `openDB` so importing this module has no side
 * effects — the tests, and any Node context, never touch IndexedDB.
 */
export function createIdbStore(dbName: string = AUTOSAVE_DB_NAME): AutosaveStore {
  let dbPromise: Promise<import('idb').IDBPDatabase> | null = null

  const db = async () => {
    if (dbPromise === null) {
      const { openDB } = await import('idb')
      dbPromise = openDB(dbName, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains(AUTOSAVE_STORE_NAME)) {
            database.createObjectStore(AUTOSAVE_STORE_NAME)
          }
        },
      })
    }
    return dbPromise
  }

  return {
    async read(): Promise<AutosaveSnapshot | null> {
      const value = await (await db()).get(AUTOSAVE_STORE_NAME, AUTOSAVE_KEY)
      return isSnapshot(value) ? value : null
    },
    async write(snapshot: AutosaveSnapshot): Promise<void> {
      await (await db()).put(AUTOSAVE_STORE_NAME, snapshot, AUTOSAVE_KEY)
    },
    async clear(): Promise<void> {
      await (await db()).delete(AUTOSAVE_STORE_NAME, AUTOSAVE_KEY)
    },
  }
}

/** Anything can be in the object store — a build from another version, a hand-edit. */
function isSnapshot(value: unknown): value is AutosaveSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.data === 'string' && typeof v.name === 'string' && typeof v.savedAt === 'number'
}
