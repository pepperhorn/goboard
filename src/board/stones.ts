import type { Layer, LayerId, Note } from '../core/types'
import { toNumber } from '../core/frac'
import type { GridRegion } from '../core/grid'
import { isOnGrid } from '../core/grid'
import type { GridCursor } from '../core/gridCursor'
import { createGridCursor } from '../core/gridCursor'
import { eq as posEq } from '../core/pos'
import type { NoteIndex } from '../core/noteIndex'
import { StoneAtlas, drawStone } from './atlas'
import { noteRect } from './hitTest'
import { isWhiteKey } from './theme'
import { pitchToCenterY, quartersToWidth, xToQuarters } from './viewport'
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
  readonly gridFor: (layerId: LayerId) => readonly GridRegion[]
  /** Kit layers draw all-black — key color is meaningless for drums (§9.3). */
  readonly isKit: (layerId: LayerId) => boolean
  readonly maxDurQuarters: number
}

/** Drawn width of the slot a note sits in, which sets its stone radius. */
export function slotWidthFor(vp: Viewport, cursor: GridCursor, note: Note): number {
  const slot = cursor.slotAt(note.pos)
  return quartersToWidth(vp, toNumber(slot.dur))
}

/**
 * A note is off-grid when its onset is not a slot start of its layer's current grid
 * — legal by design, since editing the grid re-quantizes nothing (§7). It draws with
 * a muted ring to flag that.
 */
export function isOffGrid(regions: readonly GridRegion[], note: Note): boolean {
  return !isOnGrid(regions, note.pos)
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

/**
 * A sub-rectangle of the surface to draw, in CSS pixels. The §5.3 self-blit repaints
 * only the strip a pan exposed, and the cull has to narrow with it — clipping alone
 * would still walk all 5,000 stones and hand every one to the rasterizer.
 */
export type StoneRegion = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function drawStones(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  atlas: StoneAtlas,
  scene: StoneContext,
  region?: StoneRegion,
): number {
  const x0 = region ? region.x : 0
  const x1 = region ? region.x + region.width : size.width
  const y0 = region ? region.y : 0
  const y1 = region ? region.y + region.height : size.height

  // Widen the cull by the longest duration, not by one column: a note whose onset
  // is left of the region can still have a lozenge inside it (§4.1, §5.3).
  const margin = Math.ceil(scene.maxDurQuarters)
  const start = Math.floor(xToQuarters(vp, x0)) - margin
  const end = Math.ceil(xToQuarters(vp, x1))
  let drawn = 0

  for (const layer of scene.layers) {
    const active = layer.id === scene.activeLayerId
    const kit = scene.isKit(layer.id)
    // One globalAlpha assignment per layer, not per stone (§5.3).
    ctx.globalAlpha = active ? 1 : 0.45

    // One cursor per layer per frame (§3.6): notes come out of `queryRange` in
    // ascending `pos` order, so this is a forward walk, never a binary search.
    const cursor = createGridCursor(scene.gridFor(layer.id))

    for (const note of scene.index.queryRange(layer.id, start, end)) {
      const slot = cursor.slotAt(note.pos)
      const slotW = quartersToWidth(vp, toNumber(slot.dur))
      const rect = noteRect(vp, note, slotW)
      if (rect.x > x1 || rect.x + rect.width < x0) continue

      const radius = rect.height / 2
      const cy = pitchToCenterY(vp, note.pitch)
      // Vertical cull: `queryRange` is keyed by column, so without this every note in
      // a visible column is rasterized even when its row is far off screen.
      if (cy + radius < y0 || cy - radius > y1) continue
      // Off-grid iff the note's own onset isn't the slot start the cursor just
      // resolved — reusing that slot rather than calling `isOffGrid` here, which
      // would re-run `regionIndexAt` per note and defeat the cursor (§3.6).
      const offGrid = !posEq(slot.start, note.pos)
      const color = offGrid ? mutedColor(layer.color) : layer.color
      drawStone(
        ctx,
        atlas,
        { white: kit ? false : isWhiteKey(note.pitch), color, radius, active },
        rect.x + radius,
        cy,
        rect.width,
      )
      drawn++
    }
  }

  ctx.globalAlpha = 1
  return drawn
}
