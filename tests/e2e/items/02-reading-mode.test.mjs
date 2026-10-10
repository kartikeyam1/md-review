// #2 Reading mode by default + per-doc publish|review mode — frozen acceptance
// tests (docs/build/specs/02-reading-mode.md, 00-cross-cutting.md §1–§3, §10).
//
// Runs on vite dev at base `/` (scripts/verify.sh) and assumes #4's routes:
// docs open at /d/<slug||id>, views via ?view=, pinned revisions at
// /d/<id>@<hash>. Before #23 every shared doc is editor-capable and the only
// viewer is a pinned revision (00 §1.2), which is what AC-02.9 uses.
//
// Sessions are created through the throwaway backend; `mode` is passed
// explicitly whenever a test depends on it, except AC-02.1, which checks the
// no-mode default.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, installUrlRecorder, waitForDoc } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

const FIXTURE = fileURLToPath(new URL('../fixture.md', import.meta.url))

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

/** Fresh context (no persisted drafts or reviewer name), desktop by default. */
async function open({ viewport = { width: 1400, height: 900 }, fixedTime, recorder = true, init } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  if (fixedTime !== undefined) await context.clock.setFixedTime(fixedTime)
  if (recorder) await installUrlRecorder(context)
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  return { context, page }
}

const docKey = (doc) => doc.slug || doc.id
const docUrl = (doc, rest = '') => `${BASE}/d/${docKey(doc)}${rest}`

async function openDoc(page, doc, text, rest = '') {
  await page.goto(docUrl(doc, rest))
  await waitForDoc(page, text)
  await page.locator(tid('doc-header')).first().waitFor({ state: 'visible', timeout: 10000 })
}

/** Post a comment the way an agent does (REST, not the UI). */
async function addComment(id, { body, author = 'agent', category = 'suggestion', line = 2, selectedText = 'body' }) {
  const res = await fetch(`${API}/paste/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startLine: line, endLine: line, selectedText, body, category, author }),
  })
  assert.equal(res.status, 201, `POST comment: ${res.status} ${await res.text()}`)
}

async function serverMeta(id) {
  const res = await fetch(`${API}/paste/${id}?fields=meta`)
  assert.equal(res.status, 200)
  return res.json()
}

const appAttr = (page, name) => page.locator('.app').first().getAttribute(`data-${name}`)

/** Open the overflow menu (no-op when it is already open — a second click on the trigger would close it). */
async function openOverflow(page) {
  const menu = page.locator(tid('header-overflow-menu'))
  if (!(await menu.isVisible().catch(() => false))) await page.locator(tid('header-overflow-btn')).click()
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  return menu
}

async function setProbe(page) {
  const token = uniq('probe')
  await page.evaluate((t) => { window.__probe = t }, token)
  return token
}
const probe = (page) => page.evaluate(() => window.__probe ?? null)

/** Make every PUT /paste/:id/meta answer 500. */
async function failMetaWrites(page) {
  await page.route((url) => url.href.startsWith(API) && /\/paste\/[^/]+\/meta$/.test(url.pathname), (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced by test"}' })
  })
}

async function clickModeRadio(page, mode) {
  await openOverflow(page)
  await page.locator(tid(`doc-mode-${mode}`)).click()
}

/** Index of document.activeElement among the menu's items (-1 if focus is elsewhere). */
const focusedItem = (page) => page.evaluate(() => {
  const menu = document.querySelector('[data-testid="header-overflow-menu"]')
  if (!menu) return { index: -1, count: 0, checked: false }
  const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
  const a = document.activeElement
  return { index: items.indexOf(a), count: items.length, checked: a?.getAttribute('aria-checked') === 'true' }
})

/** Select an element's whole text with a mouse drag (down at the first char, up past the last). */
async function dragSelect(page, locator) {
  const pts = await locator.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) })
    const first = walker.nextNode()
    let last = first
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n
    const r1 = document.createRange(); r1.setStart(first, 0); r1.setEnd(first, 1)
    const r2 = document.createRange(); r2.setStart(last, last.textContent.length - 1); r2.setEnd(last, last.textContent.length)
    const a = r1.getBoundingClientRect(); const b = r2.getBoundingClientRect()
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right + 4, y2: b.top + b.height / 2 }
  })
  await page.mouse.move(pts.x1, pts.y1)
  await page.mouse.down()
  await page.mouse.move((pts.x1 + pts.x2) / 2, pts.y2, { steps: 5 })
  await page.mouse.move(pts.x2, pts.y2, { steps: 5 })
  await page.mouse.up()
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// ── Default: publish reading page ────────────────────────────────────────────
describe('#2 reading mode — publish by default', () => {
  it('AC-02.1 a POST /paste doc without mode opens as a clean reading page for the editor', T, async () => {
    const name = uniq('Plain reading page')
    const doc = await createDoc({ markdown: '# Plain page\n\nPublish body text (AC-02.1).\n', filename: 'plain.md', sessionName: name })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Publish body text (AC-02.1).')
      const header = page.locator(tid('doc-header'))
      assert.equal(await header.getAttribute('data-variant'), 'reader')
      assert.equal(norm(await header.locator(tid('doc-title')).textContent()), name, 'doc-title shows the session name')

      assert.equal(await appAttr(page, 'view'), 'read')
      assert.equal(await appAttr(page, 'mode'), 'publish')
      assert.equal(await appAttr(page, 'capability'), 'editor')

      for (const sel of ['.sidebar', '.approval-banner', '.summary-panel', '.cm-editor']) {
        assert.equal(await page.locator(sel).count(), 0, `${sel} is absent from the DOM`)
      }
      assert.equal(await page.getByRole('button', { name: /generate prompt/i }).count(), 0, 'no Generate Prompt button')
      assert.equal(await page.getByText(/generate prompt/i).count(), 0, 'no "Generate Prompt" text anywhere')

      await openOverflow(page)
      assert.equal(await page.locator(tid('menu-generate-prompt')).count(), 0, 'no menu-generate-prompt in publish mode')
      assert.equal(await page.getByText(/generate prompt/i).count(), 0, 'no "Generate Prompt" in the open menu either')
    } finally { await context.close() }
  })
})

// ── Review mode ──────────────────────────────────────────────────────────────
describe('#2 reading mode — review docs', () => {
  it('AC-02.4 a review doc with 2 comments shows both in the sidebar, the Review badge and menu-generate-prompt', T, async () => {
    const doc = await createDoc({ markdown: '# Review doc\n\nbody of the review doc (AC-02.4).\n', filename: 'review.md', sessionName: uniq('Review doc'), mode: 'review' })
    const bodies = [uniq('First review comment'), uniq('Second review comment')]
    for (const body of bodies) await addComment(doc.id, { body })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the review doc (AC-02.4).')
      assert.equal(await appAttr(page, 'mode'), 'review')
      const sidebar = page.locator('.sidebar')
      await sidebar.waitFor({ state: 'visible', timeout: 5000 })
      for (const body of bodies) {
        await sidebar.getByText(body).first().waitFor({ state: 'visible', timeout: 5000 })
      }
      assert.equal(await sidebar.locator('.comment-card').count(), 2, 'the sidebar lists exactly the 2 comments')
      assert.equal(norm(await page.locator(tid('doc-mode-badge')).textContent()), 'Review')

      await openOverflow(page)
      await page.locator(tid('menu-generate-prompt')).waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-02.12 /?filePath=<fixture> opens in review mode with the sidebar and the selection action bar', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`)
      const para = page.locator('.preview-pane p').filter({ hasText: 'This is a paragraph for testing inline comments.' }).first()
      await para.waitFor({ state: 'visible', timeout: 15000 })
      assert.equal(await appAttr(page, 'mode'), 'review')
      assert.equal(await appAttr(page, 'capability'), 'editor')
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })

      await para.click({ clickCount: 3 })
      await page.locator('.selection-action-bar').waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })
})

// ── Publish hides review UI ──────────────────────────────────────────────────
describe('#2 reading mode — publish hides review UI', () => {
  it('AC-02.5 a publish doc with 3 API comments reports them hidden and never renders their text', T, async () => {
    const doc = await createDoc({ markdown: '# Published\n\nbody of the published doc (AC-02.5).\n', filename: 'pub.md', sessionName: uniq('Published'), mode: 'publish' })
    const author = uniq('hidden-agent')
    const bodies = [uniq('HiddenCommentAlpha'), uniq('HiddenCommentBravo'), uniq('HiddenCommentCharlie')]
    for (const body of bodies) await addComment(doc.id, { body, author, category: body.includes('Alpha') ? 'must-fix' : 'suggestion' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the published doc (AC-02.5).')
      await openOverflow(page)
      const hidden = page.locator(tid('doc-mode-hidden-comments'))
      await hidden.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(norm(await hidden.textContent()), /(^|\D)3(\D|$)/, 'mentions the 3 hidden comments')

      const html = await page.evaluate(() => document.documentElement.outerHTML)
      for (const s of [...bodies, author]) assert.ok(!html.includes(s), `"${s}" must not appear anywhere in the page`)
      assert.equal(await page.locator('.sidebar').count(), 0, 'no comments sidebar')
      assert.equal(await page.locator('.comment-highlight').count(), 0, 'no comment highlights')
      assert.equal(await page.locator('.approval-banner').count(), 0, 'no approval UI even with a must-fix comment')
    } finally { await context.close() }
  })

  it('AC-02.6 selecting a paragraph in a publish doc is plain browser selection (no action bar, popover or highlight)', T, async () => {
    const text = 'A plain paragraph for a reader to select with the mouse (AC-02.6).'
    const doc = await createDoc({ markdown: `# Select me\n\n${text}\n\nSecond paragraph.\n`, filename: 'select.md', sessionName: uniq('Select'), mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, text)
      const para = page.locator('.preview-pane p').filter({ hasText: text }).first()
      await dragSelect(page, para)
      assert.equal(norm(await page.evaluate(() => window.getSelection().toString())), text, 'the drag selected the paragraph')
      // Give any selection handler time to react (it debounces at most a few hundred ms).
      await page.waitForTimeout(450)
      assert.equal(await page.locator('.selection-action-bar').filter({ visible: true }).count(), 0, 'no selection action bar')
      assert.equal(await page.locator('.popover').filter({ visible: true }).count(), 0, 'no comment popover')
      assert.equal(await page.evaluate(() => (typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('preview-selection') : false)), false, 'no persisted selection highlight')
      assert.equal(norm(await page.evaluate(() => window.getSelection().toString())), text, 'the browser selection is left intact')
    } finally { await context.close() }
  })
})

// ── Changing mode ────────────────────────────────────────────────────────────
describe('#2 reading mode — switching mode', () => {
  it('AC-02.7 switching publish → review shows the sidebar without reload, PUTs {mode:"review"} and reaches a second reader within 7 s', T, async () => {
    const doc = await createDoc({ markdown: '# Switch\n\nbody of the switch doc (AC-02.7).\n', filename: 'switch.md', sessionName: uniq('Switch'), mode: 'publish' })
    const a = await open()
    const b = await open()
    try {
      await openDoc(b.page, doc, 'body of the switch doc (AC-02.7).')
      assert.equal(await b.page.locator('.sidebar').count(), 0, 'second reader starts without a sidebar')

      await openDoc(a.page, doc, 'body of the switch doc (AC-02.7).')
      assert.equal(await a.page.locator('.sidebar').count(), 0)
      const token = await setProbe(a.page)
      const put = a.page.waitForRequest((r) => r.method() === 'PUT' && r.url().startsWith(API) && /\/paste\/[^/]+\/meta$/.test(new URL(r.url()).pathname), { timeout: 10000 })
      const resp = a.page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().startsWith(API) && /\/meta$/.test(new URL(r.url()).pathname), { timeout: 10000 })

      await clickModeRadio(a.page, 'review')
      await a.page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await probe(a.page), token, 'no page reload')
      assert.equal(await appAttr(a.page, 'mode'), 'review')

      const req = await put
      assert.equal(req.postDataJSON()?.mode, 'review', `PUT body: ${req.postData()}`)
      assert.equal((await resp).status(), 200)
      assert.equal((await serverMeta(doc.id)).mode, 'review')

      await b.page.locator('.sidebar').waitFor({ state: 'visible', timeout: 7000 })

      await openOverflow(a.page)
      assert.equal(await a.page.locator(tid('doc-mode-review')).getAttribute('aria-checked'), 'true')
      assert.equal(await a.page.locator(tid('doc-mode-publish')).getAttribute('aria-checked'), 'false')
    } finally { await a.context.close(); await b.context.close() }
  })

  it('AC-02.8 a failing PUT /paste/:id/meta restores the previous mode and raises an error toast', T, async () => {
    const doc = await createDoc({ markdown: '# Fail\n\nbody of the failing switch (AC-02.8).\n', filename: 'fail.md', sessionName: uniq('Fail switch'), mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the failing switch (AC-02.8).')
      await failMetaWrites(page)
      await clickModeRadio(page, 'review')

      const toast = page.locator(`${tid('app-toast')}[data-kind="error"]`).first()
      await toast.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(norm(await toast.textContent()), /couldn.t change the document mode/i)
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-mode') === 'publish' && !document.querySelector('.sidebar'), null, { timeout: 5000 })
      assert.equal((await serverMeta(doc.id)).mode, 'publish', 'server unchanged')

      await openOverflow(page)
      assert.equal(await page.locator(tid('doc-mode-publish')).getAttribute('aria-checked'), 'true', 'the publish radio is checked again')
    } finally { await context.close() }
  })
})

// ── Viewer capability ────────────────────────────────────────────────────────
describe('#2 reading mode — viewers', () => {
  it('AC-02.9 a viewer (pinned revision) of a review doc gets comments and approval but no edit, share, mode or restore', T, async () => {
    const doc = await createDoc({ markdown: '# Viewer doc\n\nVersion ONE for the viewer (AC-02.9).\n', filename: 'viewer.md', sessionName: uniq('Viewer'), mode: 'review', author: 'Alice' })
    await putMarkdown(doc.id, '# Viewer doc\n\nVersion TWO for the viewer (AC-02.9).\n', { author: 'Bob' })
    await addComment(doc.id, { body: uniq('Viewer-visible comment') })
    const list = await listRevisions(doc.id)
    const H = list.revisions.find((r) => r.hash !== list.current)?.hash
    assert.match(H ?? '', /^[0-9a-f]{32}$/)

    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}@${H}`)
      await waitForDoc(page, 'Version ONE for the viewer (AC-02.9).')
      await page.locator(tid('doc-header')).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await appAttr(page, 'capability'), 'viewer')
      assert.equal(await appAttr(page, 'mode'), 'review')

      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })
      await page.locator('.approval-banner').waitFor({ state: 'visible', timeout: 5000 })
      for (const id of ['view-toggle', 'view-toggle-read', 'view-toggle-edit', 'share-btn']) {
        assert.equal(await page.locator(tid(id)).count(), 0, `${id} is absent for a viewer`)
      }

      await openOverflow(page)
      for (const id of ['doc-mode-publish', 'doc-mode-review']) {
        assert.equal(await page.locator(tid(id)).count(), 0, `${id} is absent for a viewer`)
      }
      await page.locator(tid('menu-history')).click()
      const modal = page.locator(tid('revisions-modal'))
      await modal.waitFor({ state: 'visible', timeout: 5000 })
      const items = modal.locator('.rev-item')
      const n = await items.count()
      assert.ok(n >= 2, `history lists both revisions (${n})`)
      for (let i = 0; i < n; i++) {
        await items.nth(i).click()
        await page.waitForFunction(() => {
          const m = document.querySelector('[data-testid="revisions-modal"]')
          const status = m?.querySelector('.rev-status')?.textContent ?? ''
          return !!m && !/loading/i.test(status) && !!(m.querySelector('[data-testid="diff-stats"]') || status)
        }, null, { timeout: 5000 })
        assert.equal(await page.locator(tid('restore-revision')).count(), 0, `no restore-revision for a viewer (revision ${i})`)
      }
    } finally { await context.close() }
  })
})

// ── Reader header details ────────────────────────────────────────────────────
describe('#2 reading mode — reader header', () => {
  it('AC-02.10 doc-updated reads "Updated 3 h ago by agent" with the revision time in datetime', T, async () => {
    const doc = await createDoc({ markdown: '# Updated\n\nbody of the updated doc (AC-02.10).\n', filename: 'updated.md', sessionName: uniq('Updated'), author: 'agent' })
    const meta = await serverMeta(doc.id)
    const at = meta.latest_revision?.at
    assert.ok(at, `latest_revision.at: ${JSON.stringify(meta.latest_revision)}`)
    assert.equal(meta.latest_revision.by, 'agent')
    const { context, page } = await open({ fixedTime: Date.parse(at) + 3 * 3600_000 + 60_000 })
    try {
      await openDoc(page, doc, 'body of the updated doc (AC-02.10).')
      const updated = page.locator(tid('doc-updated'))
      await updated.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await updated.evaluate((el) => el.tagName), 'TIME')
      assert.equal(norm(await updated.textContent()), 'Updated 3 h ago by agent')
      assert.equal(await updated.getAttribute('datetime'), at)
      assert.ok(norm(await updated.getAttribute('title')).length > 0, 'absolute local date-time in title')
    } finally { await context.close() }
  })

  it('AC-02.14 copy-link-btn copies exactly <origin><base>d/<slug> and shows "Link copied"', T, async () => {
    const doc = await createDoc({ markdown: '# Copy link\n\nTop text (AC-02.14).\n\n## Intro\n\nIntro text.\n', filename: 'copy.md', sessionName: uniq('Copy link') })
    assert.ok(doc.slug, 'server assigned a slug')
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Top text (AC-02.14).', '?view=read#intro')
      await page.locator(tid('copy-link-btn')).click()
      await page.waitForFunction(() => (window.__mdr?.clipboard?.length ?? 0) > 0, null, { timeout: 5000 })
      const clip = await page.evaluate(() => window.__mdr.clipboard)
      assert.equal(clip[clip.length - 1], `${BASE}/d/${doc.slug}`)
      const toast = page.locator(tid('app-toast')).filter({ hasText: 'Link copied' }).first()
      await toast.waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-02.14 (rule 8) a clipboard failure raises an error toast that contains the URL', T, async () => {
    const doc = await createDoc({ markdown: '# Copy fail\n\nbody of copy fail (AC-02.14).\n', filename: 'copyfail.md', sessionName: uniq('Copy fail') })
    const { context, page } = await open({
      recorder: false,
      init: () => {
        try {
          if (navigator.clipboard) {
            navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
            navigator.clipboard.write = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
          }
        } catch { /* ignore */ }
        document.execCommand = () => false
      },
    })
    try {
      await openDoc(page, doc, 'body of copy fail (AC-02.14).')
      await page.locator(tid('copy-link-btn')).click()
      const toast = page.locator(`${tid('app-toast')}[data-kind="error"]`).first()
      await toast.waitFor({ state: 'visible', timeout: 5000 })
      assert.ok(norm(await toast.textContent()).includes(`${BASE}/d/${docKey(doc)}`), `toast text: ${await toast.textContent()}`)
    } finally { await context.close() }
  })

  it('AC-02.18 at 1400×900 a review doc header follows the 00 §2.2 order; theme-toggle is the first .btn-icon', T, async () => {
    const doc = await createDoc({ markdown: '# Order\n\nbody of the order doc (AC-02.18).\n', filename: 'order.md', sessionName: uniq('Order'), mode: 'review' })
    const { context, page } = await open({ viewport: { width: 1400, height: 900 } })
    try {
      await openDoc(page, doc, 'body of the order doc (AC-02.18).')
      const ORDER = [
        'toc-toggle', 'app-home-link', 'nav-library', 'doc-title', 'doc-updated', 'doc-local-badge', 'doc-mode-badge',
        'view-stats', 'reviewer-name', 'view-toggle', 'slides-enter-btn', 'share-btn', 'copy-link-btn',
        'download-menu-btn', 'theme-toggle', 'theme-style-menu', 'reader-settings-btn', 'header-overflow-btn',
      ]
      const REQUIRED = ['app-home-link', 'nav-library', 'doc-title', 'doc-updated', 'doc-mode-badge', 'reviewer-name',
        'view-toggle', 'share-btn', 'copy-link-btn', 'theme-toggle', 'header-overflow-btn']
      const found = await page.evaluate((order) => {
        const header = document.querySelector('[data-testid="doc-header"]')
        return order.map((id) => {
          const el = header?.querySelector(`[data-testid="${id}"]`)
          if (!el) return { id, present: false }
          const r = el.getBoundingClientRect()
          return { id, present: true, visible: r.width > 0 && r.height > 0, left: r.left }
        })
      }, ORDER)
      for (const id of REQUIRED) {
        const f = found.find((x) => x.id === id)
        assert.ok(f.present && f.visible, `${id} is visible in doc-header at 1400px`)
      }
      const present = found.filter((x) => x.present)
      const domOrder = await page.evaluate((ids) => {
        const header = document.querySelector('[data-testid="doc-header"]')
        const els = ids.map((id) => header.querySelector(`[data-testid="${id}"]`))
        const bad = []
        for (let i = 1; i < els.length; i++) {
          if (!(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) bad.push(`${ids[i - 1]} !< ${ids[i]}`)
        }
        return bad
      }, present.map((x) => x.id))
      assert.deepEqual(domOrder, [], `DOM order follows 00 §2.2: ${present.map((x) => x.id).join(' → ')}`)
      const visible = present.filter((x) => x.visible)
      for (let i = 1; i < visible.length; i++) {
        assert.ok(visible[i].left > visible[i - 1].left, `${visible[i - 1].id} is left of ${visible[i].id} on screen`)
      }

      const firstIcon = await page.evaluate(() => document.querySelector('.btn-icon')?.getAttribute('data-testid') ?? null)
      assert.equal(firstIcon, 'theme-toggle', 'the first .btn-icon in the document is theme-toggle')
    } finally { await context.close() }
  })

  it('AC-02.18 (rule 5) the reader header carries no editor-only controls', T, async () => {
    const doc = await createDoc({ markdown: '# Reader chrome\n\nbody of the reader chrome doc (AC-02.18).\n', filename: 'chrome.md', sessionName: uniq('Reader chrome'), mode: 'review' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the reader chrome doc (AC-02.18).')
      assert.equal(await page.locator(tid('doc-header')).getAttribute('data-variant'), 'reader')
      for (const sel of ['.sync-indicator', '.paste-id', '.filename', '.doc-stats', tid('history-button')]) {
        assert.equal(await page.locator(sel).count(), 0, `${sel} is not rendered in the read view`)
      }
      assert.equal(await page.locator(tid('save-state')).filter({ visible: true }).count(), 0, 'no save-state while idle')
    } finally { await context.close() }
  })
})

// ── Edit view ────────────────────────────────────────────────────────────────
describe('#2 reading mode — edit view', () => {
  it('AC-02.15 read → edit → read on a review doc: ?view=edit then ?view=read, sidebar in both, no save-state after a save', T, async () => {
    const doc = await createDoc({ markdown: '# Edit me\n\nbody of the editable review doc (AC-02.15).\n', filename: 'edit.md', sessionName: uniq('Edit me'), mode: 'review' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the editable review doc (AC-02.15).')
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })

      await page.locator(tid('view-toggle-edit')).click()
      await page.waitForFunction(() => location.search === '?view=edit', null, { timeout: 5000 })
      assert.equal(await page.locator(tid('doc-header')).getAttribute('data-variant'), 'editor')
      await page.locator('.cm-content').waitFor({ state: 'visible', timeout: 15000 })
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })

      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().startsWith(API) && /\/paste\/[^/]+\/markdown$/.test(new URL(r.url()).pathname), { timeout: 15000 })
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nEdited line AC-02.15.')
      assert.equal((await saved).status(), 200, 'autosave succeeded')
      await page.locator(tid('save-state')).waitFor({ state: 'hidden', timeout: 3000 })

      await page.locator(tid('view-toggle-read')).click()
      await page.waitForFunction(() => location.search === '?view=read', null, { timeout: 5000 })
      await waitForDoc(page, 'Edited line AC-02.15.')
      assert.equal(await page.locator(tid('doc-header')).getAttribute('data-variant'), 'reader')
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await page.locator(tid('save-state')).filter({ visible: true }).count(), 0, 'no save-state after the save')
    } finally { await context.close() }
  })
})

// ── Toasts ───────────────────────────────────────────────────────────────────
describe('#2 reading mode — AppToast', () => {
  it('AC-02.16 an error toast is role=alert, closes via app-toast-close, and otherwise auto-dismisses after ~8 s', T, async () => {
    const doc = await createDoc({ markdown: '# Toast\n\nbody of the toast doc (AC-02.16).\n', filename: 'toast.md', sessionName: uniq('Toast'), mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the toast doc (AC-02.16).')
      await failMetaWrites(page)
      const errorToasts = page.locator(`${tid('app-toast')}[data-kind="error"]`)

      await clickModeRadio(page, 'review')
      const toast = errorToasts.first()
      await toast.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await toast.getAttribute('role'), 'alert')
      await toast.locator(tid('app-toast-close')).click()
      await page.waitForFunction(() => !document.querySelector('[data-testid="app-toast"][data-kind="error"]'), null, { timeout: 2000 })

      // Second failure: leave it alone and time the auto-dismiss.
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-mode') === 'publish', null, { timeout: 5000 })
      await clickModeRadio(page, 'review')
      await errorToasts.first().waitFor({ state: 'visible', timeout: 5000 })
      const t0 = Date.now()
      await page.waitForFunction(() => !document.querySelector('[data-testid="app-toast"][data-kind="error"]'), null, { timeout: 12000 })
      const ms = Date.now() - t0
      assert.ok(ms >= 6000 && ms <= 10500, `error toast auto-dismissed after ${ms} ms (~8 s expected)`)
    } finally { await context.close() }
  })

  it('AC-02.16 an info toast ("Link copied") is role=status and auto-dismisses after ~4 s', T, async () => {
    const doc = await createDoc({ markdown: '# Info toast\n\nbody of the info toast doc (AC-02.16).\n', filename: 'info.md', sessionName: uniq('Info toast') })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the info toast doc (AC-02.16).')
      await page.locator(tid('copy-link-btn')).click()
      const toast = page.locator(tid('app-toast')).filter({ hasText: 'Link copied' }).first()
      await toast.waitFor({ state: 'visible', timeout: 3000 })
      const t0 = Date.now()
      assert.equal(await toast.getAttribute('role'), 'status')
      assert.ok(['info', 'success'].includes(await toast.getAttribute('data-kind')), 'kind is info or success')
      await toast.waitFor({ state: 'detached', timeout: 8000 })
      const ms = Date.now() - t0
      assert.ok(ms >= 2500 && ms <= 6000, `info toast auto-dismissed after ${ms} ms (~4 s expected)`)
    } finally { await context.close() }
  })
})

// ── Overflow menu keyboard + a11y ────────────────────────────────────────────
describe('#2 reading mode — overflow menu', () => {
  it('AC-02.17 keyboard model: Enter opens on the first item, arrows wrap, Home/End jump, Esc returns focus, outside click closes', T, async () => {
    const doc = await createDoc({ markdown: '# Menu\n\nbody of the menu doc (AC-02.17).\n', filename: 'menu.md', sessionName: uniq('Menu'), mode: 'review' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the menu doc (AC-02.17).')
      const btn = page.locator(tid('header-overflow-btn'))
      const menu = page.locator(tid('header-overflow-menu'))
      assert.equal(await btn.getAttribute('aria-haspopup'), 'menu')
      assert.equal(await btn.getAttribute('aria-expanded'), 'false')

      await btn.focus()
      await page.keyboard.press('Enter')
      await menu.waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await btn.getAttribute('aria-expanded'), 'true')
      assert.equal(await menu.getAttribute('role'), 'menu')
      await page.waitForFunction(() => {
        const m = document.querySelector('[data-testid="header-overflow-menu"]')
        return m && m.contains(document.activeElement) && document.activeElement !== m
      }, null, { timeout: 2000 })
      const opened = await focusedItem(page)
      assert.ok(opened.count >= 3, `menu has items (${opened.count})`)
      // AC-02.17 says the first item; 00 §3.2 lets a menu open on its checked radio. Accept either.
      assert.ok(opened.index === 0 || opened.checked, `focus opens on the first item (got index ${opened.index})`)

      const last = opened.count - 1
      await page.keyboard.press('Home')
      assert.equal((await focusedItem(page)).index, 0, 'Home → first')
      await page.keyboard.press('ArrowUp')
      assert.equal((await focusedItem(page)).index, last, 'ArrowUp on the first item wraps to the last')
      await page.keyboard.press('ArrowDown')
      assert.equal((await focusedItem(page)).index, 0, 'ArrowDown on the last item wraps to the first')
      await page.keyboard.press('ArrowDown')
      assert.equal((await focusedItem(page)).index, 1, 'ArrowDown moves by one')
      await page.keyboard.press('End')
      assert.equal((await focusedItem(page)).index, last, 'End → last')
      await page.keyboard.press('Home')
      assert.equal((await focusedItem(page)).index, 0, 'Home → first')

      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden', timeout: 2000 })
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'header-overflow-btn', 'Esc returns focus to the trigger')
      assert.equal(await btn.getAttribute('aria-expanded'), 'false')

      await btn.click()
      await menu.waitFor({ state: 'visible', timeout: 3000 })
      await page.locator('.preview-pane p').filter({ hasText: 'body of the menu doc' }).first().click({ position: { x: 4, y: 4 } })
      await menu.waitFor({ state: 'hidden', timeout: 2000 })
    } finally { await context.close() }
  })

  it('AC-02.17 (a11y) the open menu has menu semantics, radios announce checked state, and no serious axe violations', T, async () => {
    const doc = await createDoc({ markdown: '# Menu a11y\n\nbody of the menu a11y doc (AC-02.17).\n', filename: 'menu-a11y.md', sessionName: uniq('Menu a11y'), mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'body of the menu a11y doc (AC-02.17).')
      const menu = await openOverflow(page)
      const roles = await menu.evaluate((m) => [...m.querySelectorAll('[data-testid^="menu-"], [data-testid^="doc-mode-"]')]
        .filter((el) => el.getAttribute('data-testid') !== 'doc-mode-hidden-comments')
        .map((el) => [el.getAttribute('data-testid'), el.getAttribute('role')]))
      for (const [id, role] of roles) assert.ok(['menuitem', 'menuitemradio'].includes(role), `${id} has role menuitem|menuitemradio (got ${role})`)
      for (const [id, checked] of [['doc-mode-publish', 'true'], ['doc-mode-review', 'false']]) {
        const el = page.locator(tid(id))
        assert.equal(await el.getAttribute('role'), 'menuitemradio', `${id} role`)
        assert.equal(await el.getAttribute('aria-checked'), checked, `${id} aria-checked`)
      }
      const v = await runAxe(page, { include: tid('header-overflow-menu') })
      assert.equal(v.length, 0, formatViolations(v))
    } finally { await context.close() }
  })
})

// ── Local docs ───────────────────────────────────────────────────────────────
describe('#2 reading mode — local docs', () => {
  it('AC-02.11 a file opened via the picker is a publish doc; sharing it POSTs mode:"publish"', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/`)
      const input = page.locator('input[type="file"]').first()
      await input.waitFor({ state: 'attached', timeout: 10000 })
      await input.setInputFiles({ name: 'picked.md', mimeType: 'text/markdown', buffer: Buffer.from('# Picked file\n\nPicked body text (AC-02.11).\n') })
      await waitForDoc(page, 'Picked body text (AC-02.11).')
      assert.equal(await appAttr(page, 'mode'), 'publish')
      assert.equal(await appAttr(page, 'capability'), 'editor')
      assert.equal(await page.locator('.sidebar').count(), 0, 'no comments sidebar')
      await page.locator(tid('doc-local-badge')).waitFor({ state: 'visible', timeout: 5000 })

      const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().startsWith(API) && new URL(r.url()).pathname === '/paste', { timeout: 10000 })
      await page.locator(tid('share-btn')).click()
      const req = await post
      assert.equal(req.postDataJSON()?.mode, 'publish', `POST /paste body mode: ${req.postData()?.slice(0, 200)}`)
    } finally { await context.close() }
  })
})
