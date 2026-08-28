import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * The smoke flows §12 allows. Each one covers something the headless suite
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

/*
 * The grid menu is React, and §12's headless suite runs in `environment: 'node'` with
 * an `src/**\/*.test.ts` include — so a component that only exists as `.tsx` in a DOM
 * is structurally out of its reach, which is the same reason the flows above are here.
 * One flow, covering the two things that would be silent breakages: the menu opening
 * off the ruler at all, and a custom tuplet off the §3.1 lattice reporting rather than
 * throwing into React.
 */
test('the grid menu applies a preset and reports an off-lattice tuplet (§7.2)', async ({ page }) => {
  await page.goto('/')

  const ruler = page.locator('.board-ruler')
  const box = await ruler.boundingBox()
  if (!box) throw new Error('ruler canvas has no box')
  const openMenu = () =>
    page.mouse.click(box.x + 300, box.y + box.height / 2, { button: 'right' })

  await openMenu()
  const menu = page.locator('.grid-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.grid-chip')).toHaveCount(11) // the eleven §3.1 presets

  // 1/17 is in range but off the lattice: a message, not a crash, and the menu stays.
  await menu.locator('.grid-menu__input').nth(1).fill('17')
  await menu.locator('.grid-menu__apply').click()
  await expect(menu.locator('.grid-menu__error')).toContainText('lattice')
  await expect(menu).toBeVisible()

  // A preset applies and closes; the edit is one undoable command (§7.3).
  await menu.locator('.grid-chip', { hasText: /^16th$/ }).click()
  await expect(page.locator('.grid-menu')).toHaveCount(0)
  await expect(page.locator('.btn-undo')).toBeEnabled()

  await openMenu()
  await expect(page.locator('.grid-menu__label').first()).toContainText('16th')
})

/*
 * Meter markers (§7.2, design §3.7). Also `.tsx`-and-pointer territory the headless
 * suite cannot reach: `markerAt` is unit-tested, but "the band wins at the top and
 * nothing changed below it" is a claim about two event handlers on a real canvas.
 *
 * The undo button doubles as the assertion surface — it shows the label of the last
 * committed command, so "Set loop" then "Move meter" then "Remove meter" is direct
 * evidence that each gesture landed on the intended handler and committed once.
 */
/**
 * Centres of the meter marker chips currently painted in the ruler's top band.
 *
 * The chips are canvas pixels, so the only way to assert where a marker *is* — rather
 * than that a command with the right label committed — is to read them back. Chip fill
 * is the one colour in the band with blue > red > green; the white label punches small
 * gaps in each chip, so adjacent runs are merged before the centres are taken.
 */
async function meterChipXs(page: Page): Promise<number[]> {
  return page.locator('.board-ruler').evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 6, canvas.width, 1).data
    const runs: [number, number][] = []
    let start = -1
    for (let x = 0; x <= canvas.width; x++) {
      const r = data[x * 4] ?? 0, g = data[x * 4 + 1] ?? 0, b = data[x * 4 + 2] ?? 0
      const chip = x < canvas.width && b > r && r > g
      if (chip && start < 0) start = x
      if (!chip && start >= 0) {
        const last = runs[runs.length - 1]
        if (last && start - last[1] <= 12) last[1] = x - 1
        else runs.push([start, x - 1])
        start = -1
      }
    }
    return runs.map(([a, b]) => (a + b) / 2)
  })
}

/** Screen x of the playhead line on the overlay, or `null` when it is not drawn. */
async function playheadX(page: Page): Promise<number | null> {
  return page.locator('.board-overlay').evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const y = Math.floor(canvas.height / 2)
    const data = canvas.getContext('2d')!.getImageData(0, y, canvas.width, 1).data
    let best = -1
    let bestAlpha = 0
    for (let x = 0; x < canvas.width; x++) {
      const r = data[x * 4] ?? 0, g = data[x * 4 + 1] ?? 0, b = data[x * 4 + 2] ?? 0
      const a = data[x * 4 + 3] ?? 0
      if (a > bestAlpha && r > 120 && r > g * 1.8 && g > b) {
        bestAlpha = a
        best = x
      }
    }
    return best < 0 ? null : best
  })
}

test('meter markers own the ruler top band, and seek/loop still own the rest (§7.2)', async ({ page }) => {
  await page.goto('/')

  const ruler = page.locator('.board-ruler')
  /*
   * Re-measured before every gesture on purpose. The transport bar changes height as
   * the instrument manifests land, which moves the whole board down mid-test — a box
   * captured once at `goto` sends the later clicks into the chrome above the ruler.
   */
  const rulerBox = async () => {
    const box = await ruler.boundingBox()
    if (!box) throw new Error('ruler canvas has no box')
    return box
  }
  // 96 px/quarter is the initial zoom (§5.1), so column n sits at 96n from the left.
  const COL = 96
  const BELOW = 20 // comfortably under MARKER_BAND_HEIGHT (12)
  const BAND = 5
  const undoLabel = page.locator('.btn-undo__label')

  // --- below the band: a drag still sets the loop, exactly as before markers existed
  let box = await rulerBox()
  await page.mouse.move(box.x + 2 * COL, box.y + BELOW)
  await page.mouse.down()
  await page.mouse.move(box.x + 4 * COL, box.y + BELOW, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.btn-loop')).toHaveClass(/is-on/)
  await expect(undoLabel).toHaveText('Set loop')

  /*
   * --- below the band: a plain click still seeks, and seeking commits nothing.
   *
   * The transport has to be running for this to be observable at all: while stopped the
   * app's playhead rAF clears `playheadRef` on the frame after a seek, so the line is
   * painted and gone again. With it running, the seek's effect is the playhead jumping
   * from near the origin to the clicked column.
   */
  // Loop playback off first, or the transport would wrap the playhead back into the
  // 2–4 region it was just given and the seek's effect would be raced away. The toggle
  // is UI state, not a command, so it commits nothing.
  await page.locator('.btn-loop').click()
  await expect(page.locator('.btn-loop')).not.toHaveClass(/is-on/)

  await page.locator('.btn-play').click()
  await expect(page.locator('.btn-play__label')).toHaveText('Stop')
  await expect.poll(() => playheadX(page)).not.toBeNull()
  const beforeSeek = await playheadX(page)
  expect(beforeSeek, 'the playhead starts near the origin').toBeLessThan(2 * COL)

  box = await rulerBox()
  await page.mouse.click(box.x + 6 * COL, box.y + BELOW)
  // The board's x origin is the ruler's, so column 6 is 6 * COL on the overlay too.
  // The tolerance absorbs however far the clock advanced between click and read.
  await expect
    .poll(async () => playheadX(page) ?? -1, { message: 'playhead jumped to column 6' })
    .toBeGreaterThan(6 * COL - 20)
  expect(await playheadX(page)).toBeLessThan(6 * COL + 3 * COL)
  await expect(undoLabel).toHaveText('Set loop')

  await page.locator('.btn-play').click()
  await expect(page.locator('.btn-play__label')).toHaveText('Play')

  // --- below the band: right-click still opens the grid editor, which now also
  // carries the meter section a new meter is dropped from. The column is kept near
  // the left edge because the menu is a fixed panel anchored at the click, and a
  // click far to the right would open it off the side of the viewport.
  box = await rulerBox()
  await page.mouse.click(box.x + 2 * COL, box.y + BELOW, { button: 'right' })
  const menu = page.locator('.grid-menu')
  await expect(menu).toBeVisible()

  // An unreachable beat unit reports rather than throwing into React, the way an
  // off-lattice tuplet does — 4/3 is not a power-of-two SMF denominator.
  await menu.locator('.meter-menu__input').nth(1).fill('3')
  await menu.locator('.meter-menu__apply').click()
  await expect(menu.locator('.meter-menu__error')).toContainText('power of two')
  await expect(menu).toBeVisible()

  await menu.locator('.meter-chip', { hasText: /^7\/8$/ }).click()
  await expect(page.locator('.grid-menu')).toHaveCount(0)
  await expect(undoLabel).toHaveText('Set meter')

  // --- in the band: the chip drags, and the drop is one command
  box = await rulerBox()
  await page.mouse.move(box.x + 2 * COL, box.y + BAND)
  await page.mouse.down()
  await page.mouse.move(box.x + 8 * COL + 6, box.y + BAND, { steps: 8 })
  await page.mouse.up()
  await expect(undoLabel).toHaveText('Move meter')

  // The drop snapped to the 4/4 bar line at column 8 — not to the quarter under the
  // pointer — so the chip is there now, and a right-click on it removes the meter.
  box = await rulerBox()
  await page.mouse.click(box.x + 8 * COL, box.y + BAND, { button: 'right' })
  await expect(undoLabel).toHaveText('Remove meter')

  // The anchor meter at column 0 is refused both ways: right-clicking it opens the
  // grid editor instead of deleting it, and undo still shows the previous command.
  box = await rulerBox()
  await page.mouse.click(box.x + 2, box.y + BAND, { button: 'right' })
  await expect(page.locator('.grid-menu')).toBeVisible()
  await expect(undoLabel).toHaveText('Remove meter')
  await page.keyboard.press('Escape')
  await expect(page.locator('.grid-menu')).toHaveCount(0)

  /*
   * --- a meter that does not sit on a whole column.
   *
   * Under a 7/8 the bars are 3.5 quarters long, so a dragged marker lands at 5 1/2 —
   * and the grid editor is opened for a whole column. Matching the two by equality
   * made such a meter invisible to the menu: no Remove button, and a preset click
   * added a second meter at column 5 instead of replacing the one at 5 1/2.
   */
  box = await rulerBox()
  await page.mouse.click(box.x + 2 * COL, box.y + BELOW, { button: 'right' })
  await menu.locator('.meter-chip', { hasText: /^7\/8$/ }).click()
  box = await rulerBox()
  await page.mouse.click(box.x + 6 * COL, box.y + BELOW, { button: 'right' })
  await menu.locator('.meter-chip', { hasText: /^3\/4$/ }).click()
  await expect(undoLabel).toHaveText('Set meter')
  expect(await meterChipXs(page)).toHaveLength(3)

  // Drag it to 5.6 quarters: the surrounding 7/8 puts a bar line at 5 1/2, so that is
  // where it lands — a whole-quarter snap would have put it at 6, back where it was.
  box = await rulerBox()
  await page.mouse.move(box.x + 6 * COL, box.y + BAND)
  await page.mouse.down()
  await page.mouse.move(box.x + 5.6 * COL, box.y + BAND, { steps: 8 })
  await page.mouse.up()
  await expect(undoLabel).toHaveText('Move meter')
  const dragged = await meterChipXs(page)
  expect(dragged).toHaveLength(3)
  // Within a pixel: the chip's left edge is rounded to a whole pixel when drawn.
  expect(Math.abs((dragged[2] ?? 0) - 5.5 * COL)).toBeLessThan(2)

  // Column 5 contains it, so the menu opened there finds it, offers Remove, and a
  // preset replaces it in place instead of adding a fourth marker at column 5.
  box = await rulerBox()
  await page.mouse.click(box.x + 5 * COL, box.y + BELOW, { button: 'right' })
  await expect(menu.locator('.meter-menu__remove')).toBeVisible()
  await menu.locator('.meter-chip', { hasText: /^2\/4$/ }).click()
  await expect(undoLabel).toHaveText('Set meter')
  const replaced = await meterChipXs(page)
  expect(replaced).toHaveLength(3)
  expect(Math.abs((replaced[2] ?? 0) - 5.5 * COL)).toBeLessThan(2)

  // And the Remove button deletes that same meter rather than one column over.
  box = await rulerBox()
  await page.mouse.click(box.x + 5 * COL, box.y + BELOW, { button: 'right' })
  await menu.locator('.meter-menu__remove').click()
  await expect(undoLabel).toHaveText('Remove meter')
  expect(await meterChipXs(page)).toHaveLength(2)
})
