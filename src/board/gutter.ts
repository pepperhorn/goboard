import { isWhiteKey, pitchName, theme } from './theme'
import { pitchToY, visiblePitches } from './viewport'
import type { Size, Viewport } from './viewport'

/**
 * The left gutter. See go-spec.md §5.2 pass 5 and §9.3.
 *
 * Pitched layers get scientific pitch names on C rows; kit layers swap in piece
 * labels at their GM rows, and rows with no mapped piece dim to show they reject
 * placement.
 */

export const GUTTER_WIDTH = 62

/** Piece label for a pitch on a kit layer, or null when the row is unmapped. */
export type LabelFor = (pitch: number) => string | null

export function drawGutter(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: Size,
  labelFor: LabelFor | null,
): void {
  ctx.fillStyle = theme.gutterBg
  ctx.fillRect(0, 0, size.width, size.height)

  const { lo, hi } = visiblePitches(vp, size)
  const rowH = vp.pxPerSemitone
  const showEveryRow = rowH >= 11

  ctx.font = '500 10px Poppins, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'

  for (let p = lo; p <= hi; p++) {
    const y = pitchToY(vp, p) + rowH / 2

    if (labelFor) {
      const label = labelFor(p)
      if (!label) {
        // Unmapped kit rows dim, matching the board's rejection of placement.
        ctx.fillStyle = theme.gutterBg
        ctx.fillRect(0, pitchToY(vp, p), size.width, rowH)
        continue
      }
      ctx.fillStyle = theme.gutterText
      ctx.fillText(label, size.width - 8, y)
      continue
    }

    // Pitched layers: always label C rows, and every row once there is space.
    const isC = p % 12 === 0
    if (!isC && !showEveryRow) continue
    ctx.fillStyle = isC ? theme.gutterText : theme.gutterTextDim
    if (!isC && !isWhiteKey(p)) continue
    ctx.fillText(pitchName(p), size.width - 8, y)
  }

  ctx.strokeStyle = theme.gutterEdge
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(size.width - 0.5, 0)
  ctx.lineTo(size.width - 0.5, size.height)
  ctx.stroke()
}
