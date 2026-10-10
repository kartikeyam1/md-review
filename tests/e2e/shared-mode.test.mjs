import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API as PASTE_API } from './helpers.mjs'
import { asLegacyDoc } from './lib/legacy-docs.mjs'

let browser

before(async () => {
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
})

async function createSharedSession() {
  const res = await fetch(`${PASTE_API}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: '# Test Document\n\nThis is line 2.\nThis is line 3.',
      filename: 'test.md',
      comments: [],
      sharedAt: new Date().toISOString(),
      // Comment UI is review-mode only (#2); the default is now publish.
      mode: 'review',
    }),
  })
  const { id } = await res.json()
  await asLegacyDoc(id) // #23: a link-editable doc, as every doc was before edit tokens
  return id
}

describe('shared mode', () => {
  it('loads a shared document and displays it', async () => {
    const id = await createSharedSession()
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${BASE}/#shared=${id}`)
    await page.waitForTimeout(2000)

    // Filename and sync indicator live in the editor header (#2): switch to edit view.
    await page.click('[data-testid="view-toggle-edit"]')
    const filename = await page.locator('.filename').textContent()
    assert.ok(filename.includes('test.md'))

    // Should show sync indicator
    const syncIndicator = await page.locator('.sync-indicator').count()
    assert.ok(syncIndicator > 0, 'Sync indicator should be visible')

    await context.close()
  })

  it('shows agent comments added via API after polling', async () => {
    const id = await createSharedSession()
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${BASE}/#shared=${id}`)
    await page.waitForTimeout(2000)

    // Add a comment via API (simulating an agent)
    await fetch(`${PASTE_API}/paste/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startLine: 0,
        endLine: 0,
        selectedText: '# Test Document',
        body: 'Consider a more descriptive title',
        category: 'suggestion',
        author: 'claude-code',
      }),
    })

    // Wait for poll cycle (5s + buffer)
    await page.waitForTimeout(6000)

    // Comment should now appear in the sidebar
    const commentBody = await page.locator('.comment-body').textContent()
    assert.ok(commentBody.includes('Consider a more descriptive title'))

    // Author label should appear
    const authorLabel = await page.locator('.comment-author').textContent()
    assert.ok(authorLabel.includes('claude-code'))

    await context.close()
  })
})
