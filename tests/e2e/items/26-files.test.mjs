// #26 multi-file sessions in the doc view — acceptance tests (docs/build/specs/26-library.md
// rules 19–27, AC-26.15–AC-26.19) plus the spec's edge cases on file names, back/forward,
// sandboxing, viewers, pinned revisions and files added by another client.
// Sessions and files are created through the REST API on the throwaway backend.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, waitForDoc, readingOffset } from '../lib/docs.mjs'

const T = { timeout: 90_000 }
const tid = (id) => `[data-testid="${id}"]`
// 1×1 transparent PNG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open({ viewport = { width: 1400, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  return { context, page }
}

const encPath = (name) => name.split('/').map(encodeURIComponent).join('/')
const keyOf = (doc) => doc.slug || doc.id

async function addFile(id, name, content, { encoding, token } = {}) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(id)}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}) },
    body: JSON.stringify(encoding ? { name, content, encoding } : { name, content }),
  })
  assert.equal(res.status, 201, `POST /paste/${id}/files ${name}: ${res.status} ${await res.text()}`)
}

async function listFiles(id) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(id)}/files`)
  assert.equal(res.status, 200)
  return (await res.json()).map((f) => f.name)
}

async function waitForPath(page, pathname, timeout = 10000) {
  await page.waitForFunction((p) => location.pathname === p, pathname, { timeout })
}

const tabs = (page) => page.locator(`${tid('file-tabs')} ${tid('file-tab')}`)
const tabFor = (page, name) => page.locator(`${tid('file-tab')}[data-file="${name.replace(/"/g, '\\"')}"]`)
const removeFor = (page, name) => page.locator(`${tid('file-tab-remove')}[data-file="${name.replace(/"/g, '\\"')}"]`)
const primaryTab = (page) => page.locator(`${tid('file-tab')}[data-file=""]`)

async function selectedFile(page) {
  return page.locator(`${tid('file-tab')}[aria-selected="true"]`).getAttribute('data-file')
}

async function htmlFrame(page) {
  const handle = await page.locator('iframe.html-frame').elementHandle({ timeout: 15000 })
  let frame = await handle.contentFrame()
  for (let i = 0; i < 50 && !frame; i++) { await page.waitForTimeout(100); frame = await handle.contentFrame() }
  return { handle, frame }
}

async function openAttachments(page) {
  await page.locator(`${tid('file-attachments-menu')} button[aria-haspopup="menu"]`).click()
  await page.locator(`${tid('file-attachment-item')}`).first().waitFor({ state: 'visible', timeout: 5000 })
}

/** A collection named `name` (POST, or the existing one on 409) → its id. */
async function ensureCollection(name) {
  const res = await fetch(`${API}/library/collections`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })
  if (res.status === 201) return (await res.json()).id
  assert.equal(res.status, 409, `POST /library/collections: ${res.status}`)
  const list = await (await fetch(`${API}/library/collections`)).json()
  return list.find((c) => c.name.toLowerCase() === name.toLowerCase()).id
}

async function moveToCollection(id, collectionId) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(id)}/collection`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId }),
  })
  assert.equal(res.status, 200, `PUT /paste/${id}/collection: ${res.status}`)
}

// ── AC-26.15 / AC-26.16 ─────────────────────────────────────────────────────
describe('#26 file tabs (rules 20–22)', () => {
  let doc
  before(async () => {
    doc = await createDoc({ markdown: '# Primary\n\nPrimary body P26.', filename: 'main.md', sessionName: uniq('Bundle') })
    const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i} of the appendix.`).join('\n\n')
    await addFile(doc.id, 'appendix.md', `# Appendix\n\nAppendix body A26.\n\n${filler}\n\n## Setup\n\nSetup section.\n\n${filler}\n`)
    await addFile(doc.id, 'data/report.html', '<!doctype html><html><body><h1 id="top">Report body R26</h1></body></html>')
    await addFile(doc.id, 'chart.png', PNG_1PX, { encoding: 'base64' })
  })

  it('AC-26.15 primary + document files are tabs, chart.png is an attachment; a tab click pushes its URL and renders it', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Primary body P26.')
      await page.locator(tid('file-tabs')).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await tabs(page).count(), 3, 'primary, appendix.md, data/report.html')
      assert.deepEqual(await tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-file'))), ['', 'appendix.md', 'data/report.html'])
      assert.match(await primaryTab(page).innerText(), /main\.md/)
      assert.equal(await primaryTab(page).getAttribute('aria-selected'), 'true')
      assert.equal(await tabFor(page, 'chart.png').count(), 0, 'no tab for an image')

      await openAttachments(page)
      const items = page.locator(tid('file-attachment-item'))
      assert.equal(await items.count(), 1)
      assert.match(await items.first().innerText(), /chart\.png/)
      await page.keyboard.press('Escape')

      const before = await page.evaluate(() => history.length)
      await tabFor(page, 'appendix.md').click()
      await waitForPath(page, `/d/${keyOf(doc)}/appendix.md`)
      await waitForDoc(page, 'Appendix body A26.')
      assert.equal(await page.evaluate(() => history.length), before + 1, 'selecting a tab pushes')
      assert.equal(await selectedFile(page), 'appendix.md')
      assert.equal(await page.locator('.preview-pane').filter({ hasText: 'Primary body P26.' }).count(), 0)
      // The doc stays the doc: header title is the doc's, not the file's.
      assert.match(await page.locator(tid('doc-title')).innerText(), /Bundle|Primary/)
    } finally { await context.close() }
  })

  it('AC-26.16 direct load of an HTML file renders sandboxed with its tab selected; Back from the primary tab returns to it', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/data/report.html`)
      const { handle, frame } = await htmlFrame(page)
      await frame.waitForSelector('#top', { timeout: 10000 })
      assert.match(await frame.textContent('#top'), /Report body R26/)
      const sandbox = await handle.getAttribute('sandbox')
      assert.ok(sandbox !== null && !/allow-same-origin/.test(sandbox), `sandboxed: ${sandbox}`)
      await page.locator(tid('file-tabs')).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await selectedFile(page), 'data/report.html')

      await primaryTab(page).click()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Primary body P26.')
      assert.equal(await selectedFile(page), '')

      await page.goBack()
      await waitForPath(page, `/d/${keyOf(doc)}/data/report.html`)
      const again = await htmlFrame(page)
      await again.frame.waitForSelector('#top', { timeout: 10000 })
      assert.equal(await selectedFile(page), 'data/report.html')
      await page.goForward()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Primary body P26.')
    } finally { await context.close() }
  })

  it('an image attachment opens at its file route, fitted to the width', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Primary body P26.')
      await openAttachments(page)
      await page.locator(tid('file-attachment-item')).first().click()
      await waitForPath(page, `/d/${keyOf(doc)}/chart.png`)
      const img = page.locator('.file-view img')
      await img.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await img.evaluate((el) => getComputedStyle(el).maxWidth), '100%')
      assert.equal(await page.locator(`${tid('file-tab')}[aria-selected="true"]`).count(), 0, 'no tab is selected for an attachment')
    } finally { await context.close() }
  })

  it('heading fragments work within a file (/d/x/appendix.md#setup)', T, async () => {
    const { context, page } = await open({ viewport: { width: 1400, height: 500 } })
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/appendix.md#setup`)
      await waitForDoc(page, 'Setup section.')
      let off = null
      for (let i = 0; i < 30; i++) {
        off = await readingOffset(page, '.preview-pane #setup')
        if (off !== null && off >= -2 && off <= 60) break
        await page.waitForTimeout(100)
      }
      assert.ok(off !== null && off >= -2 && off <= 60, `#setup scrolled to the top of the reading area (offset ${off})`)
    } finally { await context.close() }
  })

  it('on a file route the view is read-only: ?view=edit is rewritten, no editor, no view toggle, no comments', T, async () => {
    const review = await createDoc({ markdown: '# Rev\n\nReview primary RV26.', filename: 'r.md', mode: 'review', sessionName: uniq('Rev') })
    await addFile(review.id, 'notes.md', '# Notes\n\nNotes body RV26.\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(review)}/notes.md?view=edit`)
      await waitForDoc(page, 'Notes body RV26.')
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
      assert.equal(await page.locator('.cm-editor').count(), 0)
      assert.equal(await page.locator(tid('view-toggle-edit')).count(), 0, 'no edit toggle on a file route')
      assert.equal(await page.locator('aside.sidebar, .approval-banner').filter({ visible: true }).count(), 0, 'no comments/approval')
      // Capability is the doc's: this (link-editable) doc's editor keeps add/remove.
      await page.locator(tid('file-add-btn')).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await removeFor(page, 'notes.md').count(), 1)
    } finally { await context.close() }
  })
})

// ── AC-26.17 ────────────────────────────────────────────────────────────────
describe('#26 unknown file (rule 23)', () => {
  it('AC-26.17 /d/<slug>/nope.md shows file-not-found with a link to /d/<slug> and makes at most one request for it', T, async () => {
    const doc = await createDoc({ markdown: '# Host\n\nHost body NF26.', filename: 'h.md', sessionName: uniq('NotFound') })
    await addFile(doc.id, 'real.md', '# Real\n\nReal.\n')
    const { context, page } = await open()
    let hits = 0
    page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/files/nope.md')) hits++ })
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/nope.md`)
      const nf = page.locator(tid('file-not-found'))
      await nf.waitFor({ state: 'visible', timeout: 10000 })
      const link = nf.locator(`a[href$="/d/${keyOf(doc)}"]`)
      assert.equal(await link.count(), 1, 'a link back to the primary doc')
      await page.waitForTimeout(6500) // one poll interval: no request loop
      assert.ok(hits <= 1, `requests for nope.md: ${hits}`)
      assert.equal(await page.locator(tid('doc-not-found')).count(), 0, 'the doc exists: not doc-not-found')
      await link.click()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Host body NF26.')
    } finally { await context.close() }
  })
})

// ── AC-26.18 + rule 25 ──────────────────────────────────────────────────────
describe('#26 add / remove files (rule 25)', () => {
  it('AC-26.18 an editor adds notes.md via file-add-btn, then removes it while open → /d/<slug>, file gone', T, async () => {
    const doc = await createDoc({ markdown: '# Edit\n\nEditor body AR26.', filename: 'e.md', sessionName: uniq('AddRm') })
    const { context, page } = await open()
    const native = []
    page.on('dialog', (d) => { native.push(d.message()); d.dismiss().catch(() => {}) })
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Editor body AR26.')
      // Editors always see the strip (it carries file-add-btn), even with no files yet.
      await page.locator(tid('file-add-btn')).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await primaryTab(page).count(), 1)
      assert.equal(await removeFor(page, '').count(), 0, 'the primary tab has no remove control')
      assert.equal(await page.locator(tid('file-tab-remove')).count(), 0)
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('file-add-btn')).click()])
      assert.ok(chooser.isMultiple(), 'multiple files allowed')
      await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nAdded notes body AR26 — ünïcödé.\n') })
      await tabFor(page, 'notes.md').waitFor({ state: 'visible', timeout: 10000 })
      assert.ok((await listFiles(doc.id)).includes('notes.md'))
      const raw = await (await fetch(`${API}/paste/${doc.id}/files/notes.md`)).text()
      assert.match(raw, /ünïcödé/, 'text uploads as utf-8')

      await tabFor(page, 'notes.md').click()
      await waitForPath(page, `/d/${keyOf(doc)}/notes.md`)
      await waitForDoc(page, 'Added notes body AR26')
      await removeFor(page, 'notes.md').click()
      // QA m1: an in-app confirm (not window.confirm), focus on Cancel (destructive default).
      const dlg = page.locator(tid('file-confirm-dialog'))
      await dlg.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await dlg.innerText(), /Remove “notes\.md”\?/)
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'file-confirm-cancel')
      await dlg.locator(tid('file-confirm-ok')).click()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Editor body AR26.')
      await tabFor(page, 'notes.md').waitFor({ state: 'detached', timeout: 10000 })
      assert.ok(!(await listFiles(doc.id)).includes('notes.md'), 'file removed on the server')
      assert.deepEqual(native, [], 'no native dialog')
    } finally { await context.close() }
  })

  it('a binary file uploads as base64 and lands in the attachments menu', T, async () => {
    const doc = await createDoc({ markdown: '# Bin\n\nBinary host BN26.', filename: 'b.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Binary host BN26.')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('file-add-btn')).click()])
      await chooser.setFiles([{ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') }])
      await page.locator(tid('file-attachments-menu')).waitFor({ state: 'visible', timeout: 10000 })
      const bytes = Buffer.from(await (await fetch(`${API}/paste/${doc.id}/files/pixel.png`)).arrayBuffer())
      assert.equal(bytes.toString('base64'), PNG_1PX, 'bytes intact')
    } finally { await context.close() }
  })

  it('an existing name asks to replace (in-app dialog); Cancel or Esc sends nothing, Replace uploads', T, async () => {
    const doc = await createDoc({ markdown: '# Rep\n\nReplace host RP26.', filename: 'r.md' })
    await addFile(doc.id, 'notes.md', '# Old\n\nOld notes.\n')
    const { context, page } = await open()
    const posts = []
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/files')) posts.push(r.url()) })
    const native = []
    page.on('dialog', (d) => { native.push(d.message()); d.dismiss().catch(() => {}) })
    const pick = async () => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('file-add-btn')).click()])
      await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# New\n\nNew notes.\n') })
    }
    const dlg = page.locator(tid('file-confirm-dialog'))
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Replace host RP26.')
      await tabFor(page, 'notes.md').waitFor({ state: 'visible', timeout: 10000 })
      await pick()
      await dlg.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await dlg.innerText(), /notes\.md/)
      await dlg.locator(tid('file-confirm-cancel')).click()
      await dlg.waitFor({ state: 'detached', timeout: 5000 })
      // Esc closes the dialog (00 §3.4 layer 2) and also declines.
      await pick()
      await dlg.waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached', timeout: 5000 })
      await page.waitForTimeout(300)
      assert.equal(posts.length, 0, 'declined: nothing uploaded')
      await pick()
      await dlg.locator(tid('file-confirm-ok')).click()
      for (let i = 0; i < 50; i++) {
        if (/New notes/.test(await (await fetch(`${API}/paste/${doc.id}/files/notes.md`)).text())) break
        await page.waitForTimeout(100)
      }
      assert.match(await (await fetch(`${API}/paste/${doc.id}/files/notes.md`)).text(), /New notes/)
      assert.deepEqual(native, [], 'no native dialog')
    } finally { await context.close() }
  })

  it('a failed upload shows an error toast and adds no tab', T, async () => {
    const doc = await createDoc({ markdown: '# Fail\n\nFail host FL26.', filename: 'f.md' })
    const { context, page } = await open()
    try {
      await page.route((u) => u.pathname.endsWith(`/paste/${doc.id}/files`), (route) => (
        route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk full"}' }) : route.continue()
      ))
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Fail host FL26.')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('file-add-btn')).click()])
      await chooser.setFiles({ name: 'broken.md', mimeType: 'text/markdown', buffer: Buffer.from('# B\n') })
      await page.locator(`${tid('app-toast')}[data-kind="error"]`).filter({ hasText: 'broken.md' }).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await tabFor(page, 'broken.md').count(), 0)
    } finally { await context.close() }
  })

  it('AC-26.18 a viewer of a token-protected doc sees the tabs but neither file-add-btn nor file-tab-remove', T, async () => {
    const doc = await createDoc({ markdown: '# Prot\n\nProtected body VW26.', filename: 'p.md', protected: true })
    await addFile(doc.id, 'notes.md', '# Notes\n\nViewer notes VW26.\n', { token: doc.editToken })
    await addFile(doc.id, 'chart.png', PNG_1PX, { encoding: 'base64', token: doc.editToken })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Protected body VW26.')
      await tabFor(page, 'notes.md').waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await page.locator(tid('file-add-btn')).count(), 0)
      assert.equal(await page.locator(tid('file-tab-remove')).count(), 0)
      await openAttachments(page)
      assert.equal(await page.locator(tid('file-tab-remove')).count(), 0, 'no remove in the attachments menu either')
      await page.keyboard.press('Escape')
      await tabFor(page, 'notes.md').click()
      await waitForDoc(page, 'Viewer notes VW26.')
      assert.equal(await page.locator(tid('file-add-btn')).count(), 0, 'still none on the file route')
      assert.equal(await page.locator(tid('file-tab-remove')).count(), 0)
    } finally { await context.close() }
  })

  it('a viewer of a doc without document files sees no strip', T, async () => {
    const doc = await createDoc({ markdown: '# Plain\n\nPlain protected PL26.', filename: 'p.md', protected: true })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Plain protected PL26.')
      await page.waitForTimeout(800)
      assert.equal(await page.locator(tid('file-tabs')).count(), 0)
    } finally { await context.close() }
  })
})

// ── AC-26.19 ────────────────────────────────────────────────────────────────
describe('#26 breadcrumb (rule 24)', () => {
  it('AC-26.19 Library › Ops › <title> › <file>, collection links to /library?collection=<id>', T, async () => {
    const name = `Ops ${Math.random().toString(36).slice(2, 6)}`
    const collectionId = await ensureCollection(name)
    const doc = await createDoc({ markdown: '# Crumb Title\n\nCrumb body BC26.', filename: 'c.md', sessionName: 'Crumb Title' })
    await moveToCollection(doc.id, collectionId)
    await addFile(doc.id, 'data/report.html', '<!doctype html><p>r</p>')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/data/report.html`)
      const bc = page.locator(tid('doc-breadcrumb'))
      await bc.waitFor({ state: 'visible', timeout: 10000 })
      await bc.locator(tid('breadcrumb-collection')).waitFor({ state: 'visible', timeout: 10000 })
      const text = async (t) => (await bc.locator(tid(t)).innerText()).trim()
      assert.equal(await text('breadcrumb-library'), 'Library')
      assert.equal(await text('breadcrumb-collection'), name)
      assert.equal(await text('breadcrumb-doc'), 'Crumb Title')
      assert.equal(await text('breadcrumb-file'), 'data/report.html')
      assert.equal(await bc.locator(tid('breadcrumb-file')).getAttribute('aria-current'), 'page')
      const order = await bc.locator('[data-testid^="breadcrumb-"]').evaluateAll((els) => els.map((e) => e.dataset.testid))
      assert.deepEqual(order, ['breadcrumb-library', 'breadcrumb-collection', 'breadcrumb-doc', 'breadcrumb-file'])
      const href = new URL(await bc.locator(tid('breadcrumb-collection')).getAttribute('href'), BASE)
      assert.equal(href.pathname, '/library')
      assert.equal(href.searchParams.get('collection'), collectionId)
      assert.equal(new URL(await bc.locator(tid('breadcrumb-library')).getAttribute('href'), BASE).pathname, '/library')
      // §2.4: the breadcrumb sits above the tab strip.
      const bcBox = await bc.boundingBox()
      const tabsBox = await page.locator(tid('file-tabs')).boundingBox()
      assert.ok(bcBox.y < tabsBox.y, 'breadcrumb above the tabs')
      await bc.locator(tid('breadcrumb-doc')).click()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Crumb body BC26.')
      assert.equal(await bc.locator(tid('breadcrumb-file')).count(), 0, 'no file segment on the primary doc')
    } finally { await context.close() }
  })

  it('an unfiled doc without document files shows no breadcrumb; an unfiled doc with files omits the collection', T, async () => {
    const plain = await createDoc({ markdown: '# Bare\n\nBare body BB26.', filename: 'b.md' })
    const withFiles = await createDoc({ markdown: '# Multi\n\nMulti body MB26.', filename: 'm.md' })
    await addFile(withFiles.id, 'x.md', '# X\n')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(plain)}`)
      await waitForDoc(page, 'Bare body BB26.')
      await page.waitForTimeout(800)
      assert.equal(await page.locator(tid('doc-breadcrumb')).count(), 0)
      await page.goto(`${BASE}/d/${keyOf(withFiles)}/x.md`)
      await page.locator(tid('doc-breadcrumb')).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await page.locator(tid('breadcrumb-collection')).count(), 0)
      assert.equal(await page.locator(tid('breadcrumb-file')).innerText(), 'x.md')
    } finally { await context.close() }
  })

  it('on a phone (390×844) the breadcrumb stays on one line and nothing scrolls sideways', T, async () => {
    const collectionId = await ensureCollection(`A rather long collection name ${Math.random().toString(36).slice(2, 6)}`)
    const doc = await createDoc({
      markdown: '# An extremely long document title that would never fit on a phone screen at all\n\nPhone body PH26.',
      filename: 'p.md',
    })
    await moveToCollection(doc.id, collectionId)
    await addFile(doc.id, 'deeply/nested/folder/with-a-long-file-name.md', '# Long\n\nLong file PH26.\n')
    await addFile(doc.id, 'second.md', '# S\n')
    const { context, page } = await open({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/${encPath('deeply/nested/folder/with-a-long-file-name.md')}`)
      await waitForDoc(page, 'Long file PH26.')
      const bc = page.locator(tid('doc-breadcrumb'))
      await bc.waitFor({ state: 'visible', timeout: 10000 })
      const box = await bc.boundingBox()
      const lineHeight = await bc.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20)
      assert.ok(box.height <= lineHeight * 1.6 + 16, `one line: height ${box.height}`)
      assert.ok(box.x >= 0 && box.x + box.width <= 390.5, 'inside the viewport')
      assert.match(await bc.innerText(), /…/, 'middle segments truncated with …')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal page scroll')
    } finally { await context.close() }
  })
})

// ── edge cases ──────────────────────────────────────────────────────────────
describe('#26 edge cases', () => {
  const NAMES = ['src/a b.md', 'what?.md', 'hash#1.md', '100%.md', 'naïve/日本語.md', '@x.md', 'edit.md']
  let doc
  before(async () => {
    doc = await createDoc({ markdown: '# Names\n\nNames primary NM26.', filename: 'n.md', sessionName: uniq('Names') })
    for (const [i, n] of NAMES.entries()) await addFile(doc.id, n, `# File ${i}\n\nBody of file NM26-${i}.\n`)
  })

  it('odd file names round-trip: click → encoded URL → content; direct load works too', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Names primary NM26.')
      for (const [i, n] of NAMES.entries()) {
        await tabFor(page, n).click()
        await waitForPath(page, `/d/${keyOf(doc)}/${encPath(n)}`)
        await waitForDoc(page, `Body of file NM26-${i}.`)
        assert.equal(await selectedFile(page), n)
        assert.equal(new URL(page.url()).search, '', `no query from ${n}`)
        assert.equal(new URL(page.url()).hash, '', `no fragment from ${n}`)
      }
      for (const [i, n] of NAMES.entries()) {
        await page.goto(`${BASE}/d/${keyOf(doc)}/${encPath(n)}`)
        await waitForDoc(page, `Body of file NM26-${i}.`)
        assert.equal(await page.locator('.cm-editor').count(), 0, `${n} is not a view`)
      }
    } finally { await context.close() }
  })

  it('rapid Back/Forward between tabs lands on the right content', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Names primary NM26.')
      await tabFor(page, 'edit.md').click()
      await waitForDoc(page, 'Body of file NM26-6.')
      await tabFor(page, '@x.md').click()
      await waitForDoc(page, 'Body of file NM26-5.')
      await primaryTab(page).click()
      await waitForDoc(page, 'Names primary NM26.')
      // Each step only waits for the URL (not the content): loads overlap.
      const k = keyOf(doc)
      for (const [step, path] of [['back', `/d/${k}/@x.md`], ['back', `/d/${k}/edit.md`], ['forward', `/d/${k}/@x.md`], ['back', `/d/${k}/edit.md`]]) {
        await page.evaluate((s) => (s === 'back' ? history.back() : history.forward()), step)
        await waitForPath(page, encodeURI(path).replace('@', '%40'), 5000).catch(async () => {
          throw new Error(`after ${step}: ${await page.evaluate(() => location.pathname)} (wanted ${path})`)
        })
      }
      await waitForDoc(page, 'Body of file NM26-6.')
      await page.waitForTimeout(500)
      assert.equal(await selectedFile(page), 'edit.md')
      assert.equal(await page.locator('.preview-pane').filter({ hasText: 'NM26-5' }).count(), 0)
    } finally { await context.close() }
  })

  it('an HTML file with scripts stays sandboxed (cannot reach the app)', T, async () => {
    const d = await createDoc({ markdown: '# Sb\n\nSandbox host SB26.', filename: 's.md' })
    await addFile(d.id, 'evil.html', `<!doctype html><html><body><p id="m">ran</p><script>
      let blocked = 'no'
      try { parent.document.title = 'PWNED'; window.top.localStorage.setItem('pwned', '1') } catch (e) { blocked = 'yes' }
      document.getElementById('m').textContent = 'blocked=' + blocked
    </script></body></html>`)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(d)}/evil.html`)
      const { handle, frame } = await htmlFrame(page)
      await frame.waitForFunction(() => /blocked=/.test(document.getElementById('m')?.textContent || ''), null, { timeout: 10000 })
      assert.equal(await frame.textContent('#m'), 'blocked=yes')
      assert.notEqual(await page.title(), 'PWNED')
      assert.equal(await page.evaluate(() => localStorage.getItem('pwned')), null)
      assert.ok(!/allow-same-origin/.test(await handle.getAttribute('sandbox') || 'allow-same-origin'))
    } finally { await context.close() }
  })

  it('rule 26: a pinned revision hides the file tabs and attachments', T, async () => {
    const d = await createDoc({ markdown: '# Pin\n\nPinned ONE PN26.', filename: 'p.md', author: 'Alice' })
    await addFile(d.id, 'notes.md', '# N\n')
    await addFile(d.id, 'chart.png', PNG_1PX, { encoding: 'base64' })
    await putMarkdown(d.id, '# Pin\n\nPinned TWO PN26.', { author: 'Bob' })
    const list = await listRevisions(d.id)
    const H = list.revisions.find((r) => r.hash !== list.current)?.hash
    assert.match(H ?? '', /^[0-9a-f]{32}$/)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${d.id}@${H}`)
      await waitForDoc(page, 'Pinned ONE PN26.')
      await page.waitForTimeout(800)
      assert.equal(await page.locator(`${tid('file-tabs')}, ${tid('file-attachments-menu')}, ${tid('file-add-btn')}`).count(), 0)
    } finally { await context.close() }
  })

  it('rule 27: a file added by another client appears after the doc\'s poll, without a reload', T, async () => {
    const d = await createDoc({ markdown: '# Live\n\nLive host LV26.', filename: 'l.md', protected: true })
    await addFile(d.id, 'first.md', '# F\n', { token: d.editToken })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(d)}`)
      await waitForDoc(page, 'Live host LV26.')
      await tabFor(page, 'first.md').waitFor({ state: 'visible', timeout: 10000 })
      await page.evaluate(() => { window.__noReload = true })
      await addFile(d.id, 'second.md', '# S\n', { token: d.editToken })
      await tabFor(page, 'second.md').waitFor({ state: 'visible', timeout: 15000 })
      assert.equal(await page.evaluate(() => window.__noReload), true, 'no reload')
      // And it goes away again when another client removes it.
      const del = await fetch(`${API}/paste/${d.id}/files/second.md`, { method: 'DELETE', headers: { 'X-Edit-Token': d.editToken } })
      assert.equal(del.status, 204)
      await tabFor(page, 'second.md').waitFor({ state: 'detached', timeout: 15000 })
    } finally { await context.close() }
  })
})

// ── #26 fix round (docs/build/reports/26-fix.md) ─────────────────────────────
describe('#26 fix round', () => {
  async function until(fn, { timeout = 10000, what = 'condition' } = {}) {
    const end = Date.now() + timeout
    for (;;) {
      if (await fn()) return
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('leave guard from a file tab: unsaved edits → file tab → Library keeps the file tab on screen; Cancel returns to it', T, async () => {
    const doc = await createDoc({ markdown: '# Guard\n\nGuard body LG26.', filename: 'g.md' })
    await addFile(doc.id, 'notes.md', '# Notes\n\nNotes body LG26.\n')
    const { context, page } = await open()
    const stalled = []
    const dialogs = []
    try {
      // Stall every content write so the edit stays unsaved.
      await page.route((u) => u.href.startsWith(API) && /\/paste\/[^/]+\/markdown$/.test(u.pathname), (route) => {
        if (route.request().method() === 'PUT') stalled.push(route) // never answered
        else route.continue()
      })
      await page.goto(`${BASE}/d/${keyOf(doc)}?view=edit`)
      const editor = page.locator('.cm-content').first()
      await editor.waitFor({ state: 'visible', timeout: 15000 })
      await editor.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nUnsaved LG26.')
      await tabFor(page, 'notes.md').click()
      await waitForPath(page, `/d/${keyOf(doc)}/notes.md`)
      await waitForDoc(page, 'Notes body LG26.')
      page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}) })
      await page.locator(tid('nav-library')).first().click()
      // Rule 13: while the flush runs and the question is open, the file tab stays on screen.
      await page.waitForTimeout(400)
      assert.equal(await page.locator(tid('library-page')).count(), 0, 'the library does not render while deciding')
      assert.equal(await page.locator(tid('file-tabs')).count(), 1, 'the file tab is still on screen')
      await until(async () => dialogs.length === 1, { timeout: 10000, what: 'the leave question' })
      await waitForPath(page, `/d/${keyOf(doc)}/notes.md`)
      await page.locator(tid('file-tabs')).waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await selectedFile(page), 'notes.md', 'Cancel returns to the file tab the user was on')
      await waitForDoc(page, 'Notes body LG26.')
    } finally {
      for (const r of stalled) await r.abort().catch(() => {})
      await context.close()
    }
  })

  it('a file route offers no History or Document mode (they act on the doc); the primary tab does; heading links copy the file URL', T, async () => {
    const doc = await createDoc({ markdown: '# Hist\n\nHistory host HS26.', filename: 'h.md', sessionName: uniq('Hist') })
    await addFile(doc.id, 'notes.md', '# Notes\n\nNotes body HS26.\n\n## Setup\n\nSetup body HS26.\n')
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    const menuIds = async () => {
      await page.locator(tid('header-overflow-btn')).click()
      const menu = page.locator(tid('header-overflow-menu'))
      await menu.waitFor({ state: 'visible', timeout: 5000 })
      const ids = await menu.locator('[data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden', timeout: 5000 })
      return ids
    }
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/notes.md`)
      await waitForDoc(page, 'Notes body HS26.')
      const onFile = await menuIds()
      assert.ok(!onFile.includes('menu-history'), `no History on a file route: ${onFile}`)
      assert.ok(!onFile.includes('doc-mode-publish') && !onFile.includes('doc-mode-review'), `no Document mode on a file route: ${onFile}`)
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'))
      await page.locator('[id="setup"] [data-testid="heading-anchor"]').click({ force: true })
      await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) !== 'sentinel', { timeout: 5000, what: 'the copied link' })
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${BASE}/d/${keyOf(doc)}/notes.md#setup`)
      await primaryTab(page).click()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'History host HS26.')
      const onDoc = await menuIds()
      assert.ok(onDoc.includes('menu-history') && onDoc.includes('doc-mode-publish'), `the primary tab has History and Document mode: ${onDoc}`)
    } finally { await context.close() }
  })

  it('a download card and a download attachment save the file from a blob URL; the app tab stays', T, async () => {
    const doc = await createDoc({ markdown: '# Dl\n\nDownload host DL26.', filename: 'd.md' })
    await addFile(doc.id, 'data.bin', Buffer.from('binary bytes DL26').toString('base64'), { encoding: 'base64' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}/data.bin`)
      const card = page.locator(tid('file-download-card'))
      await card.waitFor({ state: 'visible', timeout: 10000 })
      assert.match(await card.locator('a').getAttribute('href'), /^blob:/, 'the card links a blob URL (download works across origins)')
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), card.locator('a').click()])
      assert.equal(dl.suggestedFilename(), 'data.bin')
      assert.equal(new URL(page.url()).pathname, `/d/${keyOf(doc)}/data.bin`, 'still on the file route')
      await primaryTab(page).click()
      await waitForPath(page, `/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Download host DL26.')
      await openAttachments(page)
      const [dl2] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.locator(`${tid('file-attachment-item')}[data-file="data.bin"]`).click(),
      ])
      assert.equal(dl2.suggestedFilename(), 'data.bin')
      assert.equal(new URL(page.url()).pathname, `/d/${keyOf(doc)}`, 'the app tab did not navigate away')
      const body = await (await import('node:fs')).promises.readFile(await dl2.path(), 'utf8')
      assert.equal(body, 'binary bytes DL26')
    } finally { await context.close() }
  })

  it('the collection is re-read on meta-only polls (a move), not on every remote content change', T, async () => {
    const doc = await createDoc({ markdown: '# Lib\n\nLibrary host LB26.', filename: 'l.md', sessionName: uniq('Lib') })
    await addFile(doc.id, 'notes.md', '# Notes\n')
    const { context, page } = await open()
    const reads = []
    page.on('request', (r) => { if (r.url().includes('fields=library')) reads.push(r.url()) })
    try {
      await page.goto(`${BASE}/d/${keyOf(doc)}`)
      await waitForDoc(page, 'Library host LB26.')
      await until(async () => reads.length >= 1, { what: 'the first ?fields=library' })
      const n0 = reads.length
      await putMarkdown(doc.id, '# Lib\n\nRemote edit one LB26.')
      await waitForDoc(page, 'Remote edit one LB26.', { timeout: 15000 })
      await putMarkdown(doc.id, '# Lib\n\nRemote edit two LB26.')
      await waitForDoc(page, 'Remote edit two LB26.', { timeout: 15000 })
      assert.equal(reads.length, n0, 'content-changing polls do not re-read the collection')
      const name = `Moved ${Math.random().toString(36).slice(2, 7)}`
      await moveToCollection(doc.id, await ensureCollection(name))
      await page.locator(tid('breadcrumb-collection')).filter({ hasText: name }).waitFor({ state: 'visible', timeout: 15000 })
    } finally { await context.close() }
  })
})
