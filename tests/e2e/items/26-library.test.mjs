// Item #26 — the library page (browser half): AC-26.1–26.14.
// Server half (AC-26.20/21): server/test-items/26-*.test.mjs. Files in the doc view (AC-26.15–19): 26-files*.
//
// The library lists every doc in its backend, so these tests run against private backends
// (26-library-lib.mjs): the app keeps calling the shared API origin and the context's route
// sends those calls to the private one. Counting tests get a fresh backend of their own.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE } from '../helpers.mjs'
import { tid, uniq, privateBackend, routeToBackend, api, mkDoc, libDocs, until } from './26-library-lib.mjs'

const T = { timeout: 120_000 }
const DESKTOP = { width: 1400, height: 900 }
const PHONE = { width: 390, height: 844 }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open(be, { viewport = DESKTOP, reviewer, init } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  await routeToBackend(context, be)
  if (reviewer !== undefined) {
    await context.addInitScript((name) => { try { localStorage.setItem('md-review-reviewer', name) } catch { /* */ } }, reviewer)
  }
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('dialog', (d) => { errors.push(`native dialog: ${d.message()}`); d.dismiss().catch(() => {}) })
  return { context, page, errors }
}

const rows = (page) => page.locator(tid('library-row'))
const mainRows = (page) => page.locator(`.library-list ${tid('library-row')}`)
const rowFor = (page, id) => page.locator(`${tid('library-row')}[data-doc-id="${id}"]`)
const rowTitles = (page) => mainRows(page).locator('.library-row-title').allInnerTexts()
const here = (page) => new URL(page.url())

async function gotoLibrary(page, query = '') {
  await page.goto(`${BASE}/library${query}`)
  await page.locator(tid('library-page')).waitFor({ timeout: 15000 })
  await page.locator(tid('library-loading')).waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
}

// ── fresh backend: empty state, the first three docs, sort, no-results, API down ──
describe('#26 library — a fresh backend', () => {
  let be
  const docs = {}
  before(async () => { be = await privateBackend() })
  after(async () => { await be?.stop() })

  it('AC-26.13 empty data dir → library-empty[data-state=no-docs] with library-new-doc', T, async () => {
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page)
      const empty = page.locator(`${tid('library-empty')}[data-state="no-docs"]`)
      await empty.waitFor({ timeout: 10000 })
      assert.match(await empty.innerText(), /No documents yet/)
      await empty.locator(tid('library-new-doc')).waitFor()
      assert.equal(await rows(page).count(), 0)
    } finally { await context.close() }
  })

  it('AC-26.1 three docs → three rows with title, type, mode, author, updated time; "3 documents"', T, async () => {
    docs.b = await mkDoc(be, { markdown: '# banana split\n\nYellow.\n', author: 'agent-smith', mode: 'review' })
    await new Promise((r) => setTimeout(r, 30))
    docs.a = await mkDoc(be, { markdown: '# Apple pie\n\nRed.\n', author: 'Asha' })
    await new Promise((r) => setTimeout(r, 30))
    docs.c = await mkDoc(be, { markdown: '<html><head><title>cherry tart</title></head><body><p>Dark.</p></body></html>', filename: 'c.html', contentType: 'html' })
    const { context, page, errors } = await open(be)
    try {
      await gotoLibrary(page)
      await until(async () => (await rows(page).count()) === 3, { timeout: 10000, what: '3 rows' })
      assert.equal((await page.locator(tid('library-count')).innerText()).trim(), '3 documents')
      const b = rowFor(page, docs.b.id)
      assert.equal(await b.locator('.library-row-title').innerText(), 'banana split')
      assert.equal(await b.locator('.library-row-title').getAttribute('href'), `/d/${docs.b.slug || docs.b.id}`)
      assert.equal((await b.locator('.lib-badge-type').innerText()).trim(), 'md')
      assert.equal((await b.locator('[data-mode]').innerText()).trim(), 'review')
      assert.equal((await b.locator('.lib-author').innerText()).trim(), 'agent-smith')
      const updated = b.locator('.lib-updated')
      assert.match(await updated.innerText(), /just now|min ago/)
      assert.ok(!Number.isNaN(Date.parse(await updated.getAttribute('title') ?? '')) || /\d{4}/.test(await updated.getAttribute('title') ?? ''), 'absolute time in title=')
      const c = rowFor(page, docs.c.id)
      assert.equal(await c.locator('.library-row-title').innerText(), 'cherry tart')
      assert.equal((await c.locator('.lib-badge-type').innerText()).trim(), 'html')
      assert.equal((await c.locator('[data-mode]').innerText()).trim(), 'publish')
      assert.equal((await c.locator('.lib-author').innerText()).trim(), '—', 'unknown author')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-26.5 default sort is updated (newest first); title sorts A→Z case-insensitively; relevance only with q', T, async () => {
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page)
      await until(async () => (await rows(page).count()) === 3, { timeout: 10000, what: '3 rows' })
      const sort = page.locator(tid('library-sort'))
      assert.equal(await sort.inputValue(), 'updated')
      assert.deepEqual(await rowTitles(page), ['cherry tart', 'Apple pie', 'banana split'])
      assert.equal(await sort.locator('option[value="relevance"]').count(), 0, 'no relevance without q')
      assert.equal(await sort.locator('option[value="views"]').count(), 1, 'views offered: the API returns view counts')
      await sort.selectOption('title')
      await until(async () => here(page).searchParams.get('sort') === 'title', { what: 'sort=title in URL' })
      await until(async () => JSON.stringify(await rowTitles(page)) === JSON.stringify(['Apple pie', 'banana split', 'cherry tart']), { what: 'title order' })
      // QA m2: choosing the default sort again drops `sort` from the URL (bare /library) …
      await sort.selectOption('updated')
      await until(async () => here(page).search === '', { what: 'bare /library after choosing the default sort' })
      await until(async () => JSON.stringify(await rowTitles(page)) === JSON.stringify(['cherry tart', 'Apple pie', 'banana split']), { what: 'updated order' })
      // … so with q, relevance is offered and becomes the default.
      await page.locator(tid('library-search')).fill('pie')
      await until(async () => here(page).searchParams.get('q') === 'pie', { what: 'q=pie' })
      assert.equal(await sort.locator('option[value="relevance"]').count(), 1)
      await until(async () => (await sort.inputValue()) === 'relevance', { what: 'relevance is the default with q' })
      assert.equal(here(page).searchParams.get('sort'), null)
      await page.goto(`${BASE}/library?q=pie`)
      await page.locator(tid('library-sort')).waitFor()
      assert.equal(await page.locator(tid('library-sort')).inputValue(), 'relevance')
    } finally { await context.close() }
  })

  it('AC-26.13 no match → data-state=no-results; API down → library-error, retry reloads on success', T, async () => {
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page, '?q=zzqqxxnomatch')
      const noRes = page.locator(`${tid('library-empty')}[data-state="no-results"]`)
      await noRes.waitFor({ timeout: 10000 })
      assert.match(await noRes.innerText(), /No documents match/)
      await noRes.locator(tid('library-clear-filters')).click()
      await until(async () => (await rows(page).count()) === 3, { what: 'rows after clearing' })
      assert.equal(here(page).search, '')

      let down = true
      await page.route((u) => u.pathname === '/library/docs', (route) => (down ? route.fulfill({ status: 503, body: 'down' }) : route.fallback()))
      await page.goto(`${BASE}/library`)
      await page.locator(tid('library-error')).waitFor({ timeout: 10000 })
      down = false
      await page.locator(tid('library-retry')).click()
      await until(async () => (await rows(page).count()) === 3, { timeout: 10000, what: 'rows after retry' })
      assert.equal(await page.locator(tid('library-error')).count(), 0)
      // Unreachable (network error) shows the same state.
      down = true
      await page.unroute((u) => u.pathname === '/library/docs')
      await page.route((u) => u.pathname === '/library/docs', (route) => route.abort())
      await page.goto(`${BASE}/library`)
      await page.locator(tid('library-error')).waitFor({ timeout: 10000 })
    } finally { await context.close() }
  })
})

// ── one shared private backend for the rest ──
describe('#26 library — search, filters, collections, tags, pins, recent, bulk, phone', () => {
  let be
  before(async () => { be = await privateBackend() })
  after(async () => { await be?.stop() })

  it('AC-26.2 typing "kumquat" → q in URL within 1 s, only that row, snippet hit "kumquat"', T, async () => {
    const hit = await mkDoc(be, { markdown: '# Fruit notes\n\nThe kumquat is a small citrus.\n', sessionName: 'Fruit notes' })
    await mkDoc(be, { markdown: '# Other\n\nApples only.\n' })
    const { context, page } = await open(be)
    const reqs = []
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/library/docs') reqs.push(new URL(r.url()).searchParams.get('q')) })
    try {
      await gotoLibrary(page)
      await until(async () => (await rows(page).count()) >= 2, { what: 'rows' })
      const box = page.locator(tid('library-search'))
      await box.click()
      reqs.length = 0
      await box.pressSequentially('k')
      await page.waitForTimeout(400)
      assert.ok(!reqs.includes('k'), 'a one-character query is ignored')
      const t0 = Date.now()
      await box.pressSequentially('umquat', { delay: 20 })
      await until(async () => here(page).searchParams.get('q') === 'kumquat', { timeout: 1000, step: 25, what: 'q=kumquat within 1 s' })
      await until(async () => (await rows(page).count()) === 1 && (await rowFor(page, hit.id).count()) === 1, { timeout: 1500, step: 25, what: 'only the kumquat row' })
      assert.ok(Date.now() - t0 < 1500 + 1000)
      const snip = rowFor(page, hit.id).locator(tid('library-row-snippet'))
      assert.equal((await snip.locator(tid('library-snippet-hit')).first().innerText()).toLowerCase(), 'kumquat')
      assert.equal(await snip.locator(`mark${tid('library-snippet-hit')}`).count() >= 1, true)
      // Esc in the box clears it.
      await box.press('Escape')
      await until(async () => here(page).searchParams.get('q') === null && (await rows(page).count()) >= 2, { what: 'cleared by Esc' })
    } finally { await context.close() }
  })

  it('AC-26.3 a body with <img onerror> is shown literally in the snippet; no img element inside it', T, async () => {
    const d = await mkDoc(be, { markdown: 'Text before <img src=x onerror=alert(1)>kumquat and after.\n', sessionName: 'Xss probe' })
    const { context, page, errors } = await open(be)
    try {
      // Real server path: the snippet keeps the raw inline HTML as text; it must show literally, never render.
      await gotoLibrary(page, '?q=kumquat')
      const snip = rowFor(page, d.id).locator(tid('library-row-snippet'))
      await snip.waitFor({ timeout: 10000 })
      assert.match(await snip.innerText(), /<img src=x onerror=alert\(1\)>kumquat/)
      assert.equal(await snip.locator('img').count(), 0)
      assert.equal(await snip.locator(tid('library-snippet-hit')).first().innerText(), 'kumquat')
      // Also with a stubbed response (independent of the server's snippet builder).
      await page.route((u) => u.pathname === '/library/docs', async (route) => {
        const u = new URL(route.request().url())
        const res = await route.fetch({ url: be.api + u.pathname + u.search })
        const body = await res.json()
        for (const it of body.items) {
          if (it.id === d.id && it.match) {
            it.match.snippet = [{ text: 'Text before <img src=x onerror=alert(1)>', hit: false }, { text: 'kumquat', hit: true }, { text: ' and after.', hit: false }]
          }
        }
        await route.fulfill({ response: res, json: body })
      })
      await page.reload()
      await snip.waitFor({ timeout: 10000 })
      assert.match(await snip.innerText(), /Text before <img src=x onerror=alert\(1\)>kumquat/)
      assert.equal(await snip.locator('img').count(), 0)
      assert.equal(await page.locator(`${tid('library-row')} img`).count(), 0)
      assert.equal(await snip.locator(tid('library-snippet-hit')).innerText(), 'kumquat')
      await page.waitForTimeout(300)
      assert.ok(!errors.some((e) => /native dialog/.test(e)), 'no alert ran')
    } finally { await context.close() }
  })

  it('AC-26.4 URL filters restore the controls and AND together; clear-filters → all docs, bare /library', T, async () => {
    const A = (await api(be, 'POST', '/library/collections', { name: uniq('ColA') })).json
    const B = (await api(be, 'POST', '/library/collections', { name: uniq('ColB') })).json
    assert.ok(A?.id && B?.id, 'collections created')
    const target = await mkDoc(be, { markdown: '# Target\n\nx\n', mode: 'review' })
    const wrongMode = await mkDoc(be, { markdown: '# Wrong mode\n\nx\n', mode: 'publish' })
    const wrongType = await mkDoc(be, { markdown: '<p>Wrong type</p>', filename: 'w.html', contentType: 'html', mode: 'review' })
    const wrongCol = await mkDoc(be, { markdown: '# Wrong col\n\nx\n', mode: 'review' })
    const noTag = await mkDoc(be, { markdown: '# No tag\n\nx\n', mode: 'review' })
    for (const d of [target, wrongMode, wrongType, noTag]) assert.equal((await api(be, 'PUT', `/paste/${d.id}/collection`, { collectionId: A.id })).status, 200)
    assert.equal((await api(be, 'PUT', `/paste/${wrongCol.id}/collection`, { collectionId: B.id })).status, 200)
    for (const d of [target, wrongMode, wrongType, wrongCol]) assert.equal((await api(be, 'PUT', `/paste/${d.id}/tags`, { tags: ['ops'] })).status, 200)
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page, `?collection=${A.id}&tag=ops&mode=review&type=md`)
      await until(async () => (await rows(page).count()) === 1, { timeout: 10000, what: 'one matching row' })
      assert.equal(await rowFor(page, target.id).count(), 1)
      assert.equal(await page.locator(tid('library-filter-collection')).inputValue(), A.id)
      assert.equal(await page.locator(tid('library-filter-tag')).inputValue(), 'ops')
      assert.equal(await page.locator(tid('library-filter-mode')).inputValue(), 'review')
      assert.equal(await page.locator(tid('library-filter-type')).inputValue(), 'md')
      await page.locator(tid('library-clear-filters')).first().click()
      const all = (await libDocs(be)).total
      await until(async () => (await rows(page).count()) === all, { what: 'all rows back' })
      assert.equal(here(page).pathname, '/library')
      assert.equal(here(page).search, '')
      // Changing a filter pushes history (Back restores the previous filter set).
      await page.locator(tid('library-filter-mode')).selectOption('review')
      await until(async () => here(page).searchParams.get('mode') === 'review', { what: 'mode=review' })
      await page.goBack()
      await until(async () => here(page).searchParams.get('mode') === null && (await page.locator(tid('library-filter-mode')).inputValue()) === '', { what: 'Back restores' })
      // A tag chip on a row sets tag=.
      await rowFor(page, target.id).locator('.lib-tag-name', { hasText: 'ops' }).first().click()
      await until(async () => here(page).searchParams.get('tag') === 'ops', { what: 'tag chip → tag=ops' })
    } finally { await context.close() }
  })

  it('AC-26.9 deleting a collection keeps its docs (Unfiled); a duplicate name (any case) shows library-collection-error', T, async () => {
    const name = `Ops${Math.random().toString(36).slice(2, 5)}`
    const ops = (await api(be, 'POST', '/library/collections', { name })).json
    const x = await mkDoc(be, { markdown: '# In Ops\n\nx\n' })
    await api(be, 'PUT', `/paste/${x.id}/collection`, { collectionId: ops.id })
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page)
      const side = page.locator(tid('library-collections'))
      const item = side.locator(tid('library-collection-item')).filter({ hasText: name })
      await item.waitFor({ timeout: 10000 })
      assert.match(await item.innerText(), /1/)
      // Duplicate name differing in case → inline error, nothing created.
      await side.locator(tid('library-collection-new')).click()
      const input = side.locator('input.lib-collection-input')
      await input.fill(name.toLowerCase())
      await input.press('Enter')
      await side.locator(tid('library-collection-error')).waitFor({ timeout: 5000 })
      const cols = (await api(be, 'GET', '/library/collections')).json
      assert.equal(cols.filter((c) => c.name.toLowerCase() === name.toLowerCase()).length, 1)
      await input.press('Escape')
      // Delete via the menu, confirm.
      await side.locator('.lib-col-row').filter({ hasText: name }).locator(tid('library-collection-menu')).click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      const dlg = page.locator(tid('library-confirm-dialog'))
      await dlg.waitFor()
      await dlg.locator(tid('library-confirm-ok')).click()
      await until(async () => (await side.locator(tid('library-collection-item')).filter({ hasText: name }).count()) === 0, { what: 'collection gone' })
      assert.equal((await api(be, 'GET', `/paste/${x.id}?fields=meta`)).status, 200, 'the doc still exists')
      await side.locator(tid('library-collection-item')).filter({ hasText: 'Unfiled' }).click()
      await until(async () => here(page).searchParams.get('collection') === 'none', { what: 'collection=none' })
      await rowFor(page, x.id).waitFor({ timeout: 10000 })
    } finally { await context.close() }
  })

  it('AC-26.10 inline tag " Q4 Plan " → chip q4-plan saved; a 33-char tag shows library-tag-error and is not saved', T, async () => {
    const d = await mkDoc(be, { markdown: '# Taggable\n\nx\n', sessionName: uniq('Taggable') })
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page)
      const row = rowFor(page, d.id)
      await row.waitFor({ timeout: 10000 })
      await row.locator(tid('library-row-tag-add')).click()
      const input = row.locator('input.lib-tag-input')
      await input.fill(' Q4 Plan ')
      await input.press('Enter')
      await row.locator('.lib-tag-name', { hasText: 'q4-plan' }).waitFor({ timeout: 5000 })
      const listed = await libDocs(be, 'tag=q4-plan')
      assert.ok(listed.items.some((i) => i.id === d.id), 'GET /library/docs?tag=q4-plan includes the doc')
      await row.locator(tid('library-row-tag-add')).click()
      await row.locator('input.lib-tag-input').fill('x'.repeat(33))
      await row.locator('input.lib-tag-input').press('Enter')
      await page.locator(tid('library-tag-error')).waitFor({ timeout: 5000 })
      const after = await libDocs(be, `q=${encodeURIComponent('Taggable')}`)
      const item = (await libDocs(be)).items.find((i) => i.id === d.id) ?? after.items.find((i) => i.id === d.id)
      assert.deepEqual(item.tags, ['q4-plan'], 'the long tag was not saved')
      // Remove the chip.
      await row.locator('.lib-tag', { hasText: 'q4-plan' }).locator(tid('library-tag-remove')).click()
      await until(async () => (await libDocs(be)).items.find((i) => i.id === d.id)?.tags.length === 0, { what: 'tag removed' })
    } finally { await context.close() }
  })

  it('a viewer (protected doc, no token) sees tag chips without add/remove controls', T, async () => {
    const p = await mkDoc(be, { markdown: '# Locked\n\nx\n', protected: true })
    await api(be, 'PUT', `/paste/${p.id}/tags`, { tags: ['locked'] }, { 'X-Edit-Token': p.editToken })
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page)
      const row = rowFor(page, p.id)
      await row.locator('.lib-tag-name', { hasText: 'locked' }).waitFor({ timeout: 10000 })
      assert.equal(await row.locator(tid('library-row-tag-add')).count(), 0)
      assert.equal(await row.locator(tid('library-tag-remove')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-26.6 Asha pins X → X in library-pinned, not in the main list; survives reload; Ben does not see it pinned', T, async () => {
    const x = await mkDoc(be, { markdown: '# Pin me\n\nx\n', sessionName: uniq('Pin me') })
    const { context, page } = await open(be, { reviewer: 'Asha' })
    try {
      await gotoLibrary(page)
      const toggle = rowFor(page, x.id).locator(tid('library-pin-toggle'))
      await toggle.waitFor({ timeout: 10000 })
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
      await toggle.click()
      const pinned = page.locator(tid('library-pinned'))
      await pinned.locator(`${tid('library-row')}[data-doc-id="${x.id}"]`).waitFor({ timeout: 5000 })
      assert.equal(await page.locator(`.library-list ${tid('library-row')}[data-doc-id="${x.id}"]`).count(), 0, 'not repeated in the main list')
      assert.equal(await pinned.locator(`[data-doc-id="${x.id}"] ${tid('library-pin-toggle')}`).getAttribute('aria-pressed'), 'true')
      await page.reload()
      await page.locator(`${tid('library-pinned')} [data-doc-id="${x.id}"]`).waitFor({ timeout: 10000 })
      // With a filter active the section is hidden and X shows in normal order, pressed.
      await page.locator(tid('library-filter-mode')).selectOption('publish')
      await until(async () => (await page.locator(tid('library-pinned')).count()) === 0, { what: 'pinned section hidden' })
      await until(async () => (await rowFor(page, x.id).locator(tid('library-pin-toggle')).getAttribute('aria-pressed').catch(() => null)) === 'true', { what: 'X pressed in the list' })
    } finally { await context.close() }
    const ben = await open(be, { reviewer: 'Ben' })
    try {
      await gotoLibrary(ben.page)
      const t = rowFor(ben.page, x.id).locator(tid('library-pin-toggle'))
      await t.waitFor({ timeout: 10000 })
      assert.equal(await t.getAttribute('aria-pressed'), 'false')
      assert.equal(await ben.page.locator(`${tid('library-pinned')} [data-doc-id="${x.id}"]`).count(), 0)
    } finally { await ben.context.close() }
  })

  it('AC-26.7 two anonymous pins move to "name:asha" when the reader sets the name', T, async () => {
    const d1 = await mkDoc(be, { markdown: '# Anon pin 1\n\nx\n' })
    const d2 = await mkDoc(be, { markdown: '# Anon pin 2\n\nx\n' })
    const { context, page } = await open(be)
    try {
      await gotoLibrary(page)
      for (const d of [d1, d2]) {
        const t = rowFor(page, d.id).locator(tid('library-pin-toggle'))
        await t.waitFor({ timeout: 10000 })
        await t.click()
        await page.locator(`${tid('library-pinned')} [data-doc-id="${d.id}"]`).waitFor({ timeout: 5000 })
      }
      await page.locator(tid('reviewer-name')).click()
      await page.locator(tid('reviewer-input')).fill('Asha')
      await page.locator(tid('reviewer-input')).press('Enter')
      const got = await until(async () => {
        const r = await api(be, 'GET', '/library/pins', undefined, { 'X-MdReview-Reader': 'name%3Aasha' })
        const ids = (r.json ?? []).map((p) => p.docId)
        return ids.includes(d1.id) && ids.includes(d2.id) ? ids : null
      }, { timeout: 5000, what: 'merged pins' })
      assert.ok(got.length >= 2)
      // The page now shows the name's pins.
      await page.locator(`${tid('library-pinned')} [data-doc-id="${d1.id}"]`).waitFor({ timeout: 5000 })
    } finally { await context.close() }
  })

  it('AC-26.8 opening A then B → recent items B, A; absent with q', T, async () => {
    const A = await mkDoc(be, { markdown: '# Recent Alpha\n\nAlpha body.\n' })
    const B = await mkDoc(be, { markdown: '# Recent Beta\n\nBeta body.\n' })
    const { context, page } = await open(be)
    try {
      await page.goto(`${BASE}/d/${A.slug || A.id}`)
      await page.locator('.preview-pane').getByText('Alpha body.').waitFor({ timeout: 15000 })
      await page.goto(`${BASE}/d/${B.slug || B.id}`)
      await page.locator('.preview-pane').getByText('Beta body.').waitFor({ timeout: 15000 })
      await until(async () => (await page.evaluate(() => localStorage.getItem('md-review-recent') || '')).includes(B.id), { what: 'B recorded' })
      await gotoLibrary(page)
      const items = page.locator(`${tid('library-recent')} ${tid('library-recent-item')}`)
      await items.first().waitFor({ timeout: 10000 })
      const texts = await items.allInnerTexts()
      assert.match(texts[0], /Recent Beta/)
      assert.match(texts[1], /Recent Alpha/)
      const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('md-review-recent')))
      assert.deepEqual(Object.keys(stored[0]).sort(), ['id', 'slug', 'title', 'viewedAt'])
      await page.locator(tid('library-search')).fill('alpha')
      await until(async () => here(page).searchParams.get('q') === 'alpha', { what: 'q=alpha' })
      await until(async () => (await page.locator(tid('library-recent')).count()) === 0, { what: 'recent hidden with q' })
    } finally { await context.close() }
  })

  it('a recent entry for a doc deleted elsewhere opens the doc view\'s not-found state (not a local copy)', T, async () => {
    const G = await mkDoc(be, { markdown: '# Recent Gone\n\nGone body.\n' })
    const { context, page } = await open(be)
    try {
      await page.goto(`${BASE}/d/${G.slug || G.id}`)
      await page.locator('.preview-pane').getByText('Gone body.').waitFor({ timeout: 15000 })
      await until(async () => (await page.evaluate(() => localStorage.getItem('md-review-recent') || '')).includes(G.id), { what: 'G recorded' })
      await page.waitForTimeout(800) // the local draft is persisted (clean) by now
      assert.equal((await api(be, 'DELETE', `/paste/${G.id}`)).status, 204)
      await gotoLibrary(page)
      const item = page.locator(`${tid('library-recent')} ${tid('library-recent-item')}`).filter({ hasText: 'Recent Gone' })
      await item.waitFor({ timeout: 10000 })
      await item.click()
      await page.locator(tid('doc-not-found')).waitFor({ timeout: 10000 })
      assert.equal(here(page).pathname, `/d/${G.slug || G.id}`, 'stays on the doc URL')
      assert.equal(await page.locator('.notice-bar', { hasText: 'local copy' }).count(), 0, 'no local-copy fallback for a clean draft')
    } finally { await context.close() }
  })

  it('AC-26.11 bulk delete: cancel deletes nothing; confirm deletes the 2 editable docs, skips 1 protected with a toast', T, async () => {
    const tag = uniq('bulk').toLowerCase()
    const e1 = await mkDoc(be, { markdown: '# Bulk one\n\nx\n' })
    const e2 = await mkDoc(be, { markdown: '# Bulk two\n\nx\n' })
    const p = await mkDoc(be, { markdown: '# Bulk locked\n\nx\n', protected: true })
    for (const d of [e1, e2]) await api(be, 'PUT', `/paste/${d.id}/tags`, { tags: [tag] })
    await api(be, 'PUT', `/paste/${p.id}/tags`, { tags: [tag] }, { 'X-Edit-Token': p.editToken })
    const { context, page, errors } = await open(be)
    try {
      await gotoLibrary(page, `?tag=${tag}`)
      await until(async () => (await rows(page).count()) === 3, { timeout: 10000, what: '3 tagged rows' })
      await page.locator(tid('library-select-all')).check()
      const bar = page.locator(tid('library-bulk-bar'))
      await bar.waitFor()
      assert.match(await bar.innerText(), /3 selected/)
      await bar.locator(tid('library-bulk-delete')).click()
      const dlg = page.locator(tid('library-confirm-dialog'))
      await dlg.waitFor()
      assert.match(await dlg.innerText(), /Delete 3 documents\? This cannot be undone\./)
      // FE review: the destructive confirm starts on Cancel, so Enter never deletes by accident.
      await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'library-confirm-cancel', { what: 'focus on Cancel' })
      await dlg.locator(tid('library-confirm-cancel')).click()
      await dlg.waitFor({ state: 'detached' })
      for (const d of [e1, e2, p]) assert.equal((await api(be, 'GET', `/paste/${d.id}?fields=meta`)).status, 200, 'cancel deletes nothing')
      await bar.locator(tid('library-bulk-delete')).click()
      await dlg.locator(tid('library-confirm-ok')).click()
      await page.locator(tid('app-toast')).filter({ hasText: '1 skipped — no edit access' }).waitFor({ timeout: 10000 })
      assert.equal((await api(be, 'GET', `/paste/${e1.id}`)).status, 404)
      assert.equal((await api(be, 'GET', `/paste/${e2.id}`)).status, 404)
      assert.equal((await api(be, 'GET', `/paste/${p.id}?fields=meta`)).status, 200)
      await until(async () => (await rows(page).count()) === 1, { what: 'list refreshed' })
      assert.equal(await page.locator(tid('library-bulk-bar')).count(), 0, 'selection cleared')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-26.14 phone 390×844: cards, filters sheet via library-filters-toggle, no horizontal scroll', T, async () => {
    const d = await mkDoc(be, { markdown: '# A phone card with a rather long title that must wrap or truncate nicely\n\nx\n', mode: 'review' })
    await api(be, 'PUT', `/paste/${d.id}/tags`, { tags: ['phone', 'mobile-layout', 'ops'] })
    const { context, page } = await open(be, { viewport: PHONE })
    try {
      await gotoLibrary(page)
      const row = rowFor(page, d.id)
      await row.waitFor({ timeout: 10000 })
      // Card: title, then badges + updated, then tags — stacked.
      const title = await row.locator('.library-row-title').boundingBox()
      const badge = await row.locator('[data-mode]').boundingBox()
      const tagChip = await row.locator('.lib-tag').first().boundingBox()
      assert.ok(badge.y >= title.y + title.height - 1, `badges below the title (${JSON.stringify({ title, badge })})`)
      assert.ok(tagChip.y >= badge.y + badge.height - 1, 'tags below the badges')
      assert.ok(await page.locator(tid('library-search')).isVisible(), 'search stays visible')
      assert.ok(await page.locator(tid('library-sort')).isVisible(), 'sort stays visible')
      assert.equal(await page.locator(tid('library-filter-mode')).isVisible(), false, 'filters are in the sheet')
      assert.equal(await page.locator(tid('library-collections')).isVisible(), false, 'collections are in the sheet')
      await page.locator(tid('library-filters-toggle')).click()
      await page.locator(tid('library-filter-mode')).waitFor({ state: 'visible', timeout: 3000 })
      assert.ok(await page.locator(tid('library-collections')).isVisible())
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll (sheet open)')
      await page.keyboard.press('Escape')
      await page.locator(tid('library-filter-mode')).waitFor({ state: 'hidden', timeout: 3000 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll')
    } finally { await context.close() }
  })

  it('phone cards have no empty band (a card without tags is two lines tall); "Set your name" is not clipped', T, async () => {
    const bare = await mkDoc(be, { markdown: '# Bare phone card\n\nx\n', protected: true }) // viewer: no tags, no "+ tag"
    const tagged = await mkDoc(be, { markdown: '# Tagged phone card\n\nx\n' })
    await api(be, 'PUT', `/paste/${tagged.id}/tags`, { tags: ['ops'] })
    const { context, page } = await open(be, { viewport: PHONE })
    try {
      await gotoLibrary(page)
      for (const d of [bare, tagged]) await rowFor(page, d.id).waitFor({ timeout: 10000 })
      // The space under the last line of a card is just its padding (no ~80 px band).
      const band = (id) => rowFor(page, id).evaluate((row) => {
        const lines = [...row.querySelectorAll('.lib-line')].map((l) => l.getBoundingClientRect().bottom)
        return row.getBoundingClientRect().bottom - Math.max(...lines)
      })
      for (const d of [bare, tagged]) {
        const b = await band(d.id)
        assert.ok(b <= 16, `card ${d.id}: ${b}px under its last line`)
      }
      assert.equal(await rowFor(page, bare.id).locator('.lib-line-tags').count(), 0, 'no empty tags line')
      const hb = (await rowFor(page, bare.id).boundingBox()).height
      const ht = (await rowFor(page, tagged.id).boundingBox()).height
      assert.ok(hb < ht, `the bare card (${hb}) is shorter than the tagged one (${ht})`)
      // QA c2: the reviewer-name button shows its whole label.
      const name = page.locator(`.lib-header ${tid('reviewer-name')}`)
      assert.match(await name.innerText(), /Set your name/)
      assert.ok(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), '"Set your name" is not clipped')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll')
    } finally { await context.close() }
  })
})

// ── 600 docs: paging + the DOM row cap ──
describe('#26 library — 600 docs', () => {
  let be
  before(async () => {
    be = await privateBackend()
    const N = 600
    let next = 0
    // every third doc is token-protected: a viewer's phone card is shorter (no tags line), so heights mix
    const worker = async () => { while (next < N) { const i = next++; await mkDoc(be, { markdown: `# Doc ${String(i).padStart(3, '0')}\n\nBody ${i}.\n`, protected: i % 3 === 0 }) } }
    await Promise.all(Array.from({ length: 8 }, worker))
  })
  after(async () => { await be?.stop() })

  for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) it(`AC-26.12 (${label}) all 600 reachable by scrolling; "600 documents"; never more than 120 library-row in the DOM`, { timeout: 300_000 }, async () => {
    const { context, page } = await open(be, { viewport })
    try {
      await page.addInitScript(() => {
        window.__maxRows = 0
        const obs = new MutationObserver(() => {
          const n = document.querySelectorAll('[data-testid="library-row"]').length
          if (n > window.__maxRows) window.__maxRows = n
        })
        document.addEventListener('DOMContentLoaded', () => obs.observe(document.body, { childList: true, subtree: true }))
      })
      await gotoLibrary(page)
      await until(async () => (await rows(page).count()) > 0, { timeout: 15000, what: 'first rows' })
      assert.equal((await page.locator(tid('library-count')).innerText()).trim(), '600 documents')
      const seen = new Set()
      for (let step = 0; step < 400 && seen.size < 600; step++) {
        const ids = await page.locator(tid('library-row')).evaluateAll((els) => els.map((e) => e.getAttribute('data-doc-id')))
        for (const id of ids) seen.add(id)
        assert.ok(ids.length <= 120, `at most 120 rows in the DOM (step ${step}: ${ids.length})`)
        if (label === 'phone') {
          // mixed card heights: every card is exactly one of the two modelled heights (76 / 104 px + the 8 px gap),
          // so the virtual offsets (sums of the modelled heights) put the window where the cards really are
          const hs = await page.locator(`.library-list ${tid('library-row')}`).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
          assert.ok(hs.every((h) => h === 76 || h === 104), `card heights (step ${step}): ${[...new Set(hs)]}`)
          assert.ok(new Set(hs).size === 2 || hs.length < 3, 'both card heights occur')
        }
        const atEnd = await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4)
        if (atEnd) {
          const more = page.locator(tid('library-load-more'))
          if (await more.isVisible().catch(() => false)) await more.click().catch(() => {})
          await page.waitForTimeout(250)
        }
        await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.2)))
        await page.waitForTimeout(60)
      }
      assert.equal(seen.size, 600, 'every doc was rendered at some point')
      // the last card ends where the list ends (offsets and real heights agree all the way down)
      const tail = await page.evaluate(() => {
        const list = document.querySelector('.library-list')
        const rs = [...list.querySelectorAll('[data-testid="library-row"]')].map((e) => e.getBoundingClientRect().bottom)
        return list.getBoundingClientRect().bottom - Math.max(...rs)
      })
      assert.ok(tail >= -1 && tail <= 10, `list bottom − last row bottom: ${tail}`)
      assert.ok(await page.evaluate(() => window.__maxRows) <= 120, `max rows ever in the DOM: ${await page.evaluate(() => window.__maxRows)}`)
    } finally { await context.close() }
  })
})
