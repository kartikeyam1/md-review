// #23 review/QA fix round — browser half. Server half: server/test-items/23-fixes.test.mjs.
//   F1  a poll that reports can_edit:false (token rotated elsewhere) downgrades like a refused
//       write: view-only toast, viewer, read view, ?view=edit rewritten to view=read (QA defect 1)
//   F2  a viewer's rejected edits are an unsaved local copy (banner: copy/download/discard), the
//       doc shows the SERVER version, also after a reload (QA defect 2); no keepalive write and
//       no leave prompt for a viewer
//   F4  durable-sync's save/conflict flow on a protected doc; 00 §1.2 viewer ACs of #2/#4 (and
//       the #6 "no editor for viewers" part) against a protected doc opened without a token
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import { createDoc, listRevisions, putMarkdown } from '../lib/docs.mjs'
import {
  uniq, tid, serverMarkdown, rawPut, rotateToken, installRecorder, editTokens, draftText, holdDocGets,
} from './23-lib.mjs'

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
const appAttr = (page, name) => page.locator('.app').first().getAttribute(`data-${name}`)
const pathRe = (d, suffix) => new RegExp(`^/paste/(${d.id}${d.slug ? `|${d.slug}` : ''})${suffix}$`)
const viewParam = (page) => page.evaluate(() => new URLSearchParams(location.search).get('view'))
const mainPreview = (page) => page.locator('.content-area .preview-pane, .split-pane .preview-pane, main .preview-pane').last()

async function protectedDoc(markdown, extra = {}) {
  const d = await createDoc({ markdown, filename: 'doc.md', sessionName: uniq('Fix'), protected: true, ...extra })
  assert.match(String(d.editToken), /^mre_[A-Za-z0-9_-]{43}$/, 'createDoc({ protected: true }) returns the edit token')
  return d
}
async function waitForEditor(page) {
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
}
async function typeAtEnd(page, text) {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}
async function waitForViewer(page, timeout = 15000) {
  await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-capability') === 'viewer', null, { timeout })
}

// ── F1: a poll downgrades ────────────────────────────────────────────────────
describe('#23 fix 1 — a poll reporting can_edit:false downgrades the editor', () => {
  it('F1 rotation elsewhere → next poll: view-only toast, viewer, read view, ?view=edit → view=read (QA defect 1)', T, async () => {
    const doc = await protectedDoc('# Poll downgrade\n\nPoll body.\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      assert.equal(await appAttr(page, 'capability'), 'editor')
      assert.equal(await viewParam(page), 'edit')
      const rot = await rotateToken(doc.id, doc.editToken)
      assert.equal(rot.status, 200)
      // No write from this tab: only the poll (every 5 s) can tell it.
      const toast = page.locator(`${tid('app-toast')}[data-toast="view-only"]`)
      await toast.waitFor({ state: 'visible', timeout: 15000 })
      assert.match(await toast.innerText(), /This link is view-only/)
      await waitForViewer(page, 5000)
      assert.equal(await appAttr(page, 'view'), 'read')
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
      assert.equal(await page.locator('.cm-editor').count(), 0, 'editor gone')
      assert.equal(await page.locator(tid('view-toggle')).count(), 0)
      assert.ok(!(doc.id in (await editTokens(page))), 'the stale token is dropped')
    } finally { await context.close() }
  })

  it('QA defect 1: a refused save also rewrites ?view=edit to view=read', T, async () => {
    const doc = await protectedDoc('# Save downgrade\n\nSave body.\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      const gate = await holdDocGets(page, [doc.id, doc.slug])
      gate.close()
      assert.equal((await rotateToken(doc.id, doc.editToken)).status, 200)
      const refused = page.waitForResponse((r) => r.request().method() === 'PUT' && pathRe(doc, '/markdown').test(new URL(r.url()).pathname), { timeout: 15000 })
      await typeAtEnd(page, `\n\n${uniq('X')}`)
      await page.keyboard.press('Control+s')
      assert.ok([401, 403].includes((await refused).status()))
      gate.open()
      await waitForViewer(page)
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
    } finally { await context.close() }
  })
})

// ── F2: rejected edits are a local copy ──────────────────────────────────────
describe('#23 fix 2 — a viewer\'s rejected edits are an unsaved local copy', () => {
  it('F2 the doc shows the server version; the banner holds my edits (copy/download/discard); a reload keeps both (QA defect 2)', T, async () => {
    const doc = await protectedDoc('# Local copy\n\nServer line.\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      const gate = await holdDocGets(page, [doc.id, doc.slug])
      gate.close()
      assert.equal((await rotateToken(doc.id, doc.editToken)).status, 200)
      const marker = uniq('MINE')
      const refused = page.waitForResponse((r) => r.request().method() === 'PUT' && pathRe(doc, '/markdown').test(new URL(r.url()).pathname), { timeout: 15000 })
      await typeAtEnd(page, `\n\n${marker}`)
      await page.keyboard.press('Control+s')
      await refused
      gate.open()
      await waitForViewer(page)

      const banner = page.locator(tid('local-copy-banner'))
      await banner.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await banner.innerText(), /Your unsaved changes \(not on the server\)/)
      assert.ok((await banner.innerText()).includes(marker), 'the banner shows my edits')
      const docText = await mainPreview(page).innerText()
      assert.ok(docText.includes('Server line.'), 'the doc preview shows the server version')
      assert.ok(!docText.includes(marker), 'my edits are not rendered as the document')
      assert.equal(await page.locator(tid('save-state')).filter({ hasText: /error|failed/i }).count(), 0, 'no save error state')

      await page.locator(tid('local-copy-copy')).click()
      await page.waitForFunction((m) => (window.__mdr23?.clipboard ?? []).some((c) => c.includes(m)), marker, { timeout: 5000 })
      const dl = page.waitForEvent('download', { timeout: 5000 })
      await page.locator(tid('local-copy-download')).click()
      assert.match((await dl).suggestedFilename(), /\.md$/)

      // Reload as a viewer: the SERVER version on screen, the copy in the banner.
      await page.reload()
      await page.locator('.preview-pane').filter({ hasText: 'Server line.' }).first().waitFor({ state: 'visible', timeout: 15000 })
      await waitForViewer(page)
      await banner.waitFor({ state: 'visible', timeout: 5000 })
      assert.ok((await banner.innerText()).includes(marker), 'still offered after a reload')
      assert.ok(!(await mainPreview(page).innerText()).includes(marker), 'still not rendered as the doc after a reload')
      assert.ok(!(await serverMarkdown(doc.id)).includes(marker), 'never reached the server')

      page.once('dialog', (d) => d.accept())
      await page.locator(tid('local-copy-discard')).click()
      await banner.waitFor({ state: 'detached', timeout: 5000 })
      assert.ok(!(await draftText(page)).includes(marker), 'discard forgets it everywhere')
    } finally { await context.close() }
  })

  it('F2 a viewer with unsaved text sends no keepalive write on pagehide and gets no leave prompt', T, async () => {
    const doc = await protectedDoc('# No keepalive\n\nBody.\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      const gate = await holdDocGets(page, [doc.id, doc.slug])
      gate.close()
      assert.equal((await rotateToken(doc.id, doc.editToken)).status, 200)
      const refused = page.waitForResponse((r) => r.request().method() === 'PUT' && pathRe(doc, '/markdown').test(new URL(r.url()).pathname), { timeout: 15000 })
      await typeAtEnd(page, `\n\n${uniq('LATE')}`)
      await page.keyboard.press('Control+s')
      await refused
      gate.open()
      await waitForViewer(page)

      const writes = []
      page.on('request', (r) => { if (r.method() !== 'GET' && r.url().startsWith(API)) writes.push(`${r.method()} ${r.url()}`) })
      await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('visibilitychange')) })
      await page.waitForTimeout(800)
      assert.deepEqual(writes, [], 'no write on pagehide for a viewer')
      const cancelled = await page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(e)
        return e.defaultPrevented
      })
      assert.equal(cancelled, false, 'no leave prompt for a viewer')
    } finally { await context.close() }
  })
})

// ── F4: durable-sync flow on a protected doc ─────────────────────────────────
describe('#23 fix 4 — save and conflict flow on a protected doc', () => {
  it('F4 save lands with the token; a concurrent write shows the conflict bar; "Keep my version" overwrites with the token', T, async () => {
    const doc = await protectedDoc('# Protected sync\n\nFirst paragraph.\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}?edit=${doc.editToken}&view=edit`)
      await waitForEditor(page)
      const m1 = uniq('SAVED')
      const put1 = page.waitForRequest((r) => r.method() === 'PUT' && pathRe(doc, '/markdown').test(new URL(r.url()).pathname), { timeout: 15000 })
      await typeAtEnd(page, `\n\n${m1}`)
      await page.keyboard.press('Control+s')
      const req1 = await put1
      assert.equal(req1.headers()['x-edit-token'], doc.editToken)
      assert.equal((await req1.response()).status(), 200)
      assert.ok((await serverMarkdown(doc.id)).includes(m1))

      // Another client (holding the token) writes meanwhile.
      const theirs = `# Protected sync\n\nTheir version ${uniq('T')}.\n`
      assert.equal((await rawPut(doc.id, theirs, doc.editToken)).status, 200)
      const m2 = uniq('MINE')
      await typeAtEnd(page, `\n\n${m2}`)
      await page.keyboard.press('Control+s')
      const bar = page.locator(tid('conflict-bar'))
      await bar.waitFor({ state: 'visible', timeout: 15000 })
      assert.equal(await appAttr(page, 'capability'), 'editor', 'a conflict is not a lost token')

      const put2 = page.waitForRequest((r) => r.method() === 'PUT' && pathRe(doc, '/markdown').test(new URL(r.url()).pathname), { timeout: 15000 })
      await bar.locator('button', { hasText: 'Keep my version' }).click()
      const req2 = await put2
      assert.equal(req2.headers()['x-edit-token'], doc.editToken)
      assert.equal((await req2.response()).status(), 200)
      await bar.waitFor({ state: 'hidden', timeout: 5000 })
      assert.ok((await serverMarkdown(doc.id)).includes(m2), 'my version is on the server')
    } finally { await context.close() }
  })
})

// ── F4: 00 §1.2 viewer ACs against a protected doc without a token ───────────
describe('#23 fix 4 — 00 §1.2 viewer ACs on a protected doc opened without a token', () => {
  it('AC-02.9 (protected doc) a viewer of a review doc gets comments and approval but no edit, share, mode or restore', T, async () => {
    const doc = await protectedDoc('# Viewer review\n\nVersion ONE.\n', { mode: 'review', author: 'Alice' })
    await putMarkdown(doc.id, '# Viewer review\n\nVersion TWO for the viewer.\n', { author: 'Bob', editToken: doc.editToken })
    const c = await fetch(`${API}/paste/${doc.id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startLine: 2, endLine: 2, selectedText: 'Version TWO', body: uniq('viewer comment'), category: 'nit' }),
    })
    assert.equal(c.status, 201)
    assert.ok((await listRevisions(doc.id)).revisions.length >= 2)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key(doc)}`)
      await page.locator('.preview-pane').filter({ hasText: 'Version TWO for the viewer.' }).first().waitFor({ state: 'visible', timeout: 15000 })
      await waitForViewer(page)
      assert.equal(await appAttr(page, 'mode'), 'review')
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })
      await page.locator('.approval-banner').waitFor({ state: 'visible', timeout: 5000 })
      for (const id of ['view-toggle', 'view-toggle-read', 'view-toggle-edit', 'share-btn']) {
        assert.equal(await page.locator(tid(id)).count(), 0, `${id} is absent for a viewer`)
      }
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('header-overflow-menu')).waitFor({ state: 'visible', timeout: 5000 })
      for (const id of ['doc-mode-publish', 'doc-mode-review']) assert.equal(await page.locator(tid(id)).count(), 0, `${id} absent`)
      await page.locator(tid('menu-history')).click()
      const modal = page.locator(tid('revisions-modal'))
      await modal.waitFor({ state: 'visible', timeout: 5000 })
      const items = modal.locator('.rev-item')
      await items.nth(1).waitFor({ state: 'visible', timeout: 5000 })
      const n = await items.count()
      for (let i = 0; i < n; i++) {
        await items.nth(i).click()
        await page.waitForTimeout(200)
        assert.equal(await page.locator(tid('restore-revision')).count(), 0, `no restore-revision (revision ${i})`)
      }
    } finally { await context.close() }
  })

  for (const v of ['edit', 'split', 'bogus']) {
    it(`AC-04.12 (protected doc) a viewer opening ?view=${v} gets the read view, view=read via replaceState, no editor (#6: viewers never get the editor)`, T, async () => {
      const doc = await protectedDoc(`# View ${v}\n\nViewer ${v} body.\n`)
      const { context, page } = await open()
      try {
        await page.goto(`${BASE}/d/${key(doc)}?view=${v}`)
        await page.locator('.preview-pane').filter({ hasText: `Viewer ${v} body.` }).first().waitFor({ state: 'visible', timeout: 15000 })
        await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
        assert.equal(await appAttr(page, 'view'), 'read')
        assert.equal(await appAttr(page, 'capability'), 'viewer')
        assert.equal(await page.locator('.cm-editor').count(), 0, 'no editor rendered')
        const pushes = (await page.evaluate(() => window.__mdr23?.log ?? [])).filter((e) => e.kind === 'push')
        assert.deepEqual(pushes, [], 'the rewrite uses replaceState, never pushState')
      } finally { await context.close() }
    })
  }
})
