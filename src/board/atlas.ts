/**
 * Stone sprite atlas. See go-spec.md §5.3.
 *
 * Drawing 5k stones as `arc` + `fill` + `stroke` costs 12–25 ms/frame, against a
 * ~10 ms budget. Pre-rendering each distinct stone once and blitting it with
 * `drawImage` is a 4–6x win, and it is also the only way the §1 glow is affordable:
 * `shadowBlur` is a software path, so it is baked in here rather than applied live.
 */

/** Radius quantization step, in CSS pixels. Zoom is continuous; the atlas is not. */
export const RADIUS_STEP = 0.5

/** Below this radius the ring is sub-pixel, so stones render flat (§5.3 LOD). */
export const RING_LOD_RADIUS = 4

export type StoneSpec = {
  /** White-key pitch classes take a white stone, black-key rows a black one (§1). */
  readonly white: boolean
  /** Layer color, used for the ring and glow. */
  readonly color: string
  readonly radius: number
  /** The active layer draws full-strength; others dim (§4). */
  readonly active: boolean
}

export type Sprite = {
  readonly sx: number
  readonly sy: number
  readonly size: number
  /** Distance from the sprite's top-left to the stone's center. */
  readonly anchor: number
}

export const WHITE_STONE = '#f7f4ee'
export const BLACK_STONE = '#26231f'

export const bucketRadius = (r: number): number =>
  Math.max(RADIUS_STEP, Math.round(r / RADIUS_STEP) * RADIUS_STEP)

export const spriteKey = (s: StoneSpec): string =>
  `${s.white ? 'w' : 'b'}|${s.color}|${bucketRadius(s.radius)}|${s.active ? 'a' : 'd'}`

/** Padding around the stone for the ring and glow. */
const padFor = (radius: number): number => Math.ceil(radius * 0.55) + 3

export type CanvasFactory = (w: number, h: number) => HTMLCanvasElement

const domCanvas: CanvasFactory = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * A shelf-packed atlas that grows by re-packing when it fills.
 *
 * Radius buckets change on zoom, so the whole atlas is rebuilt at zoom-end rather
 * than accumulating dead sprites — a few hundred small draws, under 1 ms.
 */
export class StoneAtlas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private readonly slots = new Map<string, Sprite>()
  private readonly dpr: number
  private readonly create: CanvasFactory
  private penX = 0
  private penY = 0
  private shelfHeight = 0

  /** Device-pixel ratio the sprites were rendered at. */
  get scale(): number {
    return this.dpr
  }

  constructor(dpr = 1, create: CanvasFactory = domCanvas) {
    this.dpr = dpr
    this.create = create
    this.canvas = create(512, 512)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('StoneAtlas: 2d context unavailable')
    this.ctx = ctx
  }

  get texture(): HTMLCanvasElement {
    return this.canvas
  }

  get size(): number {
    return this.slots.size
  }

  /** Drop every sprite. Call at zoom-end, when radius buckets have shifted. */
  clear(): void {
    this.slots.clear()
    this.penX = 0
    this.penY = 0
    this.shelfHeight = 0
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  /** Fetch a sprite, rendering it into the atlas on first use. */
  get(spec: StoneSpec): Sprite {
    const key = spriteKey(spec)
    const existing = this.slots.get(key)
    if (existing) return existing

    const radius = bucketRadius(spec.radius)
    const pad = padFor(radius)
    const size = Math.ceil((radius + pad) * 2)
    const px = size * this.dpr

    if (this.penX + px > this.canvas.width) {
      this.penX = 0
      this.penY += this.shelfHeight
      this.shelfHeight = 0
    }
    if (this.penY + px > this.canvas.height) this.grow()

    const sprite: Sprite = { sx: this.penX, sy: this.penY, size: px, anchor: px / 2 }
    this.render(spec, radius, sprite)
    this.slots.set(key, sprite)
    this.penX += px
    this.shelfHeight = Math.max(this.shelfHeight, px)
    return sprite
  }

  private grow(): void {
    const next = this.create(this.canvas.width * 2, this.canvas.height * 2)
    const ctx = next.getContext('2d')
    if (!ctx) throw new Error('StoneAtlas: 2d context unavailable')
    this.canvas = next
    this.ctx = ctx
    // Re-pack from scratch: the sprites are cheap and the alternative is a
    // second blit path for the old texture.
    const specs = [...this.slots.keys()]
    this.slots.clear()
    this.penX = 0
    this.penY = 0
    this.shelfHeight = 0
    if (specs.length > 0) this.ctx.clearRect(0, 0, next.width, next.height)
  }

  private render(spec: StoneSpec, radius: number, sprite: Sprite): void {
    const ctx = this.ctx
    const cx = sprite.sx + sprite.anchor
    const cy = sprite.sy + sprite.anchor
    const r = radius * this.dpr

    ctx.save()
    ctx.globalAlpha = spec.active ? 1 : 0.45

    if (radius < RING_LOD_RADIUS) {
      // LOD: the 2px ring is sub-pixel here, so the layer color becomes the fill —
      // cheaper and more legible than a ring nobody can see.
      ctx.fillStyle = spec.color
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      return
    }

    // Glow, baked once. Never do this at draw time.
    if (spec.active) {
      ctx.shadowColor = spec.color
      ctx.shadowBlur = radius * 0.9 * this.dpr
    }
    ctx.fillStyle = spec.white ? WHITE_STONE : BLACK_STONE
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0

    ctx.lineWidth = 2 * this.dpr
    ctx.strokeStyle = spec.color
    ctx.beginPath()
    ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

/**
 * Blit a stone, stretching into a lozenge when the duration is wider than the stone
 * (§5.2). The body is a rect with two ring-colored edges and a cap at each end —
 * three cheap ops, versus building a rounded-rect path per note.
 */
export function drawStone(
  ctx: CanvasRenderingContext2D,
  atlas: StoneAtlas,
  spec: StoneSpec,
  cx: number,
  cy: number,
  widthPx: number,
): void {
  const sprite = atlas.get(spec)
  const radius = bucketRadius(spec.radius)
  // Sprites are stored in device pixels; the target context is already scaled to
  // CSS pixels, so divide back out.
  const drawn = sprite.size / atlas.scale
  const half = drawn / 2
  const rightCx = cx + Math.max(0, widthPx - radius * 2)

  if (rightCx > cx) {
    const alpha = ctx.globalAlpha
    ctx.globalAlpha = alpha * (spec.active ? 1 : 0.45)
    ctx.fillStyle = spec.white ? WHITE_STONE : BLACK_STONE
    ctx.fillRect(cx, cy - radius, rightCx - cx, radius * 2)
    if (radius >= RING_LOD_RADIUS) {
      ctx.strokeStyle = spec.color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, cy - radius + 1)
      ctx.lineTo(rightCx, cy - radius + 1)
      ctx.moveTo(cx, cy + radius - 1)
      ctx.lineTo(rightCx, cy + radius - 1)
      ctx.stroke()
    }
    ctx.globalAlpha = alpha
  }

  ctx.drawImage(atlas.texture, sprite.sx, sprite.sy, sprite.size, sprite.size,
    cx - half, cy - half, drawn, drawn)
  if (rightCx > cx) {
    ctx.drawImage(atlas.texture, sprite.sx, sprite.sy, sprite.size, sprite.size,
      rightCx - half, cy - half, drawn, drawn)
  }
}
