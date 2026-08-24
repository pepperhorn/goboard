import { useEffect, useRef } from 'react'
import type { Subdiv } from '../core/types'
import type { BoardStore } from '../state/boardStore'

/**
 * The subdivision editor. See go-spec.md §7.2 (ruler right-click / long-press).
 *
 * Two steps, as specified: pick the column's split 1–16, then optionally pick a slot
 * and give it a nested split 2–16. Depth stops at two by construction (§3.2).
 */

export type SubdivMenuProps = {
  readonly board: BoardStore
  readonly col: number
  readonly x: number
  readonly y: number
  readonly onClose: () => void
}

const SPLITS = Array.from({ length: 16 }, (_, i) => i + 1)

export function SubdivMenu({ board, col, x, y, onClose }: SubdivMenuProps): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const layer = board.activeLayer()
  const current: Subdiv | undefined = board.subdivFor(layer.id, col)
  const split = current?.split ?? 1

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

  const setSplit = (s: number) => {
    board.setSubdiv(layer.id, col, s === 1 ? undefined : { split: s })
  }

  const setChild = (index: number, s: number) => {
    if (!current || current.split === 1) return
    const children = Array.from({ length: current.split }, (_, i) => current.children?.[i] ?? null)
    children[index] = s === 1 ? null : { split: s }
    board.setSubdiv(layer.id, col, { split: current.split, children })
  }

  return (
    <div className="subdiv-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="subdiv-menu__title">
        Column {col} · {layer.name}
      </div>

      <div className="subdiv-menu__label">Split</div>
      <div className="subdiv-menu__grid">
        {SPLITS.map((s) => (
          <button
            key={s}
            type="button"
            className={`subdiv-chip ${s === split ? 'subdiv-chip--on' : ''}`}
            onClick={() => setSplit(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {split > 1 && (
        <>
          <div className="subdiv-menu__label">Nest inside slot</div>
          <div className="subdiv-menu__slots">
            {Array.from({ length: split }, (_, i) => {
              const child = current?.children?.[i] ?? null
              return (
                <div className="subdiv-slot" key={i}>
                  <span className="subdiv-slot__index">{i + 1}</span>
                  <select
                    className="subdiv-slot__select"
                    value={child?.split ?? 1}
                    onChange={(e) => setChild(i, Number(e.target.value))}
                  >
                    {SPLITS.map((s) => (
                      <option key={s} value={s}>
                        {s === 1 ? '—' : s}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="subdiv-menu__note">
        Changing a subdivision re-quantizes nothing — existing stones keep their exact
        positions and show a muted ring if they fall off the new grid.
      </div>
    </div>
  )
}
