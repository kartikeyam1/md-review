// Item #27 — templates, browser half: AC-27.6–27.11, AC-27.15 and the spec's UI edge cases
// (offline create, html doc, doc with no heading, 1 MB+ doc, deleted default collection,
// the filter box with > 8 templates, Esc / Enter in the picker, hidden on file routes and pinned revisions).
// Server half (AC-27.1–27.5, 27.12–27.14): server/test-items/27-*.test.mjs.
//
// Templates are global to a backend, so every test here runs against private backends
// (26-library-lib.mjs): the app keeps calling the shared API origin and the context's route
// sends those calls to the private one. The filter-box test gets a fresh backend of its own.
//
// Screenshots (picker + save dialog, 390×844 and 1400×900, all 6 themes) are written to
// .verify/qa/27/ only when QA27_SHOTS=1.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from '../helpers.mjs'
import { tid, uniq, privateBackend, routeToBackend, api, mkDoc, until } from './26-library-lib.mjs'

const T = { timeout: 120_000 }
const DESKTOP = { width: 1400, height: 900 }
const PHONE = { width: 390, height: 844 }
const THEMES = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.verify/qa/27')

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open(be, { viewport = DESKTOP, reviewer, theme } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  await routeToBackend(context, be)
  await context.addInitScript(([name, th]) => {
    try {
      if (name !== null) localStorage.setItem('md-review-reviewer', name)
      if (th) localStorage.setItem('md-review-theme', th)
    } catch { /* */ }
  }, [reviewer ?? null, theme ?? null])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('dialog', (d) => { errors.push(`native dialog: ${d.message()}`); d.dismiss().catch(() => {}) })
  return { context, page, errors }
}

const here = (page) => new URL(page.url())
const picker = (page) => page.locator(tid('template-picker'))
const pickerItem = (page, name) => page.locator(tid('template-picker-item')).filter({ has: page.locator('.tp-item-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
const saveDialog = (page) => page.locator(tid('template-save-dialog'))
const templates = async (be) => (await api(be, 'GET', '/templates')).json
const templateNamed = async (be, name) => (await templates(be)).find((t) => t.name === name)
const fullTemplate = async (be, id) => (await api(be, 'GET', `/templates/${id}`)).json

async function gotoLanding(page) {
  await page.goto(`${BASE}/`)
  await page.locator(tid('landing-new-from-template')).waitFor({ timeout: 15000 })
}

async function openPickerFromLanding(page) {
  await gotoLanding(page)
  await page.locator(tid('landing-new-from-template')).click()
  await picker(page).waitFor({ timeout: 10000 })
  await page.locator(tid('template-picker-item')).first().waitFor({ timeout: 10000 })
}

async function chooseTemplate(page, name) {
  await pickerItem(page, name).click()
  await page.locator(tid('template-title-input')).waitFor({ timeout: 5000 })
}

/** Open a doc and wait for it to be on screen. */
async function gotoDoc(page, key, query = '') {
  await page.goto(`${BASE}/d/${key}${query}`)
  await page.waitForFunction(() => !!document.querySelector('.doc-body'), null, { timeout: 15000 })
}

async function openSaveDialog(page) {
  const item = page.locator(tid('doc-save-as-template'))
  if (!(await item.isVisible().catch(() => false))) await page.locator(tid('header-overflow-btn')).click()
  await item.click()
  await saveDialog(page).waitFor({ timeout: 10000 })
  await page.locator(tid('template-save-name')).waitFor()
}

async function editorText(page) {
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
  return page.locator('.cm-content').first().innerText()
}

const docLibrary = async (be, id) => (await api(be, 'GET', `/paste/${id}?fields=meta,library`)).json

// ── the main flow, one shared private backend ──────────────────────────────

describe('#27 templates — picker, save as template, Templates tab', () => {
  let be
  let ops
  const made = {}
  before(async () => {
    be = await privateBackend()
    ops = (await api(be, 'POST', '/library/collections', { name: 'Ops' })).json
  })
  after(async () => { await be?.stop() })

  it('AC-27.6 landing → picker → "Design doc", title "Cache rewrite", Enter → /d/cache-rewrite?view=edit, editor shows the heading, editable', T, async () => {
    const { context, page, errors } = await open(be, { reviewer: 'Asha' })
    try {
      await openPickerFromLanding(page)
      // Rule 10: builtins first, each with a badge, a type and variable chips.
      const names = await page.locator(`${tid('template-picker-item')} .tp-item-name`).allInnerTexts()
      assert.deepEqual(names.slice(0, 5), ['Weekly leadership update', 'Design doc', 'QA findings', 'PR review', 'Research brief'])
      assert.equal(await pickerItem(page, 'Design doc').locator(tid('template-builtin-badge')).count(), 1)
      assert.match(await pickerItem(page, 'Weekly leadership update').innerText(), /week/)
      await chooseTemplate(page, 'Design doc')
      assert.equal(await page.locator(tid('template-author-input')).inputValue(), 'Asha', 'author prefilled with the reader name')
      await page.locator(tid('template-title-input')).fill('Cache rewrite')
      await page.locator(tid('template-title-input')).press('Enter')
      await until(async () => /^\/d\/cache-rewrite(-\d+)?$/.test(here(page).pathname), { timeout: 15000, what: '/d/cache-rewrite' })
      assert.equal(here(page).searchParams.get('view'), 'edit')
      assert.equal(await picker(page).count(), 0, 'the picker closed')
      assert.match(await editorText(page), /^# Cache rewrite/)
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-capability') === 'editor', null, { timeout: 10000 })
      const slug = here(page).pathname.split('/').pop()
      const meta = (await api(be, 'GET', `/paste/${slug}?fields=meta`)).json
      assert.deepEqual(meta.from_template, { id: 'seed-design-doc', name: 'Design doc' })
      assert.equal(meta.access.protected, true)
      const tokens = await page.evaluate(() => JSON.parse(localStorage.getItem('md-review-edit-tokens') || '{}'))
      assert.ok(tokens[meta.id], 'the edit token is held for the new doc (#23)')
      const lib = await docLibrary(be, meta.id)
      assert.equal(lib.created_by, 'Asha')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-27.7 create disabled while the title is empty; typing a title → the preview shows the substituted heading within 1 s', T, async () => {
    const { context, page } = await open(be)
    try {
      await openPickerFromLanding(page)
      await chooseTemplate(page, 'Research brief')
      const create = page.locator(tid('template-create-btn'))
      assert.equal(await create.isDisabled(), true)
      await page.locator(tid('template-title-input')).fill('   ')
      assert.equal(await create.isDisabled(), true, 'whitespace is not a title')
      assert.equal(await page.locator(tid('template-collection-select')).inputValue(), '', 'Unfiled by default')
      await page.locator(tid('template-title-input')).fill('Kumquat findings')
      const t0 = Date.now()
      await page.locator(`${tid('template-preview')} h1`, { hasText: 'Kumquat findings' }).waitFor({ timeout: 1000 })
      assert.ok(Date.now() - t0 <= 1000)
      assert.equal(await create.isDisabled(), false)
      // The preview uses the normal renderer: the seed's callout and table render, nothing is created.
      assert.ok(await page.locator(`${tid('template-preview')} table`).count() >= 1)
      assert.equal((await api(be, 'GET', '/library/docs?q=Kumquat')).json.items.length, 0, 'the dry run creates nothing')
    } finally { await context.close() }
  })

  it('the preview is inert: clicking an in-page anchor or a link in it leaves the picker open and the URL unchanged; no heading-anchor icons', T, async () => {
    const r = await api(be, 'POST', '/templates', { name: 'Anchored', content: '# {{title}}\n\n[Jump to goals](#goals)\n\n[Library](/library)\n\n## Goals\n\nText\n' })
    assert.equal(r.status, 201, r.text)
    const { context, page, errors } = await open(be)
    try {
      await openPickerFromLanding(page)
      await chooseTemplate(page, 'Anchored')
      await page.locator(tid('template-title-input')).fill('Anchor test')
      const preview = page.locator(tid('template-preview'))
      await preview.locator('h1', { hasText: 'Anchor test' }).waitFor({ timeout: 3000 })
      assert.equal(await preview.locator(tid('heading-anchor')).count(), 0, 'no section-link icons in the preview')
      const before = page.url()
      await preview.getByRole('link', { name: 'Jump to goals' }).click()
      await preview.getByRole('link', { name: 'Library' }).click()
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null)))) // a frame for any (wrong) navigation to land
      assert.equal(page.url(), before, 'the URL is unchanged')
      assert.equal(await picker(page).isVisible(), true, 'the picker stays open')
      assert.equal(await page.locator(tid('template-title-input')).inputValue(), 'Anchor test', 'inputs intact')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('Esc closes the picker (and nothing is created)', T, async () => {
    const { context, page } = await open(be)
    try {
      await openPickerFromLanding(page)
      await page.keyboard.press('Escape')
      await picker(page).waitFor({ state: 'detached', timeout: 5000 })
      await page.locator(tid('landing-new-from-template')).click()
      await chooseTemplate(page, 'PR review')
      await page.locator(tid('template-title-input')).fill('Esc test')
      await page.keyboard.press('Escape')
      await picker(page).waitFor({ state: 'detached', timeout: 5000 })
      assert.equal(here(page).pathname, '/')
    } finally { await context.close() }
  })

  it('offline create: an error toast, the picker stays open with its inputs, nothing navigates', T, async () => {
    const { context, page } = await open(be)
    try {
      await openPickerFromLanding(page)
      await chooseTemplate(page, 'QA findings')
      await page.locator(tid('template-title-input')).fill('Offline doc')
      await page.locator(tid('template-author-input')).fill('Ravi')
      await context.setOffline(true)
      await page.locator(tid('template-create-btn')).click()
      await page.locator(`${tid('app-toast')}[data-kind="error"]`).waitFor({ timeout: 10000 })
      assert.equal(await picker(page).isVisible(), true)
      assert.equal(await page.locator(tid('template-title-input')).inputValue(), 'Offline doc')
      assert.equal(await page.locator(tid('template-author-input')).inputValue(), 'Ravi')
      assert.equal(here(page).pathname, '/')
      await context.setOffline(false)
      assert.equal((await api(be, 'GET', '/library/docs?q=Offline')).json.items.length, 0)
    } finally { await context.close() }
  })

  it('AC-27.8 a doc titled "Incident review" in Ops → save as template with defaults → # {{title}}, collection Ops; creating from it lands in Ops', T, async () => {
    made.incident = await mkDoc(be, { markdown: '# Incident review\n\n## Timeline\n\n- 10:00 paged\n', sessionName: 'Incident review', mode: 'review' })
    const put = await api(be, 'PUT', `/paste/${made.incident.id}/collection`, { collectionId: ops.id })
    assert.equal(put.status, 200, put.text)
    const { context, page, errors } = await open(be, { reviewer: 'Asha' })
    try {
      await gotoDoc(page, made.incident.slug || made.incident.id)
      await openSaveDialog(page)
      assert.equal(await page.locator(tid('template-save-name')).inputValue(), 'Incident review')
      await until(async () => (await page.locator(tid('template-save-collection')).inputValue()) === ops.id, { what: 'collection prefilled with Ops' })
      assert.equal(await page.locator(tid('template-save-mode')).inputValue(), 'review')
      assert.equal(await page.locator(tid('template-save-title-var')).isChecked(), true)
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      const ok = page.locator(`${tid('app-toast')}[data-kind="success"]`)
      await ok.waitFor({ timeout: 10000 })
      assert.equal(await ok.locator('a').getAttribute('href'), '/library?tab=templates')
      await saveDialog(page).waitFor({ state: 'detached', timeout: 5000 })
      const t = await templateNamed(be, 'Incident review')
      assert.ok(t, 'GET /templates includes "Incident review"')
      assert.equal(t.collectionId, ops.id)
      assert.equal(t.mode, 'review')
      assert.equal(t.created_by, 'Asha')
      assert.ok((await fullTemplate(be, t.id)).content.startsWith('# {{title}}\n\n## Timeline'))
      made.incidentTpl = t
      // Create from it in the UI: the collection defaults to Ops.
      await openPickerFromLanding(page)
      await chooseTemplate(page, 'Incident review')
      assert.equal(await page.locator(tid('template-collection-select')).inputValue(), ops.id)
      await page.locator(tid('template-title-input')).fill('Outage 12')
      await page.locator(tid('template-create-btn')).click()
      await until(async () => /^\/d\/outage-12/.test(here(page).pathname), { timeout: 15000, what: '/d/outage-12' })
      assert.match(await editorText(page), /^# Outage 12/)
      const slug = here(page).pathname.split('/').pop()
      const lib = await docLibrary(be, slug)
      assert.deepEqual(lib.collection, { id: ops.id, name: 'Ops' })
      made.outage = slug
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-27.9 unsaved editor edits ("DRAFT-LINE") are in the saved template', T, async () => {
    const d = await mkDoc(be, { markdown: '# Drafty\n\nfirst line\n', sessionName: 'Drafty' })
    const { context, page } = await open(be)
    try {
      await gotoDoc(page, d.slug || d.id, '?view=edit')
      await editorText(page)
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\nDRAFT-LINE')
      await openSaveDialog(page)
      await page.locator(tid('template-save-name')).fill('Drafty template')
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      await saveDialog(page).waitFor({ state: 'detached', timeout: 10000 })
      const t = await templateNamed(be, 'Drafty template')
      const full = await fullTemplate(be, t.id)
      assert.match(full.content, /DRAFT-LINE/)
      assert.ok(full.content.startsWith('# {{title}}'))
    } finally { await context.close() }
  })

  it('AC-27.10 name clash with a user template → error + replace replaces it; "design doc" (builtin) → error, no replace', T, async () => {
    const other = await mkDoc(be, { markdown: '# Second incident\n\nREPLACED-BODY\n', sessionName: 'Second incident' })
    const { context, page } = await open(be)
    try {
      await gotoDoc(page, other.slug || other.id)
      await openSaveDialog(page)
      await page.locator(tid('template-save-name')).fill('Incident review')
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      await page.locator(tid('template-save-error')).waitFor({ timeout: 10000 })
      const replace = page.locator(tid('template-save-replace'))
      await replace.waitFor()
      assert.match(await (await fullTemplate(be, made.incidentTpl.id)).content, /Timeline/, 'nothing replaced before confirming')
      await replace.click()
      await saveDialog(page).waitFor({ state: 'detached', timeout: 10000 })
      const after = await fullTemplate(be, made.incidentTpl.id)
      assert.match(after.content, /REPLACED-BODY/)
      assert.equal(after.id, made.incidentTpl.id, 'replace keeps the template id')

      await openSaveDialog(page)
      await page.locator(tid('template-save-name')).fill('design doc')
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      await page.locator(tid('template-save-error')).waitFor({ timeout: 10000 })
      assert.match(await page.locator(tid('template-save-error')).innerText(), /built-in/i)
      assert.equal(await page.locator(tid('template-save-replace')).count(), 0, 'no replace for a builtin')
      assert.equal((await templates(be)).filter((t) => t.name.toLowerCase() === 'design doc').length, 1)
      await page.keyboard.press('Escape')
      await saveDialog(page).waitFor({ state: 'detached', timeout: 5000 })
    } finally { await context.close() }
  })

  it('save as template on an html doc: <title> and the first <h1> become {{title}}, contentType html', T, async () => {
    const d = await mkDoc(be, { markdown: '<!doctype html><html><head><title>Html report</title></head><body><h1>Html report</h1><p>x</p></body></html>', filename: 'r.html', contentType: 'html' })
    const { context, page } = await open(be)
    try {
      await gotoDoc(page, d.slug || d.id)
      await openSaveDialog(page)
      assert.equal(await page.locator(tid('template-save-name')).inputValue(), 'Html report')
      await page.locator(tid('template-save-name')).fill('Html report template')
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      await saveDialog(page).waitFor({ state: 'detached', timeout: 10000 })
      const full = await fullTemplate(be, (await templateNamed(be, 'Html report template')).id)
      assert.equal(full.contentType, 'html')
      assert.match(full.content, /<title>\{\{title\}\}<\/title>/)
      assert.match(full.content, /<h1>\{\{title\}\}<\/h1>/)
    } finally { await context.close() }
  })

  it('save as template on a doc with no heading saves the content unchanged', T, async () => {
    const body = 'Plain notes without any heading.\n\nSecond paragraph.\n'
    const d = await mkDoc(be, { markdown: body, sessionName: 'No heading notes' })
    const { context, page } = await open(be)
    try {
      await gotoDoc(page, d.slug || d.id)
      await openSaveDialog(page)
      assert.equal(await page.locator(tid('template-save-title-var')).isChecked(), true)
      await page.locator(tid('template-save-name')).fill('No heading template')
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      await saveDialog(page).waitFor({ state: 'detached', timeout: 10000 })
      const full = await fullTemplate(be, (await templateNamed(be, 'No heading template')).id)
      assert.equal(full.content, body)
    } finally { await context.close() }
  })

  it('a 1 MB+ doc → a clear "larger than 1 MB" error, no replace, nothing saved', T, async () => {
    const big = `# Big one\n\n${'lorem ipsum '.repeat(95_000)}\n`
    const d = await mkDoc(be, { markdown: big, sessionName: 'Big one' })
    const { context, page } = await open(be)
    try {
      await gotoDoc(page, d.slug || d.id)
      await openSaveDialog(page)
      await page.locator(tid('template-save-dialog')).getByRole('button', { name: /^Save/ }).click()
      const err = page.locator(tid('template-save-error'))
      await err.waitFor({ timeout: 10000 })
      assert.match(await err.innerText(), /1 MB/)
      assert.equal(await page.locator(tid('template-save-replace')).count(), 0)
      assert.equal(await saveDialog(page).isVisible(), true)
      assert.equal(await templateNamed(be, 'Big one'), undefined)
    } finally { await context.close() }
  })

  it('doc-save-as-template is absent on a pinned revision and on a file route', T, async () => {
    const d = await mkDoc(be, { markdown: '# Pinned\n\nv1\n', sessionName: 'Pinned' })
    const revs = (await api(be, 'GET', `/paste/${d.id}/revisions`)).json
    const hash = (revs.revisions || revs)[0].hash
    const f = await api(be, 'POST', `/paste/${d.id}/files`, { name: 'notes.md', content: '# Notes\n' })
    assert.equal(f.status, 201, f.text)
    const { context, page } = await open(be)
    try {
      await gotoDoc(page, d.slug || d.id)
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('doc-save-as-template')).waitFor({ timeout: 5000 })
      await page.keyboard.press('Escape')
      const routes = [
        [`/d/${d.slug || d.id}@${hash}`, tid('pinned-revision-banner')],
        [`/d/${d.slug || d.id}/notes.md`, `${tid('file-tab')}[aria-selected="true"][data-file="notes.md"]`],
      ]
      for (const [p, ready] of routes) {
        await page.goto(`${BASE}${p}`)
        await page.locator(tid('header-overflow-btn')).waitFor({ timeout: 15000 })
        await page.locator(ready).waitFor({ timeout: 15000 }) // the route is on screen, so the menu reflects it
        await page.locator(tid('header-overflow-btn')).click()
        await page.locator(tid('header-overflow-menu')).waitFor({ timeout: 5000 })
        assert.equal(await page.locator(tid('doc-save-as-template')).count(), 0, `${p}: no save-as-template`)
        await page.keyboard.press('Escape')
      }
    } finally { await context.close() }
  })

  it("deleting a template's default collection: the picker defaults to Unfiled and the doc lands unfiled", T, async () => {
    const col = (await api(be, 'POST', '/library/collections', { name: `Temp ${uniq()}` })).json
    const t = (await api(be, 'POST', '/templates', { name: 'Orphaned default', content: '# {{title}}\n', collectionId: col.id })).json
    assert.equal(t.collectionId, col.id)
    assert.equal((await api(be, 'DELETE', `/library/collections/${col.id}`)).status, 204)
    const { context, page } = await open(be)
    try {
      await openPickerFromLanding(page)
      await chooseTemplate(page, 'Orphaned default')
      assert.equal(await page.locator(tid('template-collection-select')).inputValue(), '')
      await page.locator(tid('template-title-input')).fill('Orphan doc')
      await page.locator(tid('template-title-input')).press('Enter')
      await until(async () => /^\/d\/orphan-doc/.test(here(page).pathname), { timeout: 15000, what: '/d/orphan-doc' })
      const lib = await docLibrary(be, here(page).pathname.split('/').pop())
      assert.equal(lib.collection, null)
    } finally { await context.close() }
  })

  it('AC-27.11 Templates tab: seeds have the badge and no menu; rename and delete a user template; docs made from it still open', T, async () => {
    const { context, page, errors } = await open(be)
    try {
      await page.goto(`${BASE}/library?tab=templates`)
      await page.locator(tid('template-item')).first().waitFor({ timeout: 15000 })
      assert.equal(await page.locator(tid('library-tab-templates')).getAttribute('aria-current'), 'page')
      assert.equal(await page.locator(tid('library-tab-templates')).getAttribute('href'), '/library?tab=templates')
      assert.equal(await page.getByRole('navigation', { name: 'Library sections' }).getByRole('link', { name: 'Documents' }).getAttribute('aria-current'), null)
      const item = (name) => page.locator(tid('template-item')).filter({ has: page.locator('.tpl-name', { hasText: new RegExp(`^${name}$`) }) })
      for (const seed of ['Weekly leadership update', 'Design doc', 'QA findings', 'PR review', 'Research brief']) {
        assert.equal(await item(seed).locator(tid('template-builtin-badge')).count(), 1, seed)
        assert.equal(await item(seed).locator(tid('template-menu')).count(), 0, seed)
      }
      // template-use opens the picker with that template preselected.
      await item('Design doc').locator(tid('template-use')).click()
      await page.locator(tid('template-title-input')).waitFor({ timeout: 10000 })
      assert.match(await picker(page).innerText(), /Design doc/)
      await page.keyboard.press('Escape')
      await picker(page).waitFor({ state: 'detached', timeout: 5000 })
      // Rename (same name rules: a builtin's name is refused).
      await item('Drafty template').locator(tid('template-menu')).click()
      await page.getByRole('menuitem', { name: 'Rename' }).click()
      const input = page.locator('.tpl-rename-input')
      await input.fill('QA Findings')
      await input.press('Enter')
      await page.locator('.tpl-error').waitFor({ timeout: 5000 })
      await input.fill('Drafty renamed')
      await input.press('Enter')
      await item('Drafty renamed').waitFor({ timeout: 5000 })
      assert.ok(await templateNamed(be, 'Drafty renamed'))
      // Delete "Incident review" (Outage 12 was made from it).
      await item('Incident review').locator(tid('template-menu')).click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      const confirm = page.locator(tid('template-delete-confirm'))
      await confirm.waitFor({ timeout: 5000 })
      await confirm.locator(tid('library-confirm-ok')).click()
      await item('Incident review').waitFor({ state: 'detached', timeout: 5000 })
      assert.equal(await templateNamed(be, 'Incident review'), undefined)
      await gotoDoc(page, made.outage)
      assert.match(await page.locator('.preview-pane').innerText(), /Outage 12/)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('library-new-from-template opens the picker from the library header', T, async () => {
    const { context, page } = await open(be)
    try {
      await page.goto(`${BASE}/library`)
      await page.locator(tid('library-new-from-template')).click()
      await picker(page).waitFor({ timeout: 10000 })
      await page.locator(tid('template-picker-item')).first().waitFor({ timeout: 10000 })
    } finally { await context.close() }
  })
})

// ── the filter box (> 8 templates), fresh backend ──────────────────────────

describe('#27 templates — the picker filter box', () => {
  let be
  before(async () => { be = await privateBackend() })
  after(async () => { await be?.stop() })

  it('no filter with 5 templates; with 9 the filter appears and narrows the list', T, async () => {
    const { context, page } = await open(be)
    try {
      await openPickerFromLanding(page)
      assert.equal(await page.locator(tid('template-picker-item')).count(), 5)
      assert.equal(await page.locator(tid('template-picker-filter')).count(), 0)
      await page.keyboard.press('Escape')
      for (const n of ['Alpha one', 'Beta two', 'Gamma three', 'Delta four']) {
        assert.equal((await api(be, 'POST', '/templates', { name: n, content: `# {{title}}\n${n}\n` })).status, 201)
      }
      await page.locator(tid('landing-new-from-template')).click()
      await page.locator(tid('template-picker-item')).first().waitFor({ timeout: 10000 })
      assert.equal(await page.locator(tid('template-picker-item')).count(), 9)
      const filter = page.locator(tid('template-picker-filter'))
      await filter.waitFor()
      await filter.fill('gamma')
      await until(async () => (await page.locator(tid('template-picker-item')).count()) === 1, { what: 'one match' })
      assert.match(await page.locator(tid('template-picker-item')).innerText(), /Gamma three/)
    } finally { await context.close() }
  })

  it('AC-27.15 phone 390×844: the picker fills the width, no horizontal scroll, create reachable', T, async () => {
    const { context, page } = await open(be, { viewport: PHONE })
    try {
      await openPickerFromLanding(page)
      const box = await picker(page).locator('.tp-dialog').boundingBox()
      assert.ok(box && box.x <= 1 && box.width >= 388, `picker box ${JSON.stringify(box)}`)
      await chooseTemplate(page, 'Weekly leadership update')
      await page.locator(tid('template-title-input')).fill('Phone doc')
      const create = page.locator(tid('template-create-btn'))
      await create.scrollIntoViewIfNeeded()
      const b = await create.boundingBox()
      assert.ok(b && b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 844, `create button ${JSON.stringify(b)}`)
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement
        const dlg = document.querySelector('.tp-dialog')
        return { page: el.scrollWidth - el.clientWidth, dialog: dlg ? dlg.scrollWidth - dlg.clientWidth : 0 }
      })
      assert.ok(overflow.page <= 0 && overflow.dialog <= 0, `horizontal overflow ${JSON.stringify(overflow)}`)
    } finally { await context.close() }
  })

  it('screenshots: picker and save dialog at 390×844 and 1400×900 in all 6 themes', { ...T, timeout: 300_000, skip: process.env.QA27_SHOTS ? false : 'set QA27_SHOTS=1' }, async () => {
    mkdirSync(SHOTS, { recursive: true })
    const d = await mkDoc(be, { markdown: '# Shot doc\n\nBody.\n', sessionName: 'Shot doc' })
    for (const theme of THEMES) {
      for (const [vp, viewport] of [['phone', PHONE], ['desktop', DESKTOP]]) {
        const { context, page } = await open(be, { viewport, theme, reviewer: 'Asha' })
        try {
          await openPickerFromLanding(page)
          await page.screenshot({ path: path.join(SHOTS, `${theme}-${vp}-picker-list.png`) })
          await chooseTemplate(page, 'Weekly leadership update')
          await page.locator(tid('template-title-input')).fill('Ops W41')
          await page.locator(`${tid('template-preview')} h1`, { hasText: 'Ops W41' }).waitFor({ timeout: 3000 })
          await page.screenshot({ path: path.join(SHOTS, `${theme}-${vp}-picker-form.png`) })
          await page.keyboard.press('Escape')
          await gotoDoc(page, d.slug || d.id)
          await openSaveDialog(page)
          await page.screenshot({ path: path.join(SHOTS, `${theme}-${vp}-save.png`) })
        } finally { await context.close() }
      }
    }
  })
})
