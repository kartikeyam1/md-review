// #23 View link vs edit link, edit tokens, expiry picker — frozen acceptance tests (browser half).
// Spec: docs/build/specs/23-view-edit-links.md rules 9–10 (+ 00 §1.2 capability, §2.2 header,
// §3.1 AppToast, §6 FE-built links, §10.1 testids, §10.3 localStorage). The server half
// (AC-23.1–23.7, 23.12, 23.13) is in server/test-items/23-*.test.mjs.
//
// Runs on vite dev at base `/` (scripts/verify.sh) and needs #4's routes (/d/<slug||id>, ?view=,
// the ?edit= hook), #2's header/capability/AppToast and #6's lazy editor (.cm-content). Legacy docs
// (AC-23.14) are made by clearing edit_token_hash in the backend's SQLite DB (E2E_DATA_DIR).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import {
  uniq, tid, DAY, TOKEN_RE, createDoc, createProtectedDoc, makeLegacy, serverDoc, serverMarkdown, rawPut, rotateToken,
  installRecorder, recorded, editTokens, valueOf, draftText, holdDocGets, expiryOptions, pickExpiry, dateForms,
} from './23-lib.mjs'

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open({ viewport = { width: 1400, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  await installRecorder(context)
  const page = await context.newPage()
  return { context, page }
}

const key = (d) => d.slug || d.id
const viewLink = (d) => `${BASE}/d/${key(d)}`
const appAttr = (page, name) => page.locator('.app').first().getAttribute(`data-${name}`)
const isDocWrite = (re) => (req) => req.url().startsWith(API) && re.test(new URL(req.url()).pathname)
const pathRe = (d, suffix) => new RegExp(`^/paste/(${d.id}${d.slug ? `|${d.slug}` : ''})${suffix}$`)

async function waitForDoc(page, text, timeout = 15000) {
  await page.locator('.preview-pane').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout })
}
async function waitForEditor(page) {
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
}
async function openOverflow(page) {
  const menu = page.locator(tid('header-overflow-menu'))
  if (!(await menu.isVisible().catch(() => false))) await page.locator(tid('header-overflow-btn')).click()
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  return menu
}
async function openShareDialog(page) {
  await page.locator(tid('share-btn')).click()
  const dlg = page.locator(tid('share-dialog'))
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  return dlg
}
const lastClip = async (page) => (await recorded(page)).clipboard.at(-1)

// ── rule 9: token capture and URL stripping ─────────────────────────────────
describe('#23 rule 9 — ?edit= token handling', () => {
  it('AC-23.8 /d/<slug>?edit=<token>&view=split#intro → URL becomes /d/<slug>?view=split#intro, token stored, editor available', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Edit link'), markdown: '# Edit link\n\n## Intro\n\nIntro text for AC-23.8.\n' })
    assert.ok(doc.slug)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}&view=split#intro`)
      await waitForDoc(page, 'Intro text for AC-23.8.')
      await page.waitForFunction(() => !location.search.includes('edit='), null, { timeout: 5000 })
      const loc = await page.evaluate(() => ({ pathname: location.pathname, search: location.search, hash: location.hash, href: location.href, state: JSON.stringify(history.state) ?? '' }))
      assert.equal(loc.pathname, `/d/${doc.slug}`)
      assert.equal(loc.search, '?view=split', 'edit removed, other params kept')
      assert.equal(loc.hash, '#intro', 'fragment kept')
      assert.ok(!loc.href.includes(doc.editToken), 'token gone from the URL')
      assert.ok(!loc.state.includes(doc.editToken), 'token not in history.state')
      for (const e of (await recorded(page)).log) {
        assert.ok(!e.state?.includes(doc.editToken), `no history entry carries the token in its state: ${e.state}`)
      }
      const map = await editTokens(page)
      assert.equal(map[doc.id], doc.editToken, `localStorage md-review-edit-tokens[${doc.id}]: ${JSON.stringify(map)}`)
      assert.equal(await appAttr(page, 'capability'), 'editor')
      await page.locator(tid('view-toggle')).waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(tid('view-toggle-edit')).click()
      await waitForEditor(page)
      assert.ok(!(await page.evaluate(() => location.href)).includes(doc.editToken), 'token never comes back into the URL')
    } finally { await context.close() }
  })

  it('AC-23.8 (rule 9) editor writes carry X-Edit-Token and land on the server', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Token writes'), markdown: '# Token writes\n\nOriginal line.\n' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      const marker = uniq('TYPED')
      const put = page.waitForRequest((req) => req.method() === 'PUT' && isDocWrite(pathRe(doc, '/markdown'))(req), { timeout: 15000 })
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(`\n\n${marker}`)
      await page.keyboard.press('Control+s')
      const req = await put
      assert.equal(req.headers()['x-edit-token'], doc.editToken, 'PUT /markdown carries X-Edit-Token')
      const res = await req.response()
      assert.equal(res.status(), 200)
      const deadline = Date.now() + 10000
      while (!(await serverMarkdown(doc.id)).includes(marker) && Date.now() < deadline) await page.waitForTimeout(200)
      assert.ok((await serverMarkdown(doc.id)).includes(marker), 'the edit reached the server')
    } finally { await context.close() }
  })

  it('EDGE-23 a ?edit= token for a different doc is not stored under that doc and grants nothing', T, async () => {
    const a = await createProtectedDoc({ sessionName: uniq('Doc A'), markdown: '# Doc A\n\nText of A.\n' })
    const b = await createProtectedDoc({ sessionName: uniq('Doc B'), markdown: '# Doc B\n\nText of B.\n' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${a.slug}?edit=${b.editToken}`)
      await waitForDoc(page, 'Text of A.')
      await page.waitForFunction(() => !location.search.includes('edit='), null, { timeout: 5000 })
      // Let the doc's GET (with the presented token) settle before judging capability.
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-capability') === 'viewer', null, { timeout: 10000 })
      const map = await editTokens(page)
      assert.ok(!(b.id in map) && !(b.slug in map), `nothing stored under doc B: ${JSON.stringify(map)}`)
      assert.equal(await page.locator(tid('view-toggle')).count(), 0, 'no edit affordance on A')
      assert.equal(await page.locator(tid('share-btn')).count(), 0)
    } finally { await context.close() }
  })
})

// ── viewer capability ──────────────────────────────────────────────────────
describe('#23 rule 9 — a protected doc without a token is view-only', () => {
  it('AC-23.9 /d/<slug> without a token: no edit affordance, viewer capability, copy-link copies the plain view link', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Viewer doc'), markdown: '# Viewer doc\n\nRevision one text.\n', mode: 'review' })
    const w = await rawPut(doc.id, '# Viewer doc\n\nRevision two text.\n', doc.editToken)
    assert.equal(w.status, 200, 'setup: second revision via the token')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}`)
      await waitForDoc(page, 'Revision two text.')
      await page.locator(tid('doc-header')).first().waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-capability') === 'viewer', null, { timeout: 10000 })
      assert.equal(await page.locator('.app[data-capability="viewer"]').count(), 1)
      assert.equal(await page.locator(tid('view-toggle')).count(), 0, 'view-toggle absent')
      assert.equal(await page.locator(tid('share-btn')).count(), 0, 'share-btn absent')

      const menu = await openOverflow(page)
      assert.equal(await menu.locator(tid('doc-mode-publish')).count(), 0, 'mode radio publish absent')
      assert.equal(await menu.locator(tid('doc-mode-review')).count(), 0, 'mode radio review absent')
      assert.equal(await page.locator(tid('share-btn')).count(), 0, 'share-btn not in the overflow either')
      const revs = page.waitForResponse((r) => r.url().startsWith(API) && /^\/paste\/[^/]+\/revisions$/.test(new URL(r.url()).pathname), { timeout: 10000 })
      await menu.locator(tid('menu-history')).click()
      await page.locator(tid('revisions-modal')).waitFor({ state: 'visible', timeout: 5000 })
      await revs
      await page.waitForTimeout(300) // let the list render
      assert.equal(await page.locator(tid('restore-revision')).count(), 0, 'restore-revision absent')
      await page.keyboard.press('Escape')
      await page.locator(tid('revisions-modal')).waitFor({ state: 'hidden', timeout: 5000 })

      await page.locator(tid('copy-link-btn')).click()
      await page.waitForFunction(() => (window.__mdr23?.clipboard?.length ?? 0) > 0, null, { timeout: 5000 })
      const copied = await lastClip(page)
      assert.equal(copied, `${BASE}/d/${doc.slug}`, 'copy-link copies <origin><base>d/<slug>')
      assert.ok(!copied.includes('edit'), 'no edit param')
      assert.deepEqual(await editTokens(page), {}, 'no token stored')
    } finally { await context.close() }
  })

  it('AC-23.9 (00 §1.3) a viewer asking for ?view=edit gets the read view and view=read in the URL', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Viewer edit'), markdown: '# Viewer edit\n\nNo editing here.\n' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}?view=edit`)
      await waitForDoc(page, 'No editing here.')
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 10000 })
      assert.equal(await appAttr(page, 'view'), 'read')
      assert.equal(await appAttr(page, 'capability'), 'viewer')
      assert.equal(await page.locator('.cm-content').count(), 0, 'no editor for a viewer')
    } finally { await context.close() }
  })
})

// ── rule 10: share dialog ──────────────────────────────────────────────────
describe('#23 rule 10 — share dialog', () => {
  it('AC-23.10 (rule 10) an editor sees the view link, the edit link under the warning, and both copy buttons work', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Share links'), markdown: '# Share links\n\nShare body.\n' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}`)
      await waitForDoc(page, 'Share body.')
      const dlg = await openShareDialog(page)
      const view = viewLink(doc)
      assert.equal(await valueOf(dlg.locator(tid('share-view-url'))), view, 'view link = <origin><base>d/<slug>')
      assert.equal(await valueOf(dlg.locator(tid('share-edit-url'))), `${view}?edit=${doc.editToken}`, 'edit link = view link + ?edit=<token>')
      assert.match(await dlg.locator(tid('share-edit-warning')).innerText(), /Anyone with this link can edit/)
      await dlg.locator(tid('share-copy-view')).click()
      await page.waitForFunction(() => (window.__mdr23?.clipboard?.length ?? 0) >= 1, null, { timeout: 5000 })
      assert.equal(await lastClip(page), view, 'share-copy-view copies the view link')
      await dlg.locator(tid('share-copy-edit')).click()
      await page.waitForFunction(() => (window.__mdr23?.clipboard?.length ?? 0) >= 2, null, { timeout: 5000 })
      assert.equal(await lastClip(page), `${view}?edit=${doc.editToken}`, 'share-copy-edit copies the edit link')
      assert.equal(await dlg.locator(tid('share-protect-btn')).count(), 0, 'no "Make view-only" on a protected doc')
    } finally { await context.close() }
  })

  it('AC-23.10 picking "7 days" sends PUT /meta with X-Edit-Token and expiry_days:7; the label shows the date 7 days ahead', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Expiry'), markdown: '# Expiry\n\nExpiry body.\n', expiry_days: null })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}`)
      await waitForDoc(page, 'Expiry body.')
      const dlg = await openShareDialog(page)
      const { labels, selected } = await expiryOptions(page)
      assert.deepEqual(labels, ['1 day', '7 days', '30 days', '90 days', 'Never'], 'options in order')
      assert.equal(selected, 'Never', 'current value preselected (a never-expiring doc)')
      assert.match(await dlg.locator(tid('share-expiry-label')).innerText(), /Never expires/)

      const metaPut = page.waitForRequest((req) => req.method() === 'PUT' && isDocWrite(pathRe(doc, '/meta'))(req), { timeout: 10000 })
      await pickExpiry(page, '7 days')
      const req = await metaPut
      assert.equal(req.headers()['x-edit-token'], doc.editToken, 'PUT /meta carries X-Edit-Token')
      assert.equal(JSON.parse(req.postData() || '{}').expiry_days, 7, 'body expiry_days:7')
      assert.equal((await req.response()).status(), 200)

      const label = dlg.locator(tid('share-expiry-label'))
      await page.waitForFunction((sel) => /Expires/.test(document.querySelector(sel)?.textContent || ''), `[data-testid="share-expiry-label"]`, { timeout: 5000 })
      const text = await label.innerText()
      const f = await dateForms(page, 7)
      assert.ok(f.full.some((s) => text.includes(s)) || (new RegExp(`(^|\\D)${f.day}(\\D|$)`).test(text) && f.months.some((m) => text.includes(m))),
        `"${text}" shows the date 7 days ahead (${f.full.join(' | ')})`)
      const meta = await serverDoc(doc.id, doc.editToken)
      assert.ok(Math.abs(Date.parse(meta.expires_at) - (Date.now() + 7 * DAY)) < 2 * 60000, `server expires_at ${meta.expires_at}`)
    } finally { await context.close() }
  })

  it('AC-23.14 a legacy doc shows one "Anyone with this link can edit" link; "Make view-only" claims it, shows both links, and token-less writes then get 401', T, async () => {
    const doc = await createDoc({ sessionName: uniq('Legacy share'), markdown: '# Legacy share\n\nLegacy body.\n' })
    await makeLegacy(doc.id)
    const meta = await serverDoc(doc.id)
    assert.equal(meta.access?.protected, false, `precondition: legacy doc (access ${JSON.stringify(meta.access)})`)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}`)
      await waitForDoc(page, 'Legacy body.')
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-capability') === 'editor', null, { timeout: 10000 })
      const dlg = await openShareDialog(page)
      assert.equal(await valueOf(dlg.locator(tid('share-view-url'))), viewLink(doc), 'the single link')
      assert.match(await dlg.innerText(), /Anyone with this link can edit/, 'labelled link-editable')
      assert.equal(await dlg.locator(tid('share-edit-url')).count(), 0, 'no separate edit link yet')
      assert.equal(await dlg.locator(tid('share-expiry-select')).count(), 1, 'editors see the expiry picker')

      const claim = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().startsWith(API) && pathRe(doc, '/edit-token').test(new URL(r.url()).pathname), { timeout: 10000 })
      await dlg.locator(tid('share-protect-btn')).click()
      const res = await claim
      assert.equal(res.status(), 200)
      const token = (await res.json()).editToken
      assert.match(String(token), TOKEN_RE)

      await dlg.locator(tid('share-edit-url')).waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await valueOf(dlg.locator(tid('share-view-url'))), viewLink(doc), 'view link')
      assert.equal(await valueOf(dlg.locator(tid('share-edit-url'))), `${viewLink(doc)}?edit=${token}`, 'edit link')
      assert.match(await dlg.locator(tid('share-edit-warning')).innerText(), /Anyone with this link can edit/)
      assert.equal((await editTokens(page))[doc.id], token, 'the claimed token is kept in this browser')

      const other = await rawPut(doc.id, 'token-less write from another client')
      assert.equal(other.status, 401, `token-less PUT /markdown after "Make view-only": ${other.status} ${other.text}`)
      assert.equal(other.json?.code, 'edit_token_required')
      assert.equal((await serverDoc(doc.id)).access?.protected, true)
    } finally { await context.close() }
  })
})

// ── rule 9: a rejected token ───────────────────────────────────────────────
describe('#23 rule 9 — the server rejects the stored token', () => {
  it('AC-23.11 after a rotation elsewhere, saving shows the view-only toast, drops the token and switches to read mode keeping the draft', T, async () => {
    const doc = await createProtectedDoc({ sessionName: uniq('Rotated'), markdown: '# Rotated\n\nBefore rotation.\n' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      assert.equal((await editTokens(page))[doc.id], doc.editToken, 'precondition: token stored')

      // Freeze the app's view of the doc (no poll may flip capability first), then rotate elsewhere.
      const gate = await holdDocGets(page, [doc.id, doc.slug])
      gate.close()
      const rot = await rotateToken(doc.id, doc.editToken)
      assert.equal(rot.status, 200, `rotation: ${rot.status} ${rot.text}`)

      const marker = uniq('UNSAVED')
      const rejected = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().startsWith(API) && pathRe(doc, '/markdown').test(new URL(r.url()).pathname), { timeout: 15000 })
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(`\n\n${marker}`)
      await page.keyboard.press('Control+s')
      const res = await rejected
      assert.ok([401, 403].includes(res.status()), `the save was refused: ${res.status()}`)
      gate.open()

      const toast = page.locator(`${tid('app-toast')}[data-toast="view-only"]`)
      await toast.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await toast.innerText(), /This link is view-only/)
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-capability') === 'viewer', null, { timeout: 10000 })
      assert.equal(await appAttr(page, 'view'), 'read', 'switched to read mode')
      const map = await editTokens(page)
      assert.ok(!(doc.id in map) && !Object.values(map).includes(doc.editToken), `stored token dropped: ${JSON.stringify(map)}`)
      assert.equal(await page.locator(tid('view-toggle')).count(), 0, 'no edit affordance any more')

      assert.ok((await page.locator('.preview-pane').first().innerText()).includes(marker), 'the unsaved text is still on screen')
      const deadline = Date.now() + 5000
      while (!(await draftText(page)).includes(marker) && Date.now() < deadline) await page.waitForTimeout(200)
      assert.ok((await draftText(page)).includes(marker), 'the unsaved text is kept in the local draft')
      assert.ok(!(await serverMarkdown(doc.id)).includes(marker), 'and it never reached the server')
    } finally { await context.close() }
  })
})
