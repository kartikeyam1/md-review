import { chromium } from 'playwright'
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from './helpers.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = resolve(__dirname, 'fixture.md')
const FILE_URL = `${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`

let browser, context, page

async function clickCommentAction(p = page) {
  const bar = p.locator('.selection-action-bar .action-btn')
  await bar.waitFor({ state: 'visible', timeout: 3000 })
  await bar.click()
  await p.locator('.popover').waitFor({ state: 'visible', timeout: 3000 })
}

/** Open the fixture and wait until the document has rendered. */
async function openFixture(p = page) {
  await p.goto(FILE_URL)
  await p.locator('[data-testid="doc-title"]', { hasText: 'Test Document' }).waitFor({ timeout: 10000 })
  await p.locator('.preview-pane p').first().waitFor({ timeout: 10000 })
}

/** Let pending Vue updates and rAF callbacks run (two frames). */
const settle = (p = page) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** Poll an in-page predicate; false (not a throw) on timeout so the caller's assert reports. */
const waitUntil = (fn, timeout = 3000, p = page) => p.waitForFunction(fn, null, { timeout }).then(() => true, () => false)

/** Triple-click `target` and wait for the selection action bar it raises. */
async function tripleClick(target, p = page) {
  await target.click({ clickCount: 3 })
  await p.locator('.selection-action-bar').waitFor({ state: 'visible', timeout: 3000 })
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
    await openFixture()

    // Switch to edit mode (app defaults to preview)
    await page.click('button:has-text("Edit")')
    // #6: the editor is lazy-loaded — wait for it to mount.
    await page.locator('.cm-editor:visible .cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
    await page.locator('.cm-editor:visible .cm-line').nth(2).waitFor({ timeout: 5000 })

    const editor = page.locator('.cm-editor:visible')
    assert.ok(await editor.count() > 0, 'Editor should be visible')

    // Triple-click to select a line in the editor
    const line = page.locator('.cm-line').nth(2)
    await tripleClick(line)
    await clickCommentAction()

    // Popover should appear
    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    // CodeMirror renders selection backgrounds as .cm-selectionBackground
    const selBgBefore = await page.locator('.cm-selectionBackground').count()
    assert.ok(selBgBefore > 0, 'Editor should show selection background')

    // Click the comment textarea. Negative check (the selection must NOT be
    // dropped): let the click's handlers and the next frames run, then look.
    await page.locator('.popover-input').click()
    await settle()

    // CodeMirror preserves its selection even when focus moves away
    const selBgAfter = await page.locator('.cm-selectionBackground').count()
    assert.ok(selBgAfter > 0, 'Editor selection background should still be visible after clicking textarea')
  })

  it('preview tab: CSS highlight persists after clicking comment textarea', async () => {
    await openFixture()

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('[data-testid="view-toggle-read"][aria-pressed="true"]').waitFor({ timeout: 3000 })
    await page.locator('.preview-pane p').first().waitFor({ timeout: 3000 })

    // Triple-click to select a paragraph in preview
    const paragraph = page.locator('.preview-pane p').first()
    await tripleClick(paragraph)

    // CSS highlight should be registered after selection (before opening popover)
    const hasHighlight = await waitUntil(() => CSS.highlights?.has('preview-selection') ?? false)
    assert.ok(hasHighlight, 'CSS highlight should be registered after selection')

    await clickCommentAction()

    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    // Click the comment textarea. Negative check (the highlight must NOT be
    // cleared): let the click's handlers and the next frames run, then look.
    await page.locator('.popover-input').click()
    await settle()

    // CSS highlight should still be active (even though native selection is cleared)
    const highlightAfter = await page.evaluate(() => {
      return CSS.highlights?.has('preview-selection') ?? false
    })
    assert.ok(highlightAfter, 'CSS highlight should persist after clicking textarea')

    assert.ok(await popover.isVisible(), 'Popover should still be visible')
  })

  it('preview tab: CSS highlight clears when popover is dismissed', async () => {
    await openFixture()

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('[data-testid="view-toggle-read"][aria-pressed="true"]').waitFor({ timeout: 3000 })
    await page.locator('.preview-pane p').first().waitFor({ timeout: 3000 })

    const paragraph = page.locator('.preview-pane p').first()
    await tripleClick(paragraph)
    await clickCommentAction()

    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    const hasHighlight = await waitUntil(() => CSS.highlights?.has('preview-selection') ?? false)
    assert.ok(hasHighlight, 'CSS highlight should be registered')

    // Dismiss popover by clicking cancel
    await page.locator('.popover .btn-ghost').click()

    const highlightGone = await waitUntil(() => !CSS.highlights?.has('preview-selection'))
    assert.ok(highlightGone, 'CSS highlight should be cleared after popover dismissal')
  })
})
