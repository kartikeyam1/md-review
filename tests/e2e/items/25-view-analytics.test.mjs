// Item #25 — view counts and named readers, browser half: AC-25.8–25.12 (+ pinned revisions, hidden tab,
// phone sheet, keyboard). Server half: server/test-items/25-view-analytics.test.mjs.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions } from '../lib/docs.mjs'
import { uniq, tid, createProtectedDoc } from './23-lib.mjs'

const T = { timeout: 90_000 }
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixture.md')

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

const key = (d) => d.slug || d.id
const rid = () => `e2e-${Math.random().toString(36).slice(2, 12)}`
const stats = async (x, token) => (await fetch(`${API}/paste/${x}/views`, { headers: token ? { 'X-Edit-Token': token } : {} })).json()
const seedView = (x, body) => fetch(`${API}/paste/${x}/views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function open({ viewport = { width: 1400, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const posts = []
  page.on('request', (r) => { if (r.method() === 'POST' && /\/views$/.test(new URL(r.url()).pathname)) posts.push({ url: r.url(), body: r.postDataJSON() }) })
  return { context, page, posts }
}

describe('#25 recording a view', () => {
  it('AC-25.8 visible 3 s → exactly one POST /views with the current content_hash; a reload the same day keeps total_views', T, async () => {
    const d = await createDoc({ markdown: '# Viewed\n\nBody.\n', sessionName: uniq('Views') })
    const { current } = await listRevisions(d.id)
    const { context, page, posts } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(3000)
      assert.equal(posts.length, 1, JSON.stringify(posts))
      assert.equal(posts[0].body.revision, current)
      assert.match(posts[0].body.reader_id, /^anon-/)
      assert.equal((await stats(d.id)).total_views, 1)
      await page.waitForTimeout(1500)
      assert.equal(posts.length, 1, 'at most one per doc per page load')
      // The header shows the counts (desktop: after doc-updated).
      await page.locator(tid('view-stats')).waitFor({ timeout: 5000 })
      assert.equal(await page.locator(tid('view-stats')).innerText(), '1 view · 1 reader')
      await page.reload()
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(2800)
      assert.equal(posts.length, 2, 'the reload posts again')
      assert.equal((await stats(d.id)).total_views, 1, 'same reader, same day: still 1')
    } finally { await context.close() }
  })

  it('a new revision arriving by live sync records one more view', T, async () => {
    const d = await createDoc({ markdown: '# Live\n\nOne.\n' })
    const { context, page, posts } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('One.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(2600)
      assert.equal(posts.length, 1)
      const r = await putMarkdown(d.id, '# Live\n\nTwo.\n')
      await page.locator('.preview-pane').getByText('Two.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(2600)
      assert.equal(posts.length, 2)
      assert.equal(posts[1].body.revision, r.content_hash)
    } finally { await context.close() }
  })

  it('AC-25.9 navigating away after 1 s sends no POST', T, async () => {
    const d = await createDoc({ markdown: '# Quick\n\nBody.\n' })
    const { context, page, posts } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(1000)
      await page.locator(tid('nav-library')).click()
      await page.waitForFunction(() => location.pathname.endsWith('/library'), null, { timeout: 5000 })
      await page.waitForTimeout(2500)
      assert.equal(posts.length, 0)
      assert.equal((await stats(d.id)).total_views, 0)
    } finally { await context.close() }
  })

  it('a hidden tab does not count until it has been visible for 2 s', T, async () => {
    const d = await createDoc({ markdown: '# Hidden\n\nBody.\n' })
    const { context, page, posts } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.waitForTimeout(2600)
      assert.equal(posts.length, 0, 'not while hidden')
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.waitForTimeout(2600)
      assert.equal(posts.length, 1)
    } finally { await context.close() }
  })

  it('AC-25.10 ?embed=1 and a ?filePath= fixture send no POST', T, async () => {
    const d = await createDoc({ markdown: '# Embedded\n\nBody.\n' })
    const a = await open()
    try {
      await a.page.goto(`${BASE}/d/${key(d)}?embed=1`)
      await a.page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      await a.page.waitForTimeout(3000)
      assert.equal(a.posts.length, 0)
      assert.equal(await a.page.locator(tid('view-stats')).count(), 0)
    } finally { await a.context.close() }
    const b = await open()
    try {
      await b.page.goto(`${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`)
      await b.page.locator('.preview-pane').first().waitFor({ timeout: 15000 })
      await b.page.waitForTimeout(3000)
      assert.equal(b.posts.length, 0)
    } finally { await b.context.close() }
    assert.equal((await stats(d.id)).total_views, 0)
  })

  it('a pinned revision /d/<x>@<hash> records a view of that revision', T, async () => {
    const d = await createDoc({ markdown: '# Pin\n\nOld.\n' })
    const old = (await listRevisions(d.id)).current
    await putMarkdown(d.id, '# Pin\n\nNew.\n', { author: 'someone else' }) // another author: not folded into the first revision
    const { context, page, posts } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}@${old}`)
      await page.locator('.preview-pane').getByText('Old.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(3000)
      assert.equal(posts.length, 1)
      assert.equal(posts[0].body.revision, old)
    } finally { await context.close() }
  })
})

describe('#25 header stats and the readers panel', () => {
  it('AC-25.11 an editor sees 2 reader rows, the stale one with reader-stale-badge; Esc closes and refocuses', T, async () => {
    const d = await createProtectedDoc({ markdown: '# Readers\n\nA.\n', sessionName: uniq('Readers') })
    const a = (await listRevisions(d.id)).current
    await seedView(d.id, { reader_id: rid(), name: 'Ana', revision: a })
    await putMarkdown(d.id, '# Readers\n\nB.\n', { editToken: d.editToken })
    await seedView(d.id, { reader_id: rid(), name: 'Ben' })
    await seedView(d.id, { reader_id: rid() })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}?edit=${d.editToken}`)
      await page.locator('.preview-pane').getByText('B.').waitFor({ timeout: 15000 })
      const vs = page.locator(tid('view-stats'))
      await vs.waitFor({ timeout: 5000 })
      assert.equal(await vs.evaluate((el) => el.tagName), 'BUTTON')
      assert.equal(await vs.innerText(), '3 views · 3 readers')
      await vs.click()
      const panel = page.locator(tid('readers-panel'))
      await panel.waitFor()
      const rows = panel.locator(tid('reader-row'))
      assert.equal(await rows.count(), 2)
      assert.match(await rows.nth(0).innerText(), /Ben/)
      assert.equal(await rows.nth(0).locator(tid('reader-latest-badge')).count(), 1)
      const stale = rows.nth(1)
      assert.match(await stale.innerText(), /Ana/)
      assert.equal(await stale.locator(tid('reader-stale-badge')).count(), 1)
      assert.equal(await stale.locator(tid('reader-stale-badge')).getAttribute('title'), a.slice(0, 7))
      assert.match(await stale.locator('time').getAttribute('title'), /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(await panel.locator(tid('readers-anonymous')).innerText(), '+ 1 anonymous')
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached', timeout: 3000 })
      assert.ok(await vs.evaluate((el) => el === document.activeElement), 'focus back on view-stats')
      // The editor's own view is not counted.
      await page.waitForTimeout(2500)
      assert.equal((await stats(d.id)).total_views, 3)
    } finally { await context.close() }
  })

  it('AC-25.12 a viewer (protected doc, no token) sees the counts as plain text; clicking opens nothing', T, async () => {
    const d = await createProtectedDoc({ markdown: '# Viewer\n\nBody.\n' })
    await seedView(d.id, { reader_id: rid(), name: 'Someone' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      const vs = page.locator(tid('view-stats'))
      await vs.waitFor({ timeout: 5000 })
      assert.match(await vs.innerText(), /^1 view · 1 reader$/)
      assert.equal(await vs.evaluate((el) => el.tagName), 'SPAN')
      assert.equal(await vs.evaluate((el) => el.tabIndex), -1, 'not focusable')
      await vs.click()
      await page.waitForTimeout(300)
      assert.equal(await page.locator(tid('readers-panel')).count(), 0)
      // After this viewer's own view is recorded the counts refresh.
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === '2 views · 2 readers', tid('view-stats'), { timeout: 6000 })
    } finally { await context.close() }
  })

  it('phone: view-stats in doc-meta-row, readers panel as a full-width sheet with the empty state', T, async () => {
    const d = await createDoc({ markdown: '# Phone\n\nBody.\n' }) // legacy doc: everyone is an editor
    await seedView(d.id, { reader_id: rid() })
    const { context, page } = await open({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      const vs = page.locator(`${tid('doc-meta-row')} ${tid('view-stats')}`)
      await vs.waitFor({ timeout: 5000 })
      assert.equal(await page.locator(`${tid('doc-header')} ${tid('view-stats')}`).count(), 0)
      await vs.click()
      const panel = page.locator(tid('readers-panel'))
      await panel.waitFor()
      const box = await panel.boundingBox()
      assert.ok(box.width >= 389, `sheet width ${box.width}`)
      assert.ok(Math.abs(box.y + box.height - 844) < 2, 'docked at the bottom')
      assert.equal(await panel.locator(tid('readers-empty')).innerText(), 'No named readers yet')
      assert.match(await panel.locator(tid('readers-anonymous')).innerText(), /\+ [12] anonymous/)
      const w = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(w <= 390, 'no horizontal scroll')
    } finally { await context.close() }
  })

  it('fix: tablet 820px — the readers panel stays inside the viewport', T, async () => {
    const d = await createDoc({ markdown: '# Tablet\n\nBody.\n' })
    await seedView(d.id, { reader_id: rid(), name: 'A very long reader name for the panel' })
    for (const width of [641, 820, 1099]) {
      const { context, page } = await open({ viewport: { width, height: 1000 } })
      try {
        await page.goto(`${BASE}/d/${key(d)}`)
        await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
        await page.locator(`${tid('doc-meta-row')} ${tid('view-stats')}`).click()
        const panel = page.locator(tid('readers-panel'))
        await panel.waitFor()
        const b = await panel.boundingBox()
        assert.ok(b.x >= 0 && b.x + b.width <= width, `${width}px: panel ${b.x}..${b.x + b.width}`)
        assert.ok(await panel.locator(tid('reader-row')).first().isVisible())
      } finally { await context.close() }
    }
  })

  it('hidden while nothing was viewed; not in the editor header', T, async () => {
    const d = await createDoc({ markdown: '# Zero\n\nBody.\n' })
    const { context, page } = await open()
    try {
      await page.route('**/views', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 204 }) : route.continue()))
      await page.goto(`${BASE}/d/${key(d)}`)
      await page.locator('.preview-pane').getByText('Body.').waitFor({ timeout: 15000 })
      await page.waitForTimeout(500)
      assert.equal(await page.locator(tid('view-stats')).count(), 0)
      await seedView(d.id, { reader_id: rid() })
      await page.goto(`${BASE}/d/${key(d)}?view=edit`)
      await page.locator('.cm-content').waitFor({ timeout: 15000 })
      await page.waitForTimeout(500)
      assert.equal(await page.locator(tid('view-stats')).count(), 0, 'editor header has no view-stats')
    } finally { await context.close() }
  })
})
