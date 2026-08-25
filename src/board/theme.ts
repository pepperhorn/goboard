/** Board palette. The Go metaphor drives it: a wooden board, stones, faint grain. */

export const theme = {
  boardBg: '#efe9dd',
  /** White-key rows sit slightly lighter, so the board reads as a rotated keyboard (§1). */
  rowWhite: '#f7f4ee',
  rowBlack: '#e6ded0',
  rowActiveTint: 'rgba(255, 255, 255, 0.35)',

  gridLine: 'rgba(90, 74, 52, 0.16)',
  gridLineBar: 'rgba(90, 74, 52, 0.38)',
  gridLineSub: 'rgba(90, 74, 52, 0.10)',
  gridLineSubDeep: 'rgba(90, 74, 52, 0.06)',

  gutterBg: '#e4dccc',
  gutterText: '#6b5a42',
  gutterTextDim: 'rgba(107, 90, 66, 0.45)',
  gutterEdge: 'rgba(90, 74, 52, 0.25)',

  rulerBg: '#e4dccc',
  rulerText: '#6b5a42',
  loopFill: 'rgba(196, 122, 42, 0.18)',
  loopEdge: 'rgba(196, 122, 42, 0.75)',

  /** Meter marker chips in the ruler's top band (§7.2). */
  meterChipBg: 'rgba(122, 75, 134, 0.85)',
  meterChipDragging: '#c2410c',
  meterChipEdge: 'rgba(60, 50, 39, 0.35)',
  meterChipText: '#fdf6ec',

  playhead: '#c2410c',
  hoverGhost: 'rgba(90, 74, 52, 0.22)',

  laneBg: '#ece4d6',
  laneGhost: 'rgba(90, 74, 52, 0.14)',
  laneEdge: 'rgba(90, 74, 52, 0.25)',
} as const

/** Layer colors for the §9.4 starter set, chosen to stay distinct against the board. */
export const LAYER_COLORS = ['#b4562a', '#2f6f5e', '#3b5a99', '#7a4b86', '#8a6d1f', '#a03a5c'] as const

/** Pitch classes that take a white stone and a lighter row (§1). */
const WHITE_KEYS = new Set([0, 2, 4, 5, 7, 9, 11])

export const isWhiteKey = (pitch: number): boolean => WHITE_KEYS.has(((pitch % 12) + 12) % 12)

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** Scientific pitch name. MIDI 48 is C3, matching the board's anchor row (§4). */
export function pitchName(pitch: number): string {
  const pc = ((pitch % 12) + 12) % 12
  return `${NAMES[pc]}${Math.floor(pitch / 12) - 1}`
}
