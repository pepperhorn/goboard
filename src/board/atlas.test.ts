import { describe, expect, it } from 'vitest'
import { RADIUS_STEP, RING_LOD_RADIUS, bucketRadius, spriteKey } from './atlas'

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
