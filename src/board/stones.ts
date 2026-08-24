import type { Layer, LayerId, Note, Subdiv } from '../core/types'
import { toNumber } from '../core/frac'
import { eq as fracEq } from '../core/frac'
import { slotAt } from '../core/subdiv'
import type { NoteIndex } from '../core/noteIndex'
import { StoneAtlas, drawStone } from './atlas'
import { noteRect } from './hitTest'
import { isWhiteKey } from './theme'
import { pitchToCenterY, quartersToWidth, visibleCols } from './viewport'
import type { Size, Viewport } from './viewport'

/**
 * The stone pass. See go-spec.md §5.2 pass 3.
 *
 * Geometry comes from `hitTest.noteRect` — the same function the pointer uses. If
 * these two ever computed bounds separately they would drift, and clicks would miss
 * stones by a pixel at some zoom levels.
 */

export type StoneContext = {
  readonly index: NoteIndex
  /** Visible layers in draw order, active last (§5.2). */
  readonly layers: readonly Layer[]
  readonly activeLayerId: LayerId
  readonly subdivFor: (layerId: LayerId, col: number) => Subdiv | undefined
  /** Kit layers draw all-black — key color is meaningless for drums (§9.3). */
  readonly isKit: (layerId: LayerId) => boolean
  readonly maxDurQuarters: number
}

/** Drawn width of the slot a note sits in, which sets its stone radius. */
export function slotWidthFor(vp: Viewport, sd: Subdiv | undefined, note: Note): number {
  const slot = slotAt(sd, note.pos.frac)
  return slot ? quartersToWidth(vp, toNumber(slot.dur)) : vp.pxPerQuarter
}

/**
 * A note is off-grid when its position is not a slot start of its layer's current
 * subdivision — legal by design, since changing a subdivision re-quantizes nothing
 * (§7). It draws with a muted ring to flag that.
 */
export function isOffGrid(sd: Subdiv | undefined, note: Note): boolean {
  const slot = slotAt(sd, note.pos.frac)
  return !slot || !fracEq(slot.start, note.pos.frac)
}

/** Mix a layer color toward the board, for the off-grid flag. */
export function mutedColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const v = parseInt(m[1]!, 16)
  const mix = (c: number) => Math.round(c * 0.45 + 0x9a * 0.55)
  const r = mix((v >> 16) & 255)
  const g = mix((v >> 8) & 255)
  const b = mix(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

export function drawStones(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  atlas: StoneAtlas,
  scene: StoneContext,
): number {
  // Widen the cull by the longest duration, not by one column: a note whose onset
  // is left of the viewport can still have a lozenge inside it (§4.1, §5.3).
  const margin = Math.ceil(scene.maxDurQuarters)
  const { start, end } = visibleCols(vp, size, margin)
  let drawn = 0

  for (const layer of scene.layers) {
    const active = layer.id === scene.activeLayerId
    const kit = scene.isKit(layer.id)
    // One globalAlpha assignment per layer, not per stone (§5.3).
    ctx.globalAlpha = active ? 1 : 0.45

    for (const note of scene.index.queryRange(layer.id, start, end)) {
      const sd = scene.subdivFor(layer.id, note.pos.col)
      const slotW = slotWidthFor(vp, sd, note)
      const rect = noteRect(vp, note, slotW)
      if (rect.x > size.width || rect.x + rect.width < 0) continue

      const radius = rect.height / 2
      const color = isOffGrid(sd, note) ? mutedColor(layer.color) : layer.color
      drawStone(
        ctx,
        atlas,
        { white: kit ? false : isWhiteKey(note.pitch), color, radius, active },
        rect.x + radius,
        pitchToCenterY(vp, note.pitch),
        rect.width,
      )
      drawn++
    }
  }

  ctx.globalAlpha = 1
  return drawn
}
