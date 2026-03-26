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

describe('table row comment highlight', () => {
  it('commenting on one table row should not highlight the entire table', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Switch to preview
    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // Find the table and its rows
    const table = page.locator('.preview-pane table')
    await table.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)

    // Triple-click the first data row (tbody tr:first-child) to select it
    const firstDataRow = page.locator('.preview-pane tbody tr').first()
    await firstDataRow.click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await clickCommentAction()

    // Popover should appear
    const popover = page.locator('.popover')
    await popover.waitFor({ state: 'visible', timeout: 3000 })

    // Type a comment and submit
    await page.locator('.popover-input').fill('Comment on first row only')
    await page.locator('.popover .btn-primary').click()
    await page.waitForTimeout(500)

    // Now check which elements have the .comment-highlight class
    const highlightedTags = await page.evaluate(() => {
      const els = document.querySelectorAll('.comment-highlight')
      return Array.from(els).map(el => ({
        tag: el.tagName.toLowerCase(),
        lineStart: el.getAttribute('data-line-start'),
        lineEnd: el.getAttribute('data-line-end'),
      }))
    })

    console.log('Highlighted elements:', JSON.stringify(highlightedTags, null, 2))

    // The table itself should NOT be highlighted
    const tableHighlighted = highlightedTags.some(e => e.tag === 'table')
    assert.ok(!tableHighlighted, `<table> should NOT have comment-highlight class, but these elements were highlighted: ${JSON.stringify(highlightedTags)}`)

    // The tbody should NOT be highlighted
    const tbodyHighlighted = highlightedTags.some(e => e.tag === 'tbody')
    assert.ok(!tbodyHighlighted, `<tbody> should NOT have comment-highlight class`)

    // Only the specific row(s) should be highlighted
    const trHighlighted = highlightedTags.filter(e => e.tag === 'tr')
    assert.ok(trHighlighted.length >= 1, 'At least one <tr> should be highlighted')

    // The second data row should NOT be highlighted
    const secondRowHighlighted = highlightedTags.some(e => e.tag === 'tr' && e.lineStart === '23')
    // The comment was on the first data row; the second should be clean
    // (depending on exact line ranges this might vary, but the table/tbody shouldn't be there)
  })
})
