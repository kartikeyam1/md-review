// Persona-QA (librarian) M2, embed half: a doc deleted while this browser holds unsaved edits
// to it, then opened as ?embed=1. The embed (#4 rule 16: content and one link out, nothing else)
// shows only the not-found state — no stale content, no download offer — and must not throw the
// edits away: the full page of the same URL still offers them.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BASE, API } from '../helpers.mjs'
import { uniq } from '../lib/docs.mjs'

const T = { timeout: 120_000 }
const tid = (id) => `[data-testid="${id}"]`

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

describe('qa-lib M2 — embed of a deleted doc with unsaved edits', () => {
  it('embed shows only not-found (no stale content, no offer) and keeps the edits for the full page', T, async () => {
    const marker = uniq('EmbedGone')
    const res = await fetch(`${API}/paste`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: `# Embed ${marker}\n\nServer body ${marker}.\n`, filename: 'e.md', sessionName: `Embed ${marker}`, comments: [], sharedAt: new Date().toISOString() }),
    })
    const doc = await res.json()
    assert.ok(doc.editToken && doc.slug)
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
    page.on('dialog', (d) => d.accept().catch(() => {}))
    try {
      // 1. unsaved edits: writes never reach the server
      await page.route((u) => u.href.startsWith(API) && /\/markdown$/.test(new URL(u.href).pathname), (r) => (r.request().method() === 'PUT' ? r.abort('connectionrefused') : r.continue()))
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}&view=edit`)
      const ed = page.locator('.cm-editor:visible .cm-content').first()
      await ed.waitFor({ state: 'visible', timeout: 20_000 })
      await ed.click()
      await page.keyboard.press('ControlOrMeta+End')
      const typed = `UNSAVED-${marker}`
      await page.keyboard.type(`\n\n${typed}`)
      await page.waitForTimeout(1500) // the dirty draft is persisted
      await page.unroute(() => true).catch(() => {})

      // 2. deleted server-side
      const del = await fetch(`${API}/paste/${doc.id}`, { method: 'DELETE', headers: { 'X-Edit-Token': doc.editToken } })
      assert.equal(del.status, 204)

      // 3. opened as an embed: not-found only
      await page.goto(`${BASE}/d/${doc.slug}?embed=1`)
      await page.locator(`.app.embed ${tid('doc-not-found')}`).waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.preview-pane').count(), 0, 'no preview in the embed')
      assert.equal(await page.locator(tid('doc-not-found-copy')).count(), 0, 'the embed offers nothing (content and one link out)')
      const text = await page.locator('body').innerText()
      assert.ok(!text.includes(typed) && !text.includes(`Server body ${marker}`), `no stale content: ${text.slice(0, 300)}`)

      // 4. the edits were kept: the full page offers them
      await page.goto(`${BASE}/d/${doc.slug}`)
      await page.locator(tid('doc-not-found')).waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator(tid('doc-not-found-copy')).waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await page.locator('.doc-body').count(), 0, 'still no doc body')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator(tid('doc-not-found-download')).click()])
      const content = readFileSync(await download.path(), 'utf8')
      assert.ok(content.includes(typed), `the download holds the unsaved edits: ${content.slice(0, 200)}`)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
})
