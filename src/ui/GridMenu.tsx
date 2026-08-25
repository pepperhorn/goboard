import { useEffect, useRef, useState } from 'react'
import type { Frac, LayerId, Pos } from '../core/types'
import { frac, toString as fracToString } from '../core/frac'
import { gridValueAt } from '../core/grid'
import { GRID_PRESETS, gridValueLabel, validateGridValue } from '../core/gridValue'
import type { Meter } from '../core/meter'
import { eq as posEq } from '../core/pos'
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

/**
 * Time signatures worth one click. `groups` is the *felt* grouping, so 7/8 and 6/8
 * are not "7 eighths" and "6 eighths" but 2+2+3 and 3+3 — which is the whole reason
 * `Meter` carries a group list instead of a numerator (design §3.7).
 */
type MeterPreset = {
  readonly id: string
  readonly label: string
  readonly beatUnit: Frac
  readonly groups: readonly number[]
}

const METER_PRESETS: readonly MeterPreset[] = [
  { id: '4-4', label: '4/4', beatUnit: frac(1), groups: [1, 1, 1, 1] },
  { id: '3-4', label: '3/4', beatUnit: frac(1), groups: [1, 1, 1] },
  { id: '2-4', label: '2/4', beatUnit: frac(1), groups: [1, 1] },
  { id: '5-4', label: '5/4', beatUnit: frac(1), groups: [3, 2] },
  { id: '6-8', label: '6/8', beatUnit: frac(1, 2), groups: [3, 3] },
  { id: '7-8', label: '7/8', beatUnit: frac(1, 2), groups: [2, 2, 3] },
  { id: '5-8', label: '5/8', beatUnit: frac(1, 2), groups: [2, 3] },
  { id: '9-8', label: '9/8', beatUnit: frac(1, 2), groups: [3, 3, 3] },
  { id: '12-8', label: '12/8', beatUnit: frac(1, 2), groups: [3, 3, 3, 3] },
]

/** `"2+2+3"` as beat groups, or the default one-beat-per-group split. */
function parseGroups(text: string, beats: number): number[] {
  const trimmed = text.trim()
  if (trimmed === '') return Array.from({ length: beats }, () => 1)
  const parts = trimmed.split('+').map((s) => Number(s.trim()))
  let sum = 0
  for (const p of parts) {
    if (!Number.isInteger(p) || p <= 0) {
      throw new RangeError(`grouping: "${trimmed}" must be positive integers joined by +`)
    }
    sum += p
  }
  if (sum !== beats) {
    throw new RangeError(`grouping: "${trimmed}" adds up to ${sum}, not ${beats}`)
  }
  return parts
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
  const [meterBeats, setMeterBeats] = useState('7')
  const [meterUnit, setMeterUnit] = useState('8')
  const [meterGroups, setMeterGroups] = useState('2+2+3')
  const [meterError, setMeterError] = useState<string | null>(null)

  const layer = board.layer(layerId)
  const current: Frac = gridValueAt(board.gridFor(layerId), from)

  // A meter change already sitting exactly here — the one this menu would replace,
  // and the one the Remove button deletes. Index 0 anchors the map and is never
  // removable (`BoardStore.removeMeter`), so its button is not offered.
  const meterMap = board.getMeterMap()
  const meterIndexHere = meterMap.findIndex((m) => posEq(m.pos, from))

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

  /**
   * Meter edits go through `board.setMeter`, which runs `validateMeter` and the §3.1
   * lattice check before touching the project. Anything it rejects — a 4/3 beat unit,
   * a grouping of zero — arrives here as a `RangeError` and is shown, so no gesture in
   * this menu can put a meter into the project that a later `barLinesIn` would choke on.
   */
  const applyMeter = (beatUnit: Frac, groups: readonly number[]) => {
    try {
      board.setMeter({ pos: from, beatUnit, groups })
      onClose()
    } catch (e) {
      setMeterError(e instanceof RangeError ? e.message.replace(/^meter\./, '') : String(e))
    }
  }

  const applyCustomMeter = () => {
    try {
      const beats = Number(meterBeats)
      if (!Number.isInteger(beats) || beats <= 0) {
        throw new RangeError(`beats: must be a positive integer, got "${meterBeats}"`)
      }
      const unit = Number(meterUnit)
      if (!Number.isInteger(unit) || unit <= 0) {
        throw new RangeError(`unit: must be a positive integer, got "${meterUnit}"`)
      }
      // `frac` itself throws for a denominator off the lattice, so this stays inside
      // the try: an unreachable beat unit reports, it does not crash React.
      applyMeter(frac(4, unit), parseGroups(meterGroups, beats))
    } catch (e) {
      setMeterError(e instanceof RangeError ? e.message.replace(/^meter\./, '') : String(e))
    }
  }

  const meterLabel = (m: Meter): string => {
    let beats = 0
    for (const g of m.groups) beats += g
    return `${beats} × ${fracToString(m.beatUnit)} (${m.groups.join('+')})`
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

      <div className="meter-menu">
        <div className="grid-menu__label">
          Meter at this column
          {meterIndexHere >= 0 ? ` — now ${meterLabel(meterMap[meterIndexHere]!)}` : ''}
        </div>
        <div className="meter-menu__presets">
          {METER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="meter-chip"
              onClick={() => applyMeter(preset.beatUnit, preset.groups)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="meter-menu__custom">
          <input
            className="meter-menu__input"
            aria-label="beats"
            value={meterBeats}
            onChange={(e) => {
              setMeterBeats(e.target.value)
              setMeterError(null)
            }}
          />
          <span className="grid-menu__slash">/</span>
          <input
            className="meter-menu__input"
            aria-label="beat unit"
            value={meterUnit}
            onChange={(e) => {
              setMeterUnit(e.target.value)
              setMeterError(null)
            }}
          />
          <input
            className="meter-menu__input meter-menu__input--groups"
            aria-label="grouping"
            value={meterGroups}
            onChange={(e) => {
              setMeterGroups(e.target.value)
              setMeterError(null)
            }}
          />
          <button type="button" className="meter-menu__apply" onClick={applyCustomMeter}>
            Set
          </button>
        </div>
        {meterError !== null && <div className="meter-menu__error">{meterError}</div>}

        {meterIndexHere > 0 && (
          <button
            type="button"
            className="meter-menu__remove"
            onClick={() => {
              board.removeMeter(meterIndexHere)
              onClose()
            }}
          >
            Remove this meter change
          </button>
        )}
      </div>

      <div className="grid-menu__note">
        Changing the grid re-quantizes nothing — existing stones keep their exact
        positions and show a muted ring if they fall off the new grid.
      </div>
    </div>
  )
}
