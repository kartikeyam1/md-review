import { chromium } from 'playwright'
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = resolve(__dirname, 'fixture.md')
const BASE = 'http://localhost:58747'
const FILE_URL = `${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`

let browser, context, page

async function clickCommentAction(p = page) {
  const bar = p.locator('.selection-action-bar .action-btn')
  await bar.waitFor({ state: 'visible', timeout: 3000 })
  await bar.click()
  await p.waitForTimeout(300)
}

before(async () => {
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
})

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  page = await context.newPage()
})

describe('selection preservation when clicking comment textarea', () => {
  it('edit tab: selection highlight is preserved after clicking comment textarea', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Switch to edit mode (app defaults to preview)
    await page.click('button:has-text("Edit")')
    await page.waitForTimeout(500)

    const editor = page.locator('.cm-editor')
    assert.ok(await editor.count() > 0, 'Editor should be visible')

    // Triple-click to select a line in the editor
    const line = page.locator('.cm-line').nth(2)
    await line.click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await clickCommentAction()

    // Popover should appear
    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    // CodeMirror renders selection backgrounds as .cm-selectionBackground
    const selBgBefore = await page.locator('.cm-selectionBackground').count()
    assert.ok(selBgBefore > 0, 'Editor should show selection background')

    // Click the comment textarea
    await page.locator('.popover-input').click()
    await page.waitForTimeout(300)

    // CodeMirror preserves its selection even when focus moves away
    const selBgAfter = await page.locator('.cm-selectionBackground').count()
    assert.ok(selBgAfter > 0, 'Editor selection background should still be visible after clicking textarea')
  })

  it('preview tab: CSS highlight persists after clicking comment textarea', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // Triple-click to select a paragraph in preview
    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(500)

    // CSS highlight should be registered after selection (before opening popover)
    const hasHighlight = await page.evaluate(() => {
      return CSS.highlights?.has('preview-selection') ?? false
    })
    assert.ok(hasHighlight, 'CSS highlight should be registered after selection')

    await clickCommentAction()

    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    // Click the comment textarea
    await page.locator('.popover-input').click()
    await page.waitForTimeout(300)

    // CSS highlight should still be active (even though native selection is cleared)
    const highlightAfter = await page.evaluate(() => {
      return CSS.highlights?.has('preview-selection') ?? false
    })
    assert.ok(highlightAfter, 'CSS highlight should persist after clicking textarea')

    assert.ok(await popover.isVisible(), 'Popover should still be visible')
  })

  it('preview tab: CSS highlight clears when popover is dismissed', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await clickCommentAction()

    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    const hasHighlight = await page.evaluate(() => CSS.highlights?.has('preview-selection') ?? false)
    assert.ok(hasHighlight, 'CSS highlight should be registered')

    // Dismiss popover by clicking cancel
    await page.locator('.popover .btn-ghost').click()
    await page.waitForTimeout(300)

    const highlightGone = await page.evaluate(() => !CSS.highlights?.has('preview-selection'))
    assert.ok(highlightGone, 'CSS highlight should be cleared after popover dismissal')
  })
})
