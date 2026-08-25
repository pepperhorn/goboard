import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BenchResult } from '../src/bench/main'

/**
 * §5.3's benchmark: "M2 records a scripted frame-time number at a fixed viewport and
 * DPR, and it is re-run at every subsequent milestone — the target will otherwise rot
 * quietly as the playhead, lane, and subdivision lines add per-frame work."
 *
 * The recorded numbers live in `bench/latest.json`. They are machine-specific, so the
 * assertion here is a tripwire rather than the target: it catches a technique being
 * dropped (a live `shadowBlur`, a per-stone `arc`, gridlines stroked one at a time —
 * each of which costs an order of magnitude), not a few percent of drift between one
 * laptop and another.
 */

/**
 * Three times the recorded p95 on the reference machine (≈2.7 ms, software-rendered
 * headless Chromium). Loose enough for a slower laptop, tight enough to catch a
 * dropped technique — each of §5.3's eight costs an order of magnitude, not a few
 * percent.
 */
const CEILING_MS = 12

const here = dirname(fileURLToPath(import.meta.url))

test('board frame time at the §5.3 worst case', async ({ page }) => {
  test.setTimeout(120_000)

  page.on('pageerror', (err) => {
    throw new Error(`uncaught page error: ${err.message}`)
  })

  await page.goto('/bench.html')
  await page.waitForFunction(() => typeof window.__bench?.run === 'function')
  await expect(page.locator('.board-main')).toBeVisible()

  const result: BenchResult = await page.evaluate(() => window.__bench.run())

  const lines = [
    `board ${result.board.width}x${result.board.height} @ dpr ${result.dpr}, ${result.totalNotes} notes in project`,
    'phase                 notes      p50      p95      max     >16.7ms',
    ...result.phases.map((p) =>
      [
        p.name.padEnd(20),
        String(p.notesInView).padStart(6),
        `${p.frames.p50.toFixed(2)}ms`.padStart(9),
        `${p.frames.p95.toFixed(2)}ms`.padStart(9),
        `${p.frames.max.toFixed(2)}ms`.padStart(9),
        `${p.frames.overBudget}/${p.frames.count}`.padStart(11),
      ].join(''),
    ),
  ]
  console.log(lines.join('\n'))

  await mkdir(here, { recursive: true })
  await writeFile(
    join(here, 'latest.json'),
    `${JSON.stringify({ recordedBy: 'playwright/chromium', ...result }, null, 2)}\n`,
  )

  // Every phase drew what it claimed to, and the worst case really is loaded.
  for (const p of result.phases) {
    expect(p.frames.count, `${p.name} recorded no frames`).toBeGreaterThan(50)
  }
  const worstCase = result.phases[0]!
  expect(worstCase.notesInView, 'the min-zoom phase should hold ~5k notes').toBeGreaterThan(3000)

  for (const p of result.phases) {
    expect(p.frames.p95, `${p.name} p95`).toBeLessThan(CEILING_MS)
  }
})
