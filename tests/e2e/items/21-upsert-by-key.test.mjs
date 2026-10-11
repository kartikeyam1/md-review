// Item #21 — upsert by key, browser half: AC-21.12 (the revisions modal shows an upsert run's change
// note as `revision-note`, as plain text). Server half: server/test-items/21-upsert-by-key.test.mjs.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import { uniq, tid } from './23-lib.mjs'

const T = { timeout: 60_000 }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function upsert(key, body, token) {
  const res = await fetch(`${API}/paste/by-key/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}) },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`upsert ${key}: ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function openHistory(page) {
  await page.locator(tid('header-overflow-btn')).click()
  await page.locator(tid('menu-history')).click()
  const modal = page.locator(tid('revisions-modal'))
  await modal.waitFor({ state: 'visible', timeout: 10000 })
  return modal
}

describe('#21 revision notes in the revisions modal', () => {
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    it(`AC-21.12 revision-note shows the note text for that entry (${viewport.width}px)`, T, async () => {
      const key = `e2e21:${uniq('k')}`
      const c = await upsert(key, { markdown: '# Weekly\n\nRun 1.\n', sessionName: 'Weekly e2e' })
      const note = 'run 2 <b>bold?</b> **md**'
      const u = await upsert(key, { markdown: '# Weekly\n\nRun 2.\n', changeNote: note }, c.editToken)
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
      const page = await context.newPage()
      try {
        await page.goto(`${BASE}/d/${c.slug}`)
        await page.locator('.preview-pane').getByText('Run 2.').waitFor({ timeout: 15000 })
        const modal = await openHistory(page)
        const entry = modal.locator(`.rev-item[data-hash="${u.revision}"]`)
        await entry.waitFor({ timeout: 5000 })
        const n = entry.locator(tid('revision-note'))
        assert.equal(await n.count(), 1)
        assert.equal(await n.innerText(), note, 'rendered as text, verbatim')
        assert.equal(await n.locator('b').count(), 0, 'no HTML injection')
        assert.ok(await n.isVisible())
        assert.equal(await modal.locator(`.rev-item[data-hash="${c.revision}"] ${tid('revision-note')}`).count(), 0, 'no note → no element')
      } finally { await context.close() }
    })
  }

  it('fix: a keyed doc created without filename or name still shows its header and History', T, async () => {
    const key = `e2e21:${uniq('nofile')}`
    const c = await upsert(key, { markdown: '# Bare\n\nRun 1.\n' })
    const u = await upsert(key, { markdown: '# Bare\n\nRun 2.\n', changeNote: 'second run' }, c.editToken)
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    try {
      await page.goto(`${BASE}/d/${c.slug}`)
      await page.locator('.preview-pane').getByText('Run 2.').waitFor({ timeout: 15000 })
      await page.locator(tid('doc-title')).waitFor({ timeout: 5000 })
      const modal = await openHistory(page)
      assert.equal(await modal.locator(`.rev-item[data-hash="${u.revision}"] ${tid('revision-note')}`).innerText(), 'second run')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
})
