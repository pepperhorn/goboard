/**
 * Undo/redo. See go-spec.md §4.2.
 *
 * Every mutation is a `{ do, undo }` pair. Store mutations happen only through
 * commands — that is what makes undo total rather than best-effort.
 *
 * Two rules the rest of the app depends on:
 *  - A drag emits ONE command on pointerup, not one per quantize step (§7.3), so
 *    `batch` exists to fold a gesture's worth of work into a single stack entry.
 *  - `commitVersion` bumps only here, on commit. The canvas watches the separate
 *    `renderVersion`; React watches this one (§2).
 */

export type Command = {
  /** Short human-readable label, shown in the undo tooltip. */
  readonly label: string
  do(): void
  undo(): void
}

export type CommandStackOptions = {
  /** Maximum entries retained; older entries fall off the bottom. */
  readonly limit?: number
  /** Called after any commit, undo, or redo — bumps `commitVersion` (§2). */
  readonly onCommit?: () => void
}

const DEFAULT_LIMIT = 500

export class CommandStack {
  private readonly done: Command[] = []
  private readonly undone: Command[] = []
  private readonly limit: number
  private readonly onCommit: (() => void) | undefined
  /** Depth of the open `batch`, if any. */
  private batching = 0
  private batched: Command[] = []
  private batchLabel = ''
  /** Set while do/undo/redo is running, so commands cannot recursively enqueue. */
  private applying = false

  constructor(options: CommandStackOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT
    this.onCommit = options.onCommit
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  get depth(): number {
    return this.done.length
  }

  /** Label of the command Ctrl+Z would reverse, for the menu/tooltip. */
  get undoLabel(): string | undefined {
    return this.done[this.done.length - 1]?.label
  }

  get redoLabel(): string | undefined {
    return this.undone[this.undone.length - 1]?.label
  }

  /** Run a command and push it. Any redo branch is discarded, as usual. */
  execute(cmd: Command): void {
    if (this.applying) throw new Error('CommandStack: cannot execute during apply')
    this.applying = true
    try {
      cmd.do()
    } finally {
      this.applying = false
    }

    if (this.batching > 0) {
      this.batched.push(cmd)
      return
    }
    this.push(cmd)
    this.onCommit?.()
  }

  /**
   * Fold everything executed inside `fn` into a single stack entry — the
   * one-command-per-drag rule. Nests safely; only the outermost batch commits.
   * If `fn` throws, the work already done is rolled back.
   */
  batch(label: string, fn: () => void): void {
    if (this.batching === 0) {
      this.batched = []
      this.batchLabel = label
    }
    this.batching++
    try {
      fn()
    } catch (err) {
      this.batching--
      if (this.batching === 0) {
        // Unwind in reverse so the caller sees no partial gesture.
        for (let i = this.batched.length - 1; i >= 0; i--) this.batched[i]!.undo()
        this.batched = []
      }
      throw err
    }
    this.batching--
    if (this.batching > 0) return

    const members = this.batched
    this.batched = []
    if (members.length === 0) return
    this.push(members.length === 1 ? members[0]! : composite(this.batchLabel, members))
    this.onCommit?.()
  }

  undo(): boolean {
    if (this.batching > 0) throw new Error('CommandStack: cannot undo inside a batch')
    const cmd = this.done.pop()
    if (!cmd) return false
    this.applying = true
    try {
      cmd.undo()
    } finally {
      this.applying = false
    }
    this.undone.push(cmd)
    this.onCommit?.()
    return true
  }

  redo(): boolean {
    if (this.batching > 0) throw new Error('CommandStack: cannot redo inside a batch')
    const cmd = this.undone.pop()
    if (!cmd) return false
    this.applying = true
    try {
      cmd.do()
    } finally {
      this.applying = false
    }
    this.done.push(cmd)
    this.onCommit?.()
    return true
  }

  /** Drop all history, e.g. on project load. Does not touch the document. */
  clear(): void {
    this.done.length = 0
    this.undone.length = 0
    this.batched = []
    this.batching = 0
  }

  private push(cmd: Command): void {
    this.done.push(cmd)
    this.undone.length = 0
    if (this.done.length > this.limit) this.done.shift()
  }
}

/** Combine commands into one stack entry; undo runs them in reverse. */
export function composite(label: string, members: readonly Command[]): Command {
  const frozen = [...members]
  return {
    label,
    do() {
      for (const c of frozen) c.do()
    },
    undo() {
      for (let i = frozen.length - 1; i >= 0; i--) frozen[i]!.undo()
    },
  }
}

/**
 * Build a command from an explicit before/after pair.
 *
 * The inverse must capture the prior value *explicitly* — the vanilla store mutates
 * note objects in place (§2), so a closure over "the object" is not an inverse.
 */
export function setCommand<T>(
  label: string,
  read: () => T,
  write: (value: T) => void,
  next: T,
): Command {
  const prev = read()
  return {
    label,
    do: () => write(next),
    undo: () => write(prev),
  }
}
