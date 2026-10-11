// Persona-QA (librarian) BLOCKER 1: a stored edit token was wiped on any full page load of
// /d/<slug> (reload, new tab, bookmark, typed URL). Tokens are stored by id; the slug → id alias
// lived in memory only, so the first GET after a full load went out without X-Edit-Token, the
// server answered can_edit: false and the token was dropped as "refused".
// Covers a token from ?edit=, a doc made with "New from template", and one shared from the UI.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, API } from '../helpers.mjs'
import { createProtectedDoc, uniq, tid, editTokens } from './23-lib.mjs'

const T = { timeout: 120_000 }
const tmp = mkdtempSync(join(tmpdir(), 'qa-lib-tokens-'))

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

/** A context whose pages record, per page, the X-Edit-Token of every GET /paste/<key>. */
async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  context.on('page', (p) => watch(p))
  const page = await context.newPage()
  function watch(p) {
    p.__docGets = []
    p.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
    p.on('dialog', (d) => d.accept().catch(() => {}))
    p.on('request', (r) => {
      if (r.method() !== 'GET' || !r.url().startsWith(API)) return
      if (!/^\/paste\/[^/]+$/.test(new URL(r.url()).pathname)) return
      p.__docGets.push({ path: new URL(r.url()).pathname, token: r.headers()['x-edit-token'] ?? null })
    })
  }
  return { context, page, errors }
}

const capability = (page) => page.locator('.app').first().getAttribute('data-capability')

/** Wait for the doc to be on screen and its capability settled to `want`. */
async function expectCapability(page, want, what) {
  await page.locator('.preview-pane, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
  try {
    await page.waitForFunction((w) => document.querySelector('.app')?.getAttribute('data-capability') === w, want, { timeout: 10_000 })
  } catch {
    assert.fail(`${what}: capability ${await capability(page)}, want ${want}; tokens ${JSON.stringify(await editTokens(page))}; GETs ${JSON.stringify(page.__docGets)}`)
  }
  // Give a late refusal (the bug dropped the token after the first GET) the time to land.
  await page.waitForTimeout(600)
  assert.equal(await capability(page), want, `${what}: capability stays ${want}`)
}

/** Full-load the doc's URL several ways and assert editor + token held each time. */
async function survivesFullLoads(context, page, doc, label) {
  const key = doc.slug || doc.id
  // 1. reload
  page.__docGets = []
  await page.reload()
  await expectCapability(page, 'editor', `${label}: after reload`)
  assert.equal(page.__docGets[0]?.token, doc.editToken, `${label}: the first GET after reload presents the token (${JSON.stringify(page.__docGets)})`)
  assert.equal((await editTokens(page))[doc.id], doc.editToken, `${label}: token still stored after reload`)
  // 2. new tab
  const tab = await context.newPage()
  await tab.goto(`${BASE}/d/${key}`)
  await expectCapability(tab, 'editor', `${label}: new tab`)
  assert.equal(tab.__docGets[0]?.token, doc.editToken, `${label}: the new tab's first GET presents the token`)
  await tab.close()
  // 3. bookmark / typed URL (a full navigation from another page of the app)
  await page.goto(`${BASE}/library`)
  await page.locator(tid('library-view')).or(page.locator('main')).first().waitFor({ timeout: 15_000 })
  await page.goto(`${BASE}/d/${key}`)
  await expectCapability(page, 'editor', `${label}: typed URL`)
  // 4. by id
  if (doc.slug) {
    await page.goto(`${BASE}/d/${doc.id}`)
    await expectCapability(page, 'editor', `${label}: by id`)
  }
  assert.equal((await editTokens(page))[doc.id], doc.editToken, `${label}: token still stored at the end`)
}

describe('qa-lib BLOCKER 1 — a stored edit token survives full page loads', () => {
  it('token from ?edit=: reload, new tab, typed URL and by-id stay editor', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Reload token'), markdown: '# Reload token\n\nBody for the reload test.\n' })
    assert.ok(doc.slug)
    const { context, page, errors } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}`)
      await expectCapability(page, 'editor', 'edit link')
      await survivesFullLoads(context, page, doc, '?edit=')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('a stored token whose slug alias is unknown (stored before the fix) is presented on a retry, not dropped', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Legacy store'), markdown: '# Legacy store\n\nOld storage shape.\n' })
    const { context, page } = await open()
    try {
      await context.addInitScript(([id, t]) => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('md-review-edit-tokens', JSON.stringify({ [id]: t }))
          sessionStorage.setItem('seeded', '1')
        }
      }, [doc.id, doc.editToken])
      await page.goto(`${BASE}/d/${doc.slug}`)
      await expectCapability(page, 'editor', 'id-only stored token')
      assert.equal((await editTokens(page))[doc.id], doc.editToken)
      page.__docGets = []
      await page.reload()
      await expectCapability(page, 'editor', 'id-only stored token, reload')
      assert.equal(page.__docGets[0]?.token, doc.editToken, 'the slug alias is now persisted: the first GET carries the token')
    } finally { await context.close() }
  })

  it('doc made with "New from template": reload and new tab stay editor', T, async () => {
    const { context, page, errors } = await open()
    try {
      await page.goto(`${BASE}/`)
      await page.locator(tid('landing-new-from-template')).click()
      await page.locator(tid('template-picker-item')).first().waitFor({ timeout: 10_000 })
      await page.locator(tid('template-picker-item')).filter({ hasText: 'Design doc' }).first().click()
      const title = uniq('Tpl reload')
      await page.locator(tid('template-title-input')).fill(title)
      await page.locator(tid('template-title-input')).press('Enter')
      await page.waitForFunction(() => /^\/d\/[^/]+$/.test(location.pathname), null, { timeout: 15_000 })
      await expectCapability(page, 'editor', 'new from template')
      const key = new URL(page.url()).pathname.split('/').pop()
      const meta = await (await fetch(`${API}/paste/${key}?fields=meta`)).json()
      const editToken = (await editTokens(page))[meta.id]
      assert.ok(editToken, 'the creator holds the token')
      await survivesFullLoads(context, page, { id: meta.id, slug: meta.slug ?? key, editToken }, 'template')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('doc shared from the UI (local doc → Share): reload and new tab stay editor', T, async () => {
    const p = join(tmp, `ui-share-${Date.now()}.md`)
    writeFileSync(p, `# ${uniq('UI share')}\n\nShared from the UI.\n`)
    const { context, page, errors } = await open()
    try {
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(p)}`)
      await page.locator('.preview-pane, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
      await page.locator(tid('share-btn')).first().click()
      await page.locator(tid('share-dialog')).waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(() => /^\/d\/[^/]+$/.test(location.pathname), null, { timeout: 15_000 })
      await page.keyboard.press('Escape')
      const key = new URL(page.url()).pathname.split('/').pop()
      const meta = await (await fetch(`${API}/paste/${key}?fields=meta`)).json()
      assert.equal(meta.access?.protected, true)
      const editToken = (await editTokens(page))[meta.id]
      assert.ok(editToken, 'the sharer holds the token')
      await survivesFullLoads(context, page, { id: meta.id, slug: meta.slug ?? null, editToken }, 'ui share')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
})
