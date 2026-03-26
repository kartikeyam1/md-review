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

describe('triple-click selection shows action bar', () => {
  it('triple-click selects line and shows action bar at correct position', async () => {
    await waitForPreview()

    // First drag-select to get action bar showing (simulates user had prior selection)
    const paragraph = page.locator('.preview-pane p').first()
    const box = await paragraph.boundingBox()
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + 100, box.y + 10, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const before = await getBarState()
    assert.ok(before.visible, 'action bar should show after drag')

    // Now triple-click to re-select the full line
    // This triggers: dismiss (from mousedown on existing bar) → new selection
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(500)

    const after = await getBarState()
    assert.ok(after.visible, 'action bar should be visible after triple-click')
    assert.ok(after.text.length > 10, `should have meaningful selected text, got: "${after.text}"`)
    // The bar should NOT be stuck at (6px, 6px) — that means coords were lost
    assert.ok(
      after.left !== '6px' || after.top !== '6px',
      `action bar should not be at fallback position (6,6), got left=${after.left} top=${after.top}`
    )
  })

  it('fresh triple-click (no prior selection) shows action bar correctly', async () => {
    await waitForPreview()

    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(500)

    const state = await getBarState()
    assert.ok(state.visible, 'action bar should be visible')
    assert.ok(state.text.length > 10, `should have selected text, got: "${state.text}"`)
  })

  it('triple-click then click Comment opens popover with selected text', async () => {
    await waitForPreview()

    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(500)

    const bar = page.locator('.selection-action-bar .action-btn')
    await bar.waitFor({ state: 'visible', timeout: 3000 })
    await bar.click()
    await page.waitForTimeout(300)

    const popover = page.locator('.popover')
    assert.ok(await popover.isVisible(), 'popover should open after clicking Comment')
  })
})

async function waitForPreview() {
  await page.goto(FILE_URL)
  await page.waitForTimeout(2000)
  await page.locator('.preview-pane').waitFor({ state: 'visible', timeout: 3000 })
}

async function getBarState() {
  return page.evaluate(() => {
    const sel = window.getSelection()
    const bar = document.querySelector('.selection-action-bar')
    return {
      visible: !!bar,
      left: bar?.style.left || '',
      top: bar?.style.top || '',
      text: sel?.toString().trim() || '',
    }
  })
}
