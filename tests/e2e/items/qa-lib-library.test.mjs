// Persona-QA (librarian) fixes, library lane: M2 deleted doc renders stale content under its
// not-found page, M3 phone bulk Move menu off-screen, m4 phone tag chips clipped, m5 empty
// overflow menu on file routes, m6 CJK / emoji search (UI half; server: qa-lib-search),
// c7a bulk bar × wraps on phone, c7b count on the Templates tab, c7c long collection names.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BASE, API } from '../helpers.mjs'
import { createDoc, uniq } from '../lib/docs.mjs'

const T = { timeout: 120_000 }
const DESKTOP = { width: 1400, height: 900 }
const PHONE = { width: 390, height: 844 }
const tid = (id) => `[data-testid="${id}"]`

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open(viewport = DESKTOP) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page, errors }
}

async function until(fn, { timeout = 8000, interval = 80, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${what}` })
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function apiCall(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: res.status, json }
}

async function createProtected(payload) {
  const r = await apiCall('POST', '/paste', { filename: 'doc.md', comments: [], sharedAt: new Date().toISOString(), ...payload })
  assert.equal(r.status, 200)
  assert.ok(r.json.editToken)
  return r.json
}

const box = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })

async function gotoLibrary(page, query = '') {
  await page.goto(`${BASE}/library${query}`)
  await page.locator(tid('library-page')).waitFor({ timeout: 15_000 })
}

/** Library filtered by a search for `q`, waiting until exactly `n` rows show. */
async function librarySearch(page, q, n = 1) {
  await page.locator(tid('library-search')).fill(q)
  await until(async () => (await page.locator(tid('library-row')).count()) === n, { timeout: 10_000, what: `${n} row(s) for q=${q}` })
}

// ── MAJOR 2: a deleted doc never renders its cached content ─────────────────
describe('qa-lib M2 — a deleted doc shows only the not-found state', () => {
  async function assertCleanNotFound(page, doc, marker) {
    await page.locator(tid('doc-not-found')).waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(400)
    assert.equal(await page.locator('.doc-body').count(), 0, 'no doc body under the not-found page')
    assert.equal(await page.locator('.preview-pane').count(), 0, 'no preview')
    assert.equal(await page.locator(tid('doc-header')).count(), 0, 'no header')
    const text = await page.locator('body').innerText()
    assert.ok(!text.includes(marker), `the deleted doc's body is not on the page: ${text.slice(0, 300)}`)
  }

  it('reload of a deleted doc (viewed before, clean draft) → not-found only, no stale title/body', T, async () => {
    const marker = uniq('StaleBody')
    const doc = await createDoc({ markdown: `# Stale title ${marker}\n\n${marker} paragraph.\n`, sessionName: `Stale ${marker}` })
    const { context, page, errors } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug || doc.id}`)
      await page.locator('.preview-pane').getByText(`${marker} paragraph.`).waitFor({ timeout: 15_000 })
      await page.waitForTimeout(900) // the (clean) local draft is persisted by now
      assert.equal((await apiCall('DELETE', `/paste/${doc.id}`)).status, 204)
      await page.reload()
      await assertCleanNotFound(page, doc, marker)
      assert.equal(await page.locator(tid('doc-not-found-copy')).count(), 0, 'a clean draft holds nothing of the user: no download offer')
      // and from "Recently viewed" (SPA navigation)
      await gotoLibrary(page)
      const item = page.locator(`${tid('library-recent')} ${tid('library-recent-item')}`).filter({ hasText: marker })
      await item.waitFor({ timeout: 10_000 })
      await item.click()
      await assertCleanNotFound(page, doc, marker)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('unsaved edits to a doc deleted meanwhile are offered as a download (and survive a reload), never rendered', T, async () => {
    const marker = uniq('Gone')
    const doc = await createProtected({ markdown: `# Gone ${marker}\n\nServer body ${marker}.\n`, sessionName: `Gone ${marker}` })
    const { context, page } = await open()
    try {
      // writes never reach the server: the edits stay unsaved
      await page.route((u) => u.href.startsWith(API) && /\/markdown$/.test(new URL(u.href).pathname), (r) => (r.request().method() === 'PUT' ? r.abort('connectionrefused') : r.continue()))
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}&view=edit`)
      const ed = page.locator('.cm-editor:visible .cm-content').first()
      await ed.waitFor({ state: 'visible', timeout: 20_000 })
      await ed.click()
      await page.keyboard.press('ControlOrMeta+End')
      const typed = `UNSAVED-${marker}`
      await page.keyboard.type(`\n\n${typed}`)
      await page.waitForTimeout(1500) // the dirty draft is persisted
      assert.equal((await apiCall('DELETE', `/paste/${doc.id}`, undefined, { 'X-Edit-Token': doc.editToken })).status, 204)
      await page.unroute(() => true).catch(() => {})
      await page.reload()
      await assertCleanNotFound(page, doc, typed)
      const offer = page.locator(tid('doc-not-found-copy'))
      await offer.waitFor({ state: 'visible', timeout: 5000 })
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator(tid('doc-not-found-download')).click()])
      const content = readFileSync(await download.path(), 'utf8')
      assert.ok(content.includes(typed), `the download holds the unsaved edits: ${content.slice(0, 200)}`)
      assert.match(download.suggestedFilename(), /\(my changes\)\.md$/)
      // still offered after another reload (kept in this browser until discarded)
      await page.reload()
      await offer.waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(tid('doc-not-found-discard')).click() // confirm accepted by the dialog handler
      await until(async () => (await offer.count()) === 0, { what: 'offer gone after discard' })
      await page.reload()
      await page.locator(tid('doc-not-found')).waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForTimeout(400)
      assert.equal(await offer.count(), 0, 'discarded for good')
    } finally { await context.close() }
  })
})

// ── MAJOR 3 + cosmetics: bulk bar and the Move menu ─────────────────────────
describe('qa-lib M3/c7 — bulk Move menu and bar', () => {
  it('phone: the Move menu opens fully inside the viewport, long names truncated; the bar is one line', T, async () => {
    const marker = uniq('BulkPhone')
    await createDoc({ markdown: `# ${marker}\n\nBody.\n`, sessionName: marker })
    const longName = `${marker} ${'x'.repeat(60)}`.slice(0, 60)
    const col = await apiCall('POST', '/library/collections', { name: longName })
    assert.equal(col.status, 201, JSON.stringify(col.json))
    for (const viewport of [PHONE, DESKTOP]) {
      const { context, page, errors } = await open(viewport)
      try {
        await gotoLibrary(page)
        await librarySearch(page, marker)
        await page.locator(tid('library-row-select')).first().check()
        const bar = page.locator(tid('library-bulk-bar'))
        await bar.waitFor({ state: 'visible', timeout: 5000 })
        if (viewport === PHONE) {
          const b = await box(bar)
          const x = await box(bar.locator('.lib-bulk-clear'))
          const count = await box(bar.locator('.lib-bulk-count'))
          assert.ok(Math.abs((x.top + x.bottom) / 2 - (count.top + count.bottom) / 2) < 8, `× on the count's line: ${JSON.stringify({ x, count })}`)
          assert.ok(b.height < 60, `bar is one line, got ${b.height}px`)
          assert.ok(b.right <= viewport.width, 'bar inside the viewport')
        }
        await page.locator(tid('library-bulk-move')).click()
        const menu = page.locator('[role="menu"][aria-label="Move to collection"]')
        await menu.waitFor({ state: 'visible', timeout: 5000 })
        const m = await box(menu)
        assert.ok(m.left >= 0 && m.right <= viewport.width, `menu inside the viewport at ${viewport.width}px: ${JSON.stringify(m)}`)
        assert.ok(m.width <= 322, `menu width capped, got ${m.width}`)
        if (viewport === DESKTOP) {
          // follow-up: it opens rightwards from the trigger, never over the sidebar
          const trig = await box(page.locator(tid('library-bulk-move')))
          const side = await box(page.locator('.lib-side'))
          assert.ok(m.left >= trig.left - 1, `menu starts at the trigger: ${JSON.stringify({ m, trig })}`)
          assert.ok(m.left >= side.right, `menu clear of the sidebar: ${JSON.stringify({ m, side })}`)
        }
        const item = menu.locator('[role="menuitem"]', { hasText: marker })
        const it = await box(item)
        assert.ok(it.left >= 0 && it.right <= viewport.width, 'the long item is fully tappable')
        assert.equal(await item.getAttribute('title'), longName, 'full name on hover')
        const overflow = await item.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, to: getComputedStyle(e).textOverflow }))
        assert.equal(overflow.to, 'ellipsis')
        assert.ok(overflow.sw > overflow.cw, 'the 60-char name is truncated, not widening the menu')
        await item.click()
        await until(async () => (await page.locator(tid('library-bulk-bar')).count()) === 0, { what: 'moved, selection cleared' })
        assert.deepEqual(errors, [])
      } finally { await context.close() }
    }
  })
})

// ── MINOR 4: phone cards keep "+ tag" reachable ─────────────────────────────
describe('qa-lib m4 — phone tag chips', () => {
  it('a card with several long tags keeps "+ tag" visible inside the card; chips scroll sideways', T, async () => {
    const marker = uniq('Tagcard')
    const doc = await createDoc({ markdown: `# ${marker}\n\nBody.\n`, sessionName: marker })
    assert.equal((await apiCall('PUT', `/paste/${doc.id}/tags`, { tags: ['runbook-ops', 'phone-tag-long', 'incident-review', 'quarterly-plan'] })).status, 200)
    const { context, page } = await open(PHONE)
    try {
      await gotoLibrary(page)
      await librarySearch(page, marker)
      const row = page.locator(tid('library-row')).first()
      const add = row.locator(tid('library-row-tag-add'))
      await add.waitFor({ state: 'visible', timeout: 5000 })
      const r = await box(row)
      const a = await box(add)
      assert.ok(a.left >= r.left && a.right <= r.right, `"+ tag" inside the card: ${JSON.stringify({ a, r })}`)
      const strip = row.locator(tid('library-row-tags'))
      const s = await strip.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX }))
      assert.equal(s.ox, 'auto')
      assert.ok(s.sw > s.cw, 'the chips overflow and scroll')
      // follow-up: a fade on the edge with more chips says the strip scrolls
      const fade = async () => strip.evaluate((e) => ({ more: e.dataset.more ?? null, mask: getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage }))
      let f = await fade()
      assert.equal(f.more, 'end', 'more chips beyond the end')
      assert.match(f.mask, /gradient/, 'the end edge fades')
      await strip.evaluate((e) => { e.scrollLeft = e.scrollWidth })
      await until(async () => (await fade()).more === 'start', { what: 'scrolled to the end: fade moves to the start' })
      await strip.evaluate((e) => { e.scrollLeft = 20 })
      await until(async () => (await fade()).more === 'both', { what: 'mid-scroll: both edges fade' })
      await strip.evaluate((e) => { e.scrollLeft = 0 })
      await until(async () => (await fade()).more === 'end', { what: 'back at the start' })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), PHONE.width, 'no horizontal page scroll')
      await add.click()
      await row.locator('input[aria-label="New tag"]').fill('fifth')
      await row.locator('input[aria-label="New tag"]').press('Enter')
      await until(async () => (await apiCall('GET', `/paste/${doc.id}?fields=meta,library`)).json?.tags?.includes('fifth'), { what: 'tag added on phone' })
      // a card whose chips fit shows no fade
      const few = uniq('Fewtags')
      const d2 = await createDoc({ markdown: `# ${few}\n\nBody.\n`, sessionName: few })
      assert.equal((await apiCall('PUT', `/paste/${d2.id}/tags`, { tags: ['ops'] })).status, 200)
      await page.locator(tid('library-search')).fill(few)
      const strip2 = page.locator(tid('library-row')).filter({ hasText: few }).locator(tid('library-row-tags'))
      await strip2.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await strip2.evaluate((e) => e.dataset.more ?? null), null, 'no fade when nothing is hidden')
    } finally { await context.close() }
  })
})

// ── MINOR 5: no dead overflow button on file routes ─────────────────────────
describe('qa-lib m5 — overflow menu on file routes', () => {
  it('a viewer on a file route (desktop) gets no empty overflow menu; the doc route still has one', T, async () => {
    const doc = await createProtected({ markdown: '# Bundle\n\nBundle body M5.\n', sessionName: uniq('Bundle') })
    const add = await apiCall('POST', `/paste/${doc.id}/files`, { name: 'appendix.md', content: '# Appendix\n\nAppendix body M5.\n' }, { 'X-Edit-Token': doc.editToken })
    assert.equal(add.status, 201)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}/appendix.md`)
      await page.locator('.preview-pane').getByText('Appendix body M5.').waitFor({ timeout: 15_000 })
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.app').first().getAttribute('data-capability'), 'viewer')
      const btn = page.locator(tid('header-overflow-btn'))
      if (await btn.count()) {
        await btn.click()
        const n = await page.locator(`${tid('header-overflow-menu')} [role^="menuitem"]`).count()
        assert.ok(n > 0, 'when the button is shown its menu has items')
      }
      await page.goto(`${BASE}/d/${doc.slug}`)
      await page.locator('.preview-pane').getByText('Bundle body M5.').waitFor({ timeout: 15_000 })
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('doc-save-as-template')).waitFor({ state: 'visible', timeout: 5000 })
    } finally { await context.close() }
  })
})

// ── MINOR 6 (UI) + c7b ──────────────────────────────────────────────────────
describe('qa-lib m6/c7b — CJK search in the library; no count on the Templates tab', () => {
  it('searching a word in the middle of a Japanese title lists the doc with the hit marked', T, async () => {
    const word = `ルート${Math.random().toString(36).slice(2, 5).replace(/[0-9]/g, '').toUpperCase() || 'Q'}`
    const title = `日本語のレポート：配送${word}`
    await createDoc({ markdown: `# ${title}\n\nBody.\n`, sessionName: title })
    const { context, page } = await open()
    try {
      await gotoLibrary(page)
      await page.locator(tid('library-search')).fill(word)
      const row = page.locator(tid('library-row')).filter({ hasText: title })
      await row.waitFor({ timeout: 10_000 })
      assert.equal(await row.locator(tid('library-snippet-hit')).first().innerText(), word)
    } finally { await context.close() }
  })

  it('the header count shows on Documents, not on Templates', T, async () => {
    const { context, page } = await open()
    try {
      await gotoLibrary(page)
      await page.locator(tid('library-count')).waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(tid('library-tab-templates')).click()
      await until(async () => (await page.locator(tid('library-count')).count()) === 0, { what: 'count hidden on Templates' })
      await page.goBack()
      await page.locator(tid('library-count')).waitFor({ state: 'visible', timeout: 10_000 })
    } finally { await context.close() }
  })
})
