import { describe, expect, it } from 'vitest'
import { frac } from '../core/frac'
import { pos } from '../core/pos'
import { BoardStore } from '../state/boardStore'
import { createEmptyProject } from '../io/project'
import { BoardInteraction, KIT_MAX_DUR, placementDuration } from './interaction'
import type { InteractionDeps } from './interaction'
import { pitchToCenterY, quartersToX } from './viewport'

/**
 * Headless coverage for the two rules Task 9 moved into the gesture layer: the kit
 * duration cap (design §3.5) and the redefined quick-grid keys (§7.2).
 */

describe('placementDuration (design §3.5)', () => {
  it('is the slot duration on a pitched layer', () => {
    expect(placementDuration({ start: pos(0), dur: frac(2) }, false)).toEqual(frac(2))
  })

  it('caps kit layers at a 16th, however coarse the grid', () => {
    expect(placementDuration({ start: pos(0), dur: frac(4) }, true)).toEqual(KIT_MAX_DUR)
    expect(placementDuration({ start: pos(0), dur: frac(1, 12) }, true)).toEqual(frac(1, 12))
  })
})

function setup(): { board: BoardStore; interaction: BoardInteraction } {
  const board = new BoardStore(createEmptyProject(), { width: 1200, height: 700 })
  const deps: InteractionDeps = {
    board,
    size: () => ({ width: 1200, height: 700 }),
    audition: () => {},
    onSelect: () => {},
    allowsPitch: () => true,
    isKit: () => false,
  }
  return { board, interaction: new BoardInteraction(deps) }
}

/** Park the hover on `quarters`, the way a pointer move would. */
function hoverAt(board: BoardStore, interaction: BoardInteraction, quarters: number): void {
  const vp = board.getViewport()
  interaction.pointerMove(
    {} as PointerEvent,
    quartersToX(vp, quarters),
    pitchToCenterY(vp, 60),
  )
}

describe('quickGrid (§7.2)', () => {
  it('sets the hovered column to 1/n quarters', () => {
    const { board, interaction } = setup()
    const id = board.activeLayer().id
    hoverAt(board, interaction, 2.2)

    expect(interaction.quickGrid(3, false)).toBe(true)
    expect(board.gridFor(id)).toEqual([
      { start: pos(2), value: frac(1, 3) },
      { start: pos(3), value: frac(1) },
    ])
  })

  it('reaches 11–16 with shift, and 10 with `0`', () => {
    const { board, interaction } = setup()
    const id = board.activeLayer().id
    hoverAt(board, interaction, 0.2)

    expect(interaction.quickGrid(3, true)).toBe(true)
    expect(board.gridFor(id)[0]).toEqual({ start: pos(0), value: frac(1, 13) })

    expect(interaction.quickGrid(0, false)).toBe(true)
    expect(board.gridFor(id)[0]).toEqual({ start: pos(0), value: frac(1, 10) })
  })

  it('is one undoable command per keystroke (§7.3)', () => {
    const { board, interaction } = setup()
    const id = board.activeLayer().id
    hoverAt(board, interaction, 5.2)

    interaction.quickGrid(4, false)
    expect(board.gridFor(id)).toHaveLength(2)
    board.undo()
    expect(board.gridFor(id)).toEqual([])
  })

  it('does nothing without a hovered slot, or out of the 1–16 range', () => {
    const { board, interaction } = setup()
    expect(interaction.quickGrid(4, false)).toBe(false)
    hoverAt(board, interaction, 1.2)
    expect(interaction.quickGrid(9, true)).toBe(false)
    expect(board.gridFor(board.activeLayer().id)).toEqual([])
  })
})
