import type { Size } from './viewport'

/**
 * Canvas coordination. See go-spec.md §5.3 "Canvas coordination".
 *
 * The board, ruler, gutter, overlay and velocity lane are separate canvases but
 * share ONE rAF owner. Three independent loops tear visibly during fast pan, so
 * every surface is drawn inside a single callback in dependency order.
 *
 * Each surface also bakes its own fractional-device-pixel correction: under browser
 * zoom or a fractional flex width, `rect.left * dpr` is fractional and *differs per
 * canvas*, which would put the lane's bars up to a pixel off the board's columns.
 */

export type Surface = {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  size: Size
}

export const deviceRatio = (): number => Math.min(window.devicePixelRatio || 1, 2)

/**
 * Resize the backing store and re-apply the transform.
 *
 * Assigning `width`/`height` clears the surface AND resets the transform, so this
 * must be followed by a full redraw — never a partial one.
 */
export function sizeSurface(surface: Surface, dpr: number): boolean {
  const canvas = surface.canvas
  // Measure the *content* box, not `getBoundingClientRect`'s border box. The ruler
  // carries a 1 px baseline and the gutter a 1 px edge, and a canvas stretches its
  // backing store over the content box only — sizing from the border box scales the
  // ruler by 28/27 and blurs every line in it.
  //
  // The CSS size is never written back. Layout owns it (a stylesheet `100%`, a React
  // inline height), and a write-back is undone by the next render, leaving the backing
  // store a pixel out of step with the box for as long as the app runs.
  const cssW = Math.max(1, canvas.clientWidth)
  const cssH = Math.max(1, canvas.clientHeight)
  const w = Math.max(1, Math.round(cssW * dpr))
  const h = Math.max(1, Math.round(cssH * dpr))

  const changed = canvas.width !== w || canvas.height !== h
  if (changed) {
    canvas.width = w
    canvas.height = h
  }
  surface.size = { width: cssW, height: cssH }

  const rect = canvas.getBoundingClientRect()

  // Correct for a fractional device-pixel origin so surfaces stay aligned.
  const fx = rect.left * dpr - Math.round(rect.left * dpr)
  const fy = rect.top * dpr - Math.round(rect.top * dpr)
  surface.ctx.setTransform(dpr, 0, 0, dpr, -fx, -fy)
  return changed
}

/**
 * `alpha: false` is a real win on the opaque surfaces — the compositor skips a blend
 * per frame — but context attributes are fixed by the FIRST `getContext` call: asking
 * again with different attributes silently returns the original context. So a surface
 * that must composite (the playhead overlay) has to be created transparent *here*, or
 * its `clearRect` paints opaque black over the board beneath it.
 */
export function makeSurface(
  canvas: HTMLCanvasElement,
  options: { readonly alpha?: boolean } = {},
): Surface {
  const ctx = canvas.getContext('2d', { alpha: options.alpha ?? false })
  if (!ctx) throw new Error('canvasHost: 2d context unavailable')
  return { canvas, ctx, size: { width: 1, height: 1 } }
}

export type FrameFn = (dpr: number, forced: boolean) => void

/**
 * The single rAF loop.
 *
 * Redraws only when `isDirty()` reports a change — the dirty-flag rule from §2.
 * A DPR change (window dragged to another monitor, browser zoom) forces a full
 * redraw of every surface, since each one's backing store must be rebuilt.
 */
export class FrameLoop {
  private raf = 0
  private running = false
  private dpr = 1
  private mql: MediaQueryList | null = null
  private forceNext = true

  /**
   * `onFrame` receives the wall-clock cost of each drawn frame — the §5.3 benchmark
   * number. Timing the callback rather than the interval between callbacks is the
   * distinction that matters: the interval is 16.7 ms whether the draw took 2 ms or
   * 15, and it is the draw that has to fit in the budget.
   */
  constructor(
    private readonly isDirty: () => boolean,
    private readonly frame: FrameFn,
    private readonly onFrame?: (ms: number) => void,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.dpr = deviceRatio()
    this.watchDpr()
    const tick = () => {
      if (!this.running) return
      const forced = this.forceNext
      if (forced || this.isDirty()) {
        this.forceNext = false
        if (this.onFrame === undefined) {
          this.frame(this.dpr, forced)
        } else {
          const started = performance.now()
          this.frame(this.dpr, forced)
          this.onFrame(performance.now() - started)
        }
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** Force a full redraw on the next frame — after a resize or DPR change. */
  invalidate(): void {
    this.forceNext = true
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.mql?.removeEventListener('change', this.onDprChange)
    this.mql = null
  }

  private onDprChange = (): void => {
    this.dpr = deviceRatio()
    this.forceNext = true
    this.watchDpr()
  }

  private watchDpr(): void {
    this.mql?.removeEventListener('change', this.onDprChange)
    if (typeof matchMedia !== 'function') return
    this.mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.mql.addEventListener('change', this.onDprChange)
  }
}
