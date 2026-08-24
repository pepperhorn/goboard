import { describe, expect, it, vi } from 'vitest'
import { CommandStack, composite, setCommand } from './command'
import type { Command } from './command'

/** A tiny mutable document, standing in for the note store. */
function makeDoc() {
  const values: number[] = []
  return {
    values,
    push: (v: number): Command => ({
      label: `push ${v}`,
      do: () => void values.push(v),
      undo: () => void values.pop(),
    }),
    setAt: (i: number, v: number): Command =>
      setCommand(`set ${i}`, () => values[i]!, (x) => void (values[i] = x), v),
  }
}

describe('execute / undo / redo', () => {
  it('applies, reverses, and reapplies', () => {
    const doc = makeDoc()
    const stack = new CommandStack()
    stack.execute(doc.push(1))
    stack.execute(doc.push(2))
    expect(doc.values).toEqual([1, 2])
    expect(stack.undo()).toBe(true)
    expect(doc.values).toEqual([1])
    expect(stack.redo()).toBe(true)
    expect(doc.values).toEqual([1, 2])
  })

  it('reports availability and labels', () => {
    const doc = makeDoc()
    const stack = new CommandStack()
    expect(stack.canUndo).toBe(false)
    expect(stack.undoLabel).toBeUndefined()
    stack.execute(doc.push(7))
    expect(stack.canUndo).toBe(true)
    expect(stack.canRedo).toBe(false)
    expect(stack.undoLabel).toBe('push 7')
    stack.undo()
    expect(stack.redoLabel).toBe('push 7')
  })

  it('returns false at the ends rather than throwing', () => {
    const stack = new CommandStack()
    expect(stack.undo()).toBe(false)
    expect(stack.redo()).toBe(false)
  })

  it('discards the redo branch on a new command', () => {
    const doc = makeDoc()
    const stack = new CommandStack()
    stack.execute(doc.push(1))
    stack.undo()
    stack.execute(doc.push(9))
    expect(stack.canRedo).toBe(false)
    expect(doc.values).toEqual([9])
  })

  it('caps the stack and drops the oldest entries', () => {
    const doc = makeDoc()
    const stack = new CommandStack({ limit: 3 })
    for (let i = 0; i < 5; i++) stack.execute(doc.push(i))
    expect(stack.depth).toBe(3)
    while (stack.undo());
    expect(doc.values).toEqual([0, 1])
  })

  it('notifies onCommit for every commit, undo and redo', () => {
    const doc = makeDoc()
    const onCommit = vi.fn()
    const stack = new CommandStack({ onCommit })
    stack.execute(doc.push(1))
    stack.undo()
    stack.redo()
    expect(onCommit).toHaveBeenCalledTimes(3)
  })
})

describe('batch', () => {
  it('folds a gesture into one stack entry', () => {
    // The §7.3 rule: Ctrl+Z must reverse a whole drag, not one slot of it.
    const doc = makeDoc()
    const stack = new CommandStack()
    stack.batch('drag note', () => {
      for (let i = 0; i < 8; i++) stack.execute(doc.push(i))
    })
    expect(doc.values).toHaveLength(8)
    expect(stack.depth).toBe(1)
    expect(stack.undoLabel).toBe('drag note')
    stack.undo()
    expect(doc.values).toEqual([])
  })

  it('commits once, not once per member', () => {
    const doc = makeDoc()
    const onCommit = vi.fn()
    const stack = new CommandStack({ onCommit })
    stack.batch('drag', () => {
      stack.execute(doc.push(1))
      stack.execute(doc.push(2))
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('nests, committing only at the outermost level', () => {
    const doc = makeDoc()
    const stack = new CommandStack()
    stack.batch('outer', () => {
      stack.execute(doc.push(1))
      stack.batch('inner', () => {
        stack.execute(doc.push(2))
      })
    })
    expect(stack.depth).toBe(1)
    expect(stack.undoLabel).toBe('outer')
  })

  it('pushes nothing for an empty batch', () => {
    const stack = new CommandStack()
    stack.batch('nothing', () => {})
    expect(stack.depth).toBe(0)
  })

  it('rolls back a throwing batch, leaving no partial gesture', () => {
    const doc = makeDoc()
    const stack = new CommandStack()
    expect(() =>
      stack.batch('drag', () => {
        stack.execute(doc.push(1))
        stack.execute(doc.push(2))
        throw new Error('pointer lost')
      }),
    ).toThrow('pointer lost')
    expect(doc.values).toEqual([])
    expect(stack.depth).toBe(0)
  })

  it('refuses undo and redo while a batch is open', () => {
    const stack = new CommandStack()
    expect(() => stack.batch('drag', () => stack.undo())).toThrow(/inside a batch/)
  })
})

describe('setCommand', () => {
  it('captures the prior value explicitly', () => {
    // A closure over "the object" is not an inverse when the store mutates in place.
    const doc = makeDoc()
    const stack = new CommandStack()
    stack.execute(doc.push(5))
    stack.execute(doc.setAt(0, 42))
    expect(doc.values).toEqual([42])
    stack.undo()
    expect(doc.values).toEqual([5])
  })
})

describe('composite', () => {
  it('undoes members in reverse order', () => {
    const order: string[] = []
    const mk = (name: string): Command => ({
      label: name,
      do: () => void order.push(`do ${name}`),
      undo: () => void order.push(`undo ${name}`),
    })
    const c = composite('both', [mk('a'), mk('b')])
    c.do()
    c.undo()
    expect(order).toEqual(['do a', 'do b', 'undo b', 'undo a'])
  })
})

describe('property: any command sequence plus full undo restores the initial state', () => {
  it('holds over 200 randomized runs', () => {
    // The §12 property test. This catches nearly every undo bug, including
    // asymmetric inverses and stale captured values.
    let seed = 0x5eed
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }

    for (let run = 0; run < 200; run++) {
      const doc = makeDoc()
      const initial = [3, 1, 4, 1, 5]
      doc.values.push(...initial)
      const stack = new CommandStack({ limit: 1000 })

      const ops = 1 + Math.floor(rnd() * 30)
      for (let i = 0; i < ops; i++) {
        const roll = rnd()
        if (roll < 0.4) {
          stack.execute(doc.push(Math.floor(rnd() * 100)))
        } else if (roll < 0.7 && doc.values.length > 0) {
          const idx = Math.floor(rnd() * doc.values.length)
          stack.execute(doc.setAt(idx, Math.floor(rnd() * 100)))
        } else if (roll < 0.85) {
          stack.batch(`batch ${i}`, () => {
            const n = 1 + Math.floor(rnd() * 4)
            for (let k = 0; k < n; k++) stack.execute(doc.push(Math.floor(rnd() * 100)))
          })
        } else {
          stack.undo()
        }
      }

      while (stack.undo());
      expect(doc.values).toEqual(initial)

      // And redoing everything back must reach the same state undo left behind.
      const afterUndo = [...doc.values]
      while (stack.redo());
      while (stack.undo());
      expect(doc.values).toEqual(afterUndo)
    }
  })
})
