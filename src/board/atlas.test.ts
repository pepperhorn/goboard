import { describe, expect, it } from 'vitest'
import { RADIUS_STEP, RING_LOD_RADIUS, StoneAtlas, bucketRadius, spriteKey } from './atlas'
import type { CanvasFactory } from './atlas'

describe('bucketRadius', () => {
  it('quantizes continuous zoom radii to fixed buckets', () => {
    expect(bucketRadius(6.7)).toBe(6.5)
    expect(bucketRadius(6.8)).toBe(7)
    expect(bucketRadius(3.4)).toBe(3.5)
  })

  it('never returns zero, so a sprite always has area', () => {
    expect(bucketRadius(0)).toBe(RADIUS_STEP)
    expect(bucketRadius(0.01)).toBe(RADIUS_STEP)
  })

  it('keeps the bucket count small across the whole zoom range', () => {
    // pxPerSemitone spans 8..48, so radius spans ~3.4..20 — the atlas must not
    // explode into hundreds of near-identical sprites.
    const buckets = new Set<number>()
    for (let r = 3; r <= 21; r += 0.01) buckets.add(bucketRadius(r))
    expect(buckets.size).toBeLessThanOrEqual(40)
  })
})

describe('spriteKey', () => {
  const base = { white: true, color: '#c33', radius: 8, active: true }

  it('separates every visual dimension', () => {
    expect(spriteKey(base)).not.toBe(spriteKey({ ...base, white: false }))
    expect(spriteKey(base)).not.toBe(spriteKey({ ...base, color: '#3c3' }))
    expect(spriteKey(base)).not.toBe(spriteKey({ ...base, active: false }))
    expect(spriteKey(base)).not.toBe(spriteKey({ ...base, radius: 12 }))
  })

  it('shares one sprite across radii inside a bucket', () => {
    expect(spriteKey({ ...base, radius: 8.1 })).toBe(spriteKey({ ...base, radius: 7.9 }))
  })
})

describe('LOD threshold', () => {
  it('sits where the 2px ring stops being visible', () => {
    // At minimum zoom (8 px/semitone) the radius is 3.36, below the threshold.
    expect(Math.min(8, 24) * 0.42).toBeLessThan(RING_LOD_RADIUS)
    // At the 16 px/semitone default it is 6.72, above.
    expect(Math.min(16, 96) * 0.42).toBeGreaterThan(RING_LOD_RADIUS)
  })
})

// ---------------------------------------------------------------------------
// Growth. There is no canvas in Node, so the atlas gets a recording stub — enough
// surface for the sprite bake, and it reports which bitmap was copied where.
// ---------------------------------------------------------------------------

type FakeCanvas = {
  width: number
  height: number
  copiedFrom: unknown[]
  arcs: number
  getContext: () => unknown
}

function fakeCanvasFactory(): { factory: CanvasFactory; made: FakeCanvas[] } {
  const made: FakeCanvas[] = []
  const factory = ((w: number, h: number) => {
    const canvas: FakeCanvas = {
      width: w,
      height: h,
      copiedFrom: [],
      arcs: 0,
      getContext: () => ctx,
    }
    const ctx = {
      canvas,
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      shadowColor: '',
      shadowBlur: 0,
      save() {},
      restore() {},
      beginPath() {},
      arc() {
        canvas.arcs++
      },
      fill() {},
      stroke() {},
      clearRect() {},
      drawImage(source: unknown) {
        canvas.copiedFrom.push(source)
      },
    }
    made.push(canvas)
    return canvas
  }) as unknown as CanvasFactory
  return { factory, made }
}

describe('StoneAtlas growth (§5.3)', () => {
  /**
   * Distinct sprites, enough to overflow the 512 px starting texture. They vary by
   * layer color rather than radius: a radius sweep would balloon each sprite's own
   * size and hit the texture cap instead of the growth path under test.
   */
  const fill = (atlas: StoneAtlas, count: number, from = 0): void => {
    for (let i = from; i < from + count; i++) {
      atlas.get({
        white: i % 2 === 0,
        color: `#${(0x224466 + i * 977).toString(16).padStart(6, '0').slice(0, 6)}`,
        radius: 8,
        active: i % 3 === 0,
      })
    }
  }

  it('keeps every sprite when the texture doubles', () => {
    const { factory, made } = fakeCanvasFactory()
    const atlas = new StoneAtlas(1, factory)

    const first = atlas.get({ white: true, color: '#c33', radius: 8, active: true })
    fill(atlas, 400)

    expect(made.length, 'the texture should have grown').toBeGreaterThan(1)
    // The old bitmap is copied into the new one at the origin, which is what makes the
    // existing slot coordinates still valid.
    expect(made[1]!.copiedFrom).toContain(made[0])
    // Same key, same slot, and no second bake: growth used to drop the whole set and
    // re-render a screenful of glowing stones in the next frame.
    const bakes = made.reduce((n, c) => n + c.arcs, 0)
    expect(atlas.get({ white: true, color: '#c33', radius: 8, active: true })).toEqual(first)
    expect(made.reduce((n, c) => n + c.arcs, 0)).toBe(bakes)
  })

  it('counts sprites monotonically across a growth', () => {
    const { factory } = fakeCanvasFactory()
    const atlas = new StoneAtlas(1, factory)
    fill(atlas, 60)
    const before = atlas.size
    fill(atlas, 400, 60)
    expect(atlas.size).toBeGreaterThan(before)
  })

  it('clear drops the set so zoom-end can rebuild it', () => {
    const { factory } = fakeCanvasFactory()
    const atlas = new StoneAtlas(1, factory)
    fill(atlas, 20)
    expect(atlas.size).toBe(20)
    atlas.clear()
    expect(atlas.size).toBe(0)
  })
})
