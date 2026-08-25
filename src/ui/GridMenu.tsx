import { useEffect, useRef, useState } from 'react'
import type { Frac, LayerId, Pos } from '../core/types'
import { toString as fracToString } from '../core/frac'
import { gridValueAt } from '../core/grid'
import { GRID_PRESETS, gridValueLabel, validateGridValue } from '../core/gridValue'
import type { BoardStore } from '../state/boardStore'

/**
 * The grid editor. See go-spec.md §7.2 (ruler right-click / long-press) and design §3.2.
 *
 * One flat list of line spacings, not a two-level split picker: a grid value is a
 * lattice fraction of a quarter note, so a preset chip and a hand-typed `n/d` tuplet
 * are the same operation. The edit applies to `[from, to)` through `setGridRange`, which
 * is a single command however many regions it rewrites (§7.3).
 */

export type GridMenuProps = {
  readonly board: BoardStore
  readonly layerId: LayerId
  readonly from: Pos
  /** `undefined` means "to the end of time"; the caller's default is one column. */
  readonly to: Pos | undefined
  readonly x: number
  readonly y: number
  readonly onClose: () => void
}

/** Where the range ends, for the title — `undefined` reads as open-ended. */
function rangeLabel(from: Pos, to: Pos | undefined): string {
  const start = fracToString(from.frac) === '0' ? `${from.col}` : `${from.col}+${fracToString(from.frac)}`
  if (to === undefined) return `from quarter ${start}`
  const end = fracToString(to.frac) === '0' ? `${to.col}` : `${to.col}+${fracToString(to.frac)}`
  return `quarters ${start}–${end}`
}

export function GridMenu(
  { board, layerId, from, to, x, y, onClose }: GridMenuProps,
): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const [customN, setCustomN] = useState('1')
  const [customD, setCustomD] = useState('5')
  const [error, setError] = useState<string | null>(null)

  const layer = board.layer(layerId)
  const current: Frac = gridValueAt(board.gridFor(layerId), from)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const apply = (value: Frac) => {
    board.setGridRange(layerId, from, to, value)
    onClose()
  }

  /**
   * A typed tuplet goes through the same validator the importer uses, so `1/17` — off
   * the §3.1 lattice — reports the reason in the menu instead of throwing into React.
   */
  const applyCustom = () => {
    const n = Number(customN)
    const d = Number(customD)
    try {
      apply(validateGridValue({ n, d }, 'grid'))
    } catch (e) {
      setError(e instanceof RangeError ? e.message.replace(/^grid: /, '') : String(e))
    }
  }

  return (
    <div className="grid-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="grid-menu__title">
        Grid · {rangeLabel(from, to)} · {layer?.name ?? 'layer'}
      </div>

      <div className="grid-menu__label">Line spacing — now {gridValueLabel(current)}</div>
      <div className="grid-menu__presets">
        {GRID_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={
              `grid-chip ${
                preset.value.n === current.n && preset.value.d === current.d
                  ? 'grid-chip--on'
                  : ''
              }`
            }
            onClick={() => apply(preset.value)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid-menu__label">Custom tuplet (quarters per line)</div>
      <div className="grid-menu__custom">
        <input
          className="grid-menu__input"
          aria-label="numerator"
          value={customN}
          onChange={(e) => {
            setCustomN(e.target.value)
            setError(null)
          }}
        />
        <span className="grid-menu__slash">/</span>
        <input
          className="grid-menu__input"
          aria-label="denominator"
          value={customD}
          onChange={(e) => {
            setCustomD(e.target.value)
            setError(null)
          }}
        />
        <button type="button" className="grid-menu__apply" onClick={applyCustom}>
          Set
        </button>
      </div>
      {error !== null && <div className="grid-menu__error">{error}</div>}

      <div className="grid-menu__note">
        Changing the grid re-quantizes nothing — existing stones keep their exact
        positions and show a muted ring if they fall off the new grid.
      </div>
    </div>
  )
}
