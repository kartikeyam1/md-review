// #4 Path-based routes — spec rules without their own AC (docs/build/specs/04-routes.md):
// rule 8 (file route), rule 16 (?embed=1), the d/<ID>/ trailing-slash rewrite,
// the pinned-revision 410 text, rule 9 (restored drafts on the landing route),
// rule 11 (share created / New), and edge cases from the spec's verifier list.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, installUrlRecorder, historyLength, waitForDoc, readingOffset, urlLog } from '../lib/docs.mjs'

const FIXTURE = fileURLToPath(new URL('../fixture.md', import.meta.url))
const T = { timeout: 60_000 }
// 1×1 transparent PNG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open({ viewport = { width: 1400, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  await installUrlRecorder(context)
  const page = await context.newPage()
  return { context, page }
}

const here = (page) => new URL(page.url())

async function waitForPath(page, pathname, { search, hash, timeout = 10000 } = {}) {
  await page.waitForFunction(([p, s, h]) =>
    location.pathname === p && (s === null || location.search === s) && (h === null || location.hash === h),
  [pathname, search ?? null, hash ?? null], { timeout })
}

async function addFile(id, name, content, encoding) {
  const res = await fetch(`${API}/paste/${id}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(encoding ? { name, content, encoding } : { name, content }),
  })
  assert.equal(res.status, 201, `POST /paste/${id}/files ${name}`)
}

// ── rule 8: file routes ─────────────────────────────────────────────────────
describe('#4 routes — file route d/<ID>/<FILE> (rule 8)', () => {
  let doc
  before(async () => {
    doc = await createDoc({ markdown: '# Main\n\nMain doc body (rule 8).', filename: 'main.md', sessionName: uniq('Files') })
    await addFile(doc.id, 'notes/read me.md', '# Notes\n\nNested markdown file body (rule 8).\n')
    await addFile(doc.id, 'page.html', '<!doctype html><html><body><h1 id="top">HTML file body (rule 8)</h1></body></html>')
    await addFile(doc.id, 'pixel.png', PNG_1PX, 'base64')
    await addFile(doc.id, 'data.csv', 'a,b\n1,2\n')
  })

  it('a nested markdown file renders read-only (percent-decoded name, no live-doc fetch)', T, async () => {
    const { context, page } = await open()
    const gets = []
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().startsWith(API + '/paste/')) gets.push(new URL(r.url()).pathname) })
    try {
      await page.goto(`${BASE}/d/${doc.id}/notes/read%20me.md`)
      await waitForDoc(page, 'Nested markdown file body (rule 8).')
      assert.equal(await page.locator('.preview-pane').filter({ hasText: 'Main doc body' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0, 'read-only: no Edit')
      assert.equal(await page.locator('aside.sidebar').filter({ visible: true }).count(), 0, 'no comments sidebar')
      assert.ok(gets.includes(`/paste/${doc.id}/files/notes/read%20me.md`), JSON.stringify(gets))
      assert.ok(!gets.includes(`/paste/${doc.id}`), `no live-doc GET: ${JSON.stringify(gets)}`)
    } finally { await context.close() }
  })

  it('an HTML file renders in the sandboxed iframe', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}/page.html`)
      const handle = await page.locator('iframe.html-frame').elementHandle({ timeout: 15000 })
      let frame = await handle.contentFrame()
      for (let i = 0; i < 50 && !frame; i++) { await page.waitForTimeout(100); frame = await handle.contentFrame() }
      await frame.waitForSelector('#top', { timeout: 10000 })
      assert.match(await frame.textContent('#top'), /HTML file body/)
    } finally { await context.close() }
  })

  it('an image file is shown in an <img>, anything else as a download link', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}/pixel.png`)
      const img = page.locator('.file-view img')
      await img.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await img.evaluate((el) => el.naturalWidth), 1)

      await page.goto(`${BASE}/d/${doc.id}/data.csv`)
      const link = page.locator('.file-view a[download]')
      await link.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(new URL(await link.getAttribute('href')).pathname, `/paste/${doc.id}/files/data.csv`)
    } finally { await context.close() }
  })

  it('a missing file shows doc-not-found', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}/nope.md`)
      await page.locator('[data-testid="doc-not-found"]').waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await page.locator('.upload-area').filter({ visible: true }).count(), 0)
    } finally { await context.close() }
  })
})

// ── rule 16: embed ──────────────────────────────────────────────────────────
describe('#4 routes — ?embed=1 (rule 16)', () => {
  it('shows only the content and an "Open in md-review" link to the same URL without embed', T, async () => {
    const doc = await createDoc({ markdown: '# Embedded\n\nEmbedded body (rule 16).', filename: 'e.md', sessionName: uniq('Embed') })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key}?embed=1&view=edit`)
      await waitForDoc(page, 'Embedded body (rule 16).')
      assert.equal(await page.locator('header').count(), 0, 'no app header')
      assert.equal(await page.locator('aside.sidebar, .notice-bar, .summary-panel').filter({ visible: true }).count(), 0, 'no comments/banners/notices')
      assert.equal(await page.locator('.cm-editor').count(), 0, 'embed forces the read view')
      assert.equal(here(page).searchParams.get('view'), 'edit', 'the view param is ignored, not rewritten')
      const link = page.locator('[data-testid="embed-open-link"]')
      await link.waitFor({ state: 'visible' })
      assert.equal(await link.textContent(), 'Open in md-review')
      assert.equal(await link.getAttribute('target'), '_blank')
      const href = new URL(await link.getAttribute('href'))
      assert.equal(href.pathname, `/d/${key}`)
      assert.equal(href.searchParams.get('embed'), null)
      assert.equal(href.searchParams.get('view'), 'edit')
    } finally { await context.close() }
  })

  it('on a phone the "Open in md-review" link sits below the content, never over it', T, async () => {
    const doc = await createDoc({ markdown: `# Phone embed\n\n${'Embedded phone text. '.repeat(400)}`, filename: 'pe.md' })
    const { context, page } = await open({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(`${BASE}/d/${doc.id}?embed=1`)
      await waitForDoc(page, 'Embedded phone text.')
      const pane = await page.locator('.preview-pane').boundingBox()
      const link = await page.locator('[data-testid="embed-open-link"]').boundingBox()
      assert.ok(link.y >= pane.y + pane.height - 1, `link ${JSON.stringify(link)} overlaps the content ${JSON.stringify(pane)}`)
      assert.ok(link.y + link.height <= 844, 'link is on screen')
    } finally { await context.close() }
  })
})

// ── canonical forms and edge cases ──────────────────────────────────────────
describe('#4 routes — canonical URLs and edge cases', () => {
  it('d/<ID>/ is replaced by d/<ID> without a history entry', T, async () => {
    const doc = await createDoc({ markdown: '# Slash\n\nTrailing slash body.', filename: 's.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}/`)
      await waitForDoc(page, 'Trailing slash body.')
      await waitForPath(page, `/d/${doc.id}`)
      const { initialHistoryLength } = await page.evaluate(() => window.__mdr)
      assert.equal(await historyLength(page), initialHistoryLength)

      await page.goto(`${BASE}/d/${doc.id}//`)
      await waitForDoc(page, 'Trailing slash body.')
      await waitForPath(page, `/d/${doc.id}`)
      await page.goto(`${BASE}/library/`)
      await waitForPath(page, '/library')
      await page.locator('[data-testid="library-page"], .dashboard').first().waitFor({ state: 'visible', timeout: 10000 })
    } finally { await context.close() }
  })

  it('heading ids that look like legacy routes (#dashboard, #shared=x) never redirect on a doc route', T, async () => {
    const doc = await createDoc({ markdown: '# Legacy ids\n\nLegacy-looking fragment body.\n\n## Dashboard\n\ntext', filename: 'l.md' })
    const { context, page } = await open()
    try {
      for (const frag of ['#dashboard', '#shared=abc', '#github=x']) {
        await page.goto(`${BASE}/d/${doc.id}${frag}`)
        await waitForDoc(page, 'Legacy-looking fragment body.')
        assert.equal(here(page).pathname, `/d/${doc.id}`)
        assert.equal(here(page).hash, frag)
      }
    } finally { await context.close() }
  })

  it('d/<ID>@<31 hex> is not-found; a bad %-escape in the fragment does not crash', T, async () => {
    const doc = await createDoc({ markdown: '# Pct\n\nPercent body.', filename: 'p.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}@${'a'.repeat(31)}`)
      await page.locator('[data-testid="not-found"]').waitFor({ state: 'visible', timeout: 10000 })
      await page.goto(`${BASE}/d/${doc.id}#50%-off`)
      await waitForDoc(page, 'Percent body.')
    } finally { await context.close() }
  })

  it('a pinned revision answering 410 shows doc-not-found saying it is no longer stored', T, async () => {
    const doc = await createDoc({ markdown: '# Gone\n\nv1', filename: 'g.md', author: 'Alice' })
    await putMarkdown(doc.id, '# Gone\n\nv2', { author: 'Bob' })
    const list = await listRevisions(doc.id)
    const H = list.revisions.find((r) => r.hash !== list.current).hash
    const { context, page } = await open()
    try {
      await page.route((u) => u.href.startsWith(API) && u.pathname === `/paste/${doc.id}/revisions/${H}`,
        (route) => route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"Revision no longer stored"}' }))
      await page.goto(`${BASE}/d/${doc.id}@${H}`)
      const nf = page.locator('[data-testid="doc-not-found"]')
      await nf.waitFor({ state: 'visible', timeout: 10000 })
      assert.match(await nf.textContent(), /no longer stored/)
    } finally { await context.close() }
  })

  it('offline: a doc with no local copy shows the network notice, not doc-not-found', T, async () => {
    const doc = await createDoc({ markdown: '# Offline\n\nbody', filename: 'o.md' })
    const { context, page } = await open()
    try {
      await page.route((u) => u.href.startsWith(API), (route) => route.abort('connectionrefused'))
      await page.goto(`${BASE}/d/${doc.id}`)
      const n = page.locator('.notice-bar', { hasText: 'Cannot reach the review server' })
      await n.waitFor({ state: 'visible', timeout: 10000 })
      assert.ok(!(await n.textContent()).includes('local copy'), 'no local copy exists — the notice must not claim one')
      assert.equal(await page.locator('[data-testid="doc-not-found"]').count(), 0)
      assert.equal(await page.locator('.upload-area').filter({ visible: true }).count(), 0)
    } finally { await context.close() }
  })

  it('a legacy link with both ?filePath= and #shared= drops filePath', T, async () => {
    const doc = await createDoc({ markdown: '# Both\n\nBoth params body.', filename: 'b.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(FIXTURE)}#shared=${doc.id}`)
      await waitForPath(page, `/d/${doc.id}`, { search: '', hash: '' })
      await waitForDoc(page, 'Both params body.')
    } finally { await context.close() }
  })

  it('#github=<invalid url> shows an error notice and the URL becomes the base', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/#github=not-a-url`)
      const n = page.locator('.notice-bar')
      await n.waitFor({ state: 'visible', timeout: 10000 })
      await waitForPath(page, '/', { search: '', hash: '' })
      const box = await n.boundingBox()
      assert.ok(box && box.y >= 0 && box.y + box.height <= 900, `the error notice is on screen, got ${JSON.stringify(box)}`)
    } finally { await context.close() }
  })
})

// ── rules 9 and 11 ──────────────────────────────────────────────────────────
describe('#4 routes — landing, share and New (rules 9, 11)', () => {
  it('sharing a local doc replaces the URL with d/<id>; New pushes the landing route; Back returns to the doc', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`)
      await waitForDoc(page, 'This is a paragraph for testing inline comments.')
      const before = await historyLength(page)
      await page.locator('header button:has-text("Share")').click()
      await page.waitForFunction(() => /^\/d\/[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(location.pathname), null, { timeout: 10000 })
      assert.equal(here(page).search, '', 'filePath is gone once the doc is shared')
      assert.equal(await historyLength(page), before, 'share uses replaceState')
      const docPath = here(page).pathname
      const shareLink = await page.locator('.modal code').first().textContent()
      assert.equal(new URL(shareLink).pathname, docPath)
      await page.locator('.modal-close').click()

      await page.evaluate(() => { window.__probe = 'p' })
      await page.locator('header button:has-text("New")').click()
      await waitForPath(page, '/')
      await page.locator('.upload-area').waitFor({ state: 'visible' })
      assert.equal(await historyLength(page), before + 1, 'New pushes the landing route')
      await page.goBack()
      await waitForPath(page, docPath)
      await waitForDoc(page, 'This is a paragraph for testing inline comments.')
      assert.equal(await page.evaluate(() => window.__probe), 'p', 'no reload')
    } finally { await context.close() }
  })

  it('a dirty shared draft sends the landing route to d/<id>; a clean one does not', T, async () => {
    const title = uniq('Draft')
    const doc = await createDoc({ markdown: `# ${title}\n\nDraft base body.`, filename: 'draft.md' })
    const { context, page } = await open()
    try {
      // Clean: open the doc, then the landing page — it stays on the landing page.
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Draft base body.')
      await page.waitForTimeout(800) // local persist debounce
      await page.goto(`${BASE}/`)
      await page.locator('.upload-area').waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(here(page).pathname, '/')

      // Dirty: an unsaved edit (server writes stalled) recovers through d/<id>.
      await page.route((u) => u.href.startsWith(API) && /\/paste\/[^/]+\/markdown$/.test(u.pathname), (route) => {
        if (route.request().method() !== 'PUT') return route.continue()
      })
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Draft base body.')
      await page.locator('header button:has-text("Edit")').click()
      const editor = page.locator('.cm-content').first()
      await editor.waitFor({ state: 'visible', timeout: 15000 })
      await editor.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nUnsaved draft line QPX9.')
      await page.waitForTimeout(800)
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await page.goto(`${BASE}/`)
      await waitForPath(page, `/d/${doc.id}`)
      await page.locator('.preview-pane, .cm-content').filter({ hasText: 'Unsaved draft line QPX9.' }).first().waitFor({ state: 'visible', timeout: 15000 })
    } finally { await context.close() }
  })
})

// ── review fix round: leave guard, drafts, stale views, anchors ─────────────
async function typeInEditor(page, text) {
  await page.locator('header button:has-text("Edit")').click()
  const editor = page.locator('.cm-content').first()
  await editor.waitFor({ state: 'visible', timeout: 15000 })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
  await page.locator('header button:has-text("Preview")').click()
}

const stallWrites = (page) => page.route((u) => u.href.startsWith(API) && /\/paste\/[^/]+\/markdown$/.test(u.pathname), (route) => {
  if (route.request().method() !== 'PUT') return route.continue()
})

describe('#4 routes — leaving a doc with unsaved edits (rule 13)', () => {
  it('Back to the library and an in-doc link both ask while the doc stays on screen; cancel keeps it, accept discards once', T, async () => {
    const nameA = uniq('Guard A')
    const nameB = uniq('Guard B')
    const a = await createDoc({ markdown: `# ${nameA}\n\nGuarded doc body.\n\n[to library](/library)\n`, filename: 'a.md', sessionName: nameA })
    const b = await createDoc({ markdown: `# ${nameB}\n\nSecond doc body.`, filename: 'b.md', sessionName: nameB })
    const keyA = a.slug || a.id
    const { context, page } = await open()
    const dialogs = []
    let accept = false
    // (No page.evaluate in here: page JS is blocked while confirm() is open.)
    page.on('dialog', async (d) => {
      dialogs.push(d.message())
      if (accept) await d.accept(); else await d.dismiss()
    })
    try {
      await stallWrites(page)
      await page.goto(`${BASE}/library`)
      await page.locator('.session-card').filter({ hasText: nameA }).first().click()
      await waitForPath(page, `/d/${keyA}`)
      await waitForDoc(page, 'Guarded doc body.')
      await typeInEditor(page, '\n\nUnsaved guard text.')
      await waitForDoc(page, 'Unsaved guard text.')

      // Browser Back to /library: asks, the doc is still rendered while asking; cancel → back on the doc.
      await page.goBack()
      // While the (stalled) save gets its short chance, the doc stays on screen.
      assert.equal(await page.evaluate(() => location.pathname), '/library')
      assert.equal(await page.locator('.preview-pane').filter({ hasText: 'Unsaved guard text' }).count(), 1, 'the doc stays on screen while deciding')
      assert.equal(await page.locator('.dashboard').count(), 0)
      for (let i = 0; i < 50 && dialogs.length < 1; i++) await page.waitForTimeout(100)
      assert.equal(dialogs.length, 1, 'Back from a doc with unsaved edits asks')
      await waitForPath(page, `/d/${keyA}`)
      await waitForDoc(page, 'Unsaved guard text.')

      // In-doc link to the library: asks again; accept → library.
      accept = true
      await page.locator('.preview-pane a', { hasText: 'to library' }).click()
      await page.locator('.dashboard').waitFor({ state: 'visible', timeout: 15000 })
      assert.equal(here(page).pathname, '/library')
      assert.equal(dialogs.length, 2, 'the in-doc link asked too')
      // Opening another doc afterwards does not ask again (the edits were discarded).
      await page.locator('.session-card').filter({ hasText: nameB }).first().click()
      await waitForDoc(page, 'Second doc body.')
      assert.equal(dialogs.length, 2, 'no second confirm after accepting')
    } finally { await context.close() }
  })
})

describe('#4 routes — drafts survive navigation (review fix B2)', () => {
  it('a never-shared local draft survives opening a shared doc in the same browser', T, async () => {
    const doc = await createDoc({ markdown: '# Other shared\n\nOther shared body.', filename: 'os.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`)
      await waitForDoc(page, 'This is a paragraph for testing inline comments.')
      await page.waitForTimeout(800) // local persist debounce
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Other shared body.')
      await page.waitForTimeout(800)
      await page.goto(`${BASE}/`)
      await waitForDoc(page, 'This is a paragraph for testing inline comments.')
      assert.equal(here(page).pathname, '/')
    } finally { await context.close() }
  })

  it('a restored clean shared draft stays a shared draft at the landing route (offline copy still works)', T, async () => {
    const doc = await createDoc({ markdown: '# Clean shared\n\nClean shared body CS1.', filename: 'cs.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Clean shared body CS1.')
      await page.waitForTimeout(800)
      await page.goto(`${BASE}/`)
      await page.locator('.upload-area').waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(800) // a write would have happened by now
      await page.route((u) => u.href.startsWith(API), (route) => route.abort('connectionrefused'))
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Clean shared body CS1.')
      await page.locator('.notice-bar', { hasText: 'Showing your local copy' }).waitFor({ state: 'visible', timeout: 10000 })
    } finally { await context.close() }
  })
})

describe('#4 routes — stale views, anchors, view param (review fixes)', () => {
  it('an image file shown before does not hide the next doc (Back from the image to a markdown file)', T, async () => {
    const doc = await createDoc({ markdown: '# Host\n\nHost body.', filename: 'h.md', sessionName: uniq('Stale') })
    await addFile(doc.id, 'pixel.png', PNG_1PX, 'base64')
    await addFile(doc.id, 'notes.md', `# Notes\n\nNotes body ST1.\n\n[the image](/d/${doc.id}/pixel.png)\n`)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}/notes.md`)
      await waitForDoc(page, 'Notes body ST1.')
      await page.locator('.preview-pane a', { hasText: 'the image' }).click()
      await page.locator('.file-view img').waitFor({ state: 'visible', timeout: 10000 })
      await page.goBack()
      await waitForDoc(page, 'Notes body ST1.')
      assert.equal(await page.locator('.file-view').count(), 0)
      await page.goForward()
      await page.locator('.file-view img').waitFor({ state: 'visible', timeout: 10000 })
    } finally { await context.close() }
  })

  it('a heading id that collides with the app root (#app) still scrolls to the heading', T, async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Filler ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`).join('\n\n')
    const doc = await createDoc({ markdown: `# Collide\n\n[go](#app)\n\n${filler}\n\n## App\n\nApp section body.\n\n${filler}\n`, filename: 'c.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'App section body.')
      await page.locator('.preview-pane a[href="#app"]').click()
      await page.waitForFunction(() => location.hash === '#app')
      let offset = null
      for (let i = 0; i < 30; i++) {
        offset = await readingOffset(page, '.preview-pane #app')
        if (offset !== null && offset >= 0 && offset <= 48) break
        await page.waitForTimeout(100)
      }
      assert.ok(offset !== null && offset >= 0 && offset <= 48, `heading #app aligned, got ${offset}`)
    } finally { await context.close() }
  })

  it('an iframe flooding anchor-changed is coalesced to ≤ 2 URL updates/s with no history growth', T, async () => {
    const flood = `<script>
      window.addEventListener('load', function () {
        var n = 0; var t = setInterval(function () {
          parent.postMessage({ __mdreview: true, type: 'anchor-changed', id: 'f' + (n++) }, '*');
          if (n >= 100) { clearInterval(t); window.__done = true; }
        }, 10);
      });
    </script>`
    const doc = await createDoc({ markdown: `<!doctype html><html><head>${flood}</head><body><p>Flood</p></body></html>`, filename: 'f.html', contentType: 'html' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      const before = await historyLength(page)
      // 100 messages over ≥ 1 s; the trailing update lands the last id.
      await page.waitForFunction(() => location.hash === '#f99', null, { timeout: 15000 })
      const replaces = (await urlLog(page)).filter((e) => e.kind === 'replace' && /#f\d+$/.test(e.url))
      assert.ok(replaces.length <= 10, `100 messages must coalesce to a handful of updates, got ${replaces.length}`)
      assert.equal(await historyLength(page), before)
    } finally { await context.close() }
  })

  it('a UI view toggle drops ?view= so a reload cannot reopen the old view', T, async () => {
    const doc = await createDoc({ markdown: '# Toggle\n\nToggle body.', filename: 't.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}?view=edit`)
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
      const before = await historyLength(page)
      await page.locator('header button:has-text("Preview")').click()
      await waitForDoc(page, 'Toggle body.')
      await waitForPath(page, `/d/${doc.id}`, { search: '' })
      assert.equal(await historyLength(page), before, 'replaceState')

      await page.goto(`${BASE}/d/${doc.id}?view=`)
      await waitForDoc(page, 'Toggle body.')
      await waitForPath(page, `/d/${doc.id}`, { search: '?view=read' })
    } finally { await context.close() }
  })
})

describe('#4 routes — legacy fragments pasted while the app is open (rule 4)', () => {
  it('#shared= / #dashboard / #github= typed on the landing route act like a fresh load; doc-route fragments stay anchors', T, async () => {
    const doc = await createDoc({ markdown: '# Pasted\n\nPasted legacy body PL1.\n\n## Dashboard\n\ntext', filename: 'pl.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/`)
      await page.locator('.upload-area').waitFor({ state: 'visible', timeout: 10000 })
      await page.evaluate((id) => { location.hash = `#shared=${id}` }, doc.id)
      await waitForPath(page, `/d/${doc.id}`, { hash: '' })
      await waitForDoc(page, 'Pasted legacy body PL1.')

      // On a doc route the same kind of fragment is a heading anchor: no redirect.
      await page.evaluate(() => { location.hash = '#dashboard' })
      await page.waitForTimeout(300)
      assert.equal(here(page).pathname, `/d/${doc.id}`)
      assert.equal(here(page).hash, '#dashboard')
      await waitForDoc(page, 'Pasted legacy body PL1.')

      await page.goto(`${BASE}/`)
      await page.locator('.upload-area').waitFor({ state: 'visible', timeout: 10000 })
      await page.evaluate(() => { location.hash = '#dashboard' })
      await waitForPath(page, '/library', { search: '?mode=review', hash: '' })
      await page.locator('[data-testid="library-page"], .dashboard').first().waitFor({ state: 'visible', timeout: 10000 })

      await page.goto(`${BASE}/`)
      await page.locator('.upload-area').waitFor({ state: 'visible', timeout: 10000 })
      await page.evaluate(() => { location.hash = '#github=not-a-url' })
      await page.locator('.notice-bar').waitFor({ state: 'visible', timeout: 10000 })
      await waitForPath(page, '/', { search: '', hash: '' })
    } finally { await context.close() }
  })
})
