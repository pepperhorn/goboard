import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * The three smoke flows §12 allows. Each one covers something the headless suite
 * structurally cannot: that the app boots at all, that a pointer gesture reaches the
 * canvas and commits a command, and that the browser-only halves of §10 — the
 * download and IndexedDB — actually fire.
 */

/** Click the middle of the board surface, which places a stone in the active layer. */
async function clickBoard(page: Page, dx = 0, dy = 0): Promise<void> {
  const board = page.locator('.board-main')
  const box = await board.boundingBox()
  if (!box) throw new Error('board canvas has no box')
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy)
}

const activeCount = (page: Page) => page.locator('.layer-row--active .layer-row__count')

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`uncaught page error: ${err.message}`)
  })
})

test('boots with all four canvases sized and no console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto('/')

  await expect(page.locator('.transport')).toBeVisible()
  await expect(page.locator('.file-menu')).toBeVisible()
  await expect(page.locator('.layer-row')).toHaveCount(4) // §9.4's starter layers

  // §5.3: every canvas has a real backing store, and the DPR cap means it matches
  // the CSS box at deviceScaleFactor 1.
  for (const cls of ['.board-main', '.board-overlay', '.board-ruler', '.board-gutter']) {
    const size = await page.locator(cls).evaluate((el) => {
      const c = el as HTMLCanvasElement
      return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight }
    })
    expect(size.w, `${cls} backing width`).toBeGreaterThan(0)
    expect(size.h, `${cls} backing height`).toBeGreaterThan(0)
    expect(size.w).toBe(size.cssW)
    expect(size.h).toBe(size.cssH)
  }

  expect(errors).toEqual([])
})

test('a click places a stone and undo takes it back', async ({ page }) => {
  await page.goto('/')
  await expect(activeCount(page)).toHaveText('0')

  await clickBoard(page)
  await expect(activeCount(page)).toHaveText('1')

  const undo = page.locator('.btn-undo')
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(activeCount(page)).toHaveText('0')

  await page.locator('.btn-redo').click()
  await expect(activeCount(page)).toHaveText('1')
})

test('exports a .go.json and a playable .mid (§10)', async ({ page }) => {
  await page.goto('/')
  await clickBoard(page)
  await expect(activeCount(page)).toHaveText('1')

  const jsonDownload = page.waitForEvent('download')
  await page.locator('.btn-save').click()
  const json = await jsonDownload
  expect(json.suggestedFilename()).toBe('Untitled.go.json')

  await page.locator('.btn-midi').click()
  const dialog = page.locator('.midi-dialog')
  await expect(dialog).toBeVisible()
  // An empty-ish project reaches the ceiling exactly, so the note reads "exact".
  await expect(dialog.locator('.midi-dialog__note')).toHaveClass(/is-exact/)

  const midiDownload = page.waitForEvent('download')
  await dialog.locator('.chrome-btn--primary').click()
  const midi = await midiDownload
  expect(midi.suggestedFilename()).toBe('Untitled.mid')

  // The file is a real SMF: "MThd", a 6-byte header, then format 1.
  const path = await midi.path()
  const bytes = await import('node:fs/promises').then((fs) => fs.readFile(path))
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('MThd')
  expect(bytes.readUInt32BE(4)).toBe(6)
  expect(bytes.readUInt16BE(8)).toBe(1)
  await expect(dialog).toBeHidden()
})

test('autosave survives a reload (§10)', async ({ page }) => {
  await page.goto('/')
  await clickBoard(page)
  await expect(activeCount(page)).toHaveText('1')
  // The debounce is 1 s; the indicator flips to "Saved HH:MM" once the write lands.
  await expect(page.locator('.file-menu__status')).toContainText('Saved', { timeout: 5000 })

  await page.reload()

  await expect(page.locator('.file-menu__status')).toContainText('Restored your last session')
  await expect(activeCount(page)).toHaveText('1')
})
