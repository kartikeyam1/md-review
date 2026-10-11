// #4 Path-based routes — frozen acceptance tests (docs/build/specs/04-routes.md).
//
// Runs on vite dev at base `/` (scripts/verify.sh). The `/md-review/` base and
// the GitHub Pages 404.html fallback are covered by 04-routes-pages.test.mjs.
//
// Written before #2 (reading mode): the read view is located by `.preview-pane`
// (00 §4.6) and view switches use the #2 testids when present, else today's
// Edit/Preview toggle buttons — so nothing here needs #2-only UI.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import {
  createDoc, putMarkdown, listRevisions, uniq,
  installUrlRecorder, watchFirstRender, urlLog, historyLength,
  waitForDoc, readingOffset, collectShareUrls,
} from '../lib/docs.mjs'

const FIXTURE = fileURLToPath(new URL('../fixture.md', import.meta.url))

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

/** Fresh context (no persisted drafts), reduced motion so anchor scrolls are instant. */
async function open({ marker } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  await installUrlRecorder(context)
  if (marker) await watchFirstRender(context, marker)
  const page = await context.newPage()
  return { context, page }
}

const here = (page) => new URL(page.url())
const pathOf = (u) => { try { return new URL(u).pathname.replace(/[).,;:]+$/, '') } catch { return '' } }

async function waitForPath(page, pathname, { search, hash, timeout = 10000 } = {}) {
  await page.waitForFunction(([p, s, h]) =>
    location.pathname === p &&
    (s === null || location.search === s) &&
    (h === null || location.hash === h),
  [pathname, search ?? null, hash ?? null], { timeout })
}

async function setProbe(page) {
  const token = uniq('probe')
  await page.evaluate((t) => { window.__probe = t }, token)
  return token
}
const probe = (page) => page.evaluate(() => window.__probe ?? null)

/** A doc with a link to `#intro` at the top and the Intro section far enough down to need scrolling. */
function anchorDoc(title) {
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} filler paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`).join('\n\n')
  return [
    `# ${title}`,
    '',
    'Jump: [go](#intro)',
    '',
    filler(30, 'Before'),
    '',
    '## Intro',
    '',
    'Intro section body text.',
    '',
    filler(80, 'After'),
    '',
  ].join('\n')
}

async function waitAligned(page, selector, { timeout = 5000 } = {}) {
  await page.waitForFunction(([sel]) => {
    // mirrors readingOffset() in lib/docs.mjs
    const el = document.querySelector(sel)
    if (!el) return false
    const header = document.querySelector('[data-testid="doc-header"]') || document.querySelector('header')
    let top = 0
    if (header) { const r = header.getBoundingClientRect(); if (r.height > 0 && r.bottom > 0) top = r.bottom }
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) { top = Math.max(top, p.getBoundingClientRect().top); break }
    }
    const d = el.getBoundingClientRect().top - top
    return d >= 0 && d <= 48
  }, [selector], { timeout }).catch(() => {})
  return readingOffset(page, selector)
}

async function clickInDocAnchor(page, href) {
  await page.locator(`.preview-pane a[href="${href}"]`).first().click()
}

/** Today's Edit/Preview toggle, or #2's view-toggle segments. */
async function switchView(page, which) {
  const testid = page.locator(`[data-testid="view-toggle-${which}"]`).first()
  if (await testid.count()) return testid.click()
  const label = which === 'edit' ? 'Edit' : 'Preview'
  await page.locator(`header button:has-text("${label}")`).first().click()
}

// ── AC-04.1 ────────────────────────────────────────────────────────────────
describe('#4 routes — doc URLs', () => {
  it('AC-04.1 /d/<slug> opens the doc in a fresh context with a clean path and no fragment', T, async () => {
    const doc = await createDoc({ markdown: '# Weekly update\n\nAll green this week (AC-04.1).', filename: 'weekly.md', sessionName: 'Weekly', slug: 'weekly' })
    assert.ok(doc.slug, 'server assigned a slug')
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.slug}`)
      await waitForDoc(page, 'All green this week (AC-04.1).')
      assert.ok(here(page).pathname.endsWith(`/d/${doc.slug}`), `pathname: ${here(page).pathname}`)
      assert.equal(await page.evaluate(() => location.hash), '')
    } finally { await context.close() }
  })

  it('AC-04.2 legacy /#shared=<id> is replaced by /d/<id> without a new history entry', T, async () => {
    const doc = await createDoc({ markdown: '# Legacy link\n\nLegacy body by id (AC-04.2).', filename: 'legacy.md', sessionName: uniq('Legacy') })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/#shared=${doc.id}`)
      await waitForDoc(page, 'Legacy body by id (AC-04.2).')
      await waitForPath(page, `/d/${doc.id}`, { search: '', hash: '' })
      const { initialHistoryLength } = await page.evaluate(() => window.__mdr)
      assert.equal(await historyLength(page), initialHistoryLength, 'history.length must not grow')
    } finally { await context.close() }
  })

  it('AC-04.2 legacy /?view=read#shared=<slug> keeps the query: /d/<slug>?view=read', T, async () => {
    const doc = await createDoc({ markdown: '# Legacy slug\n\nLegacy body by slug (AC-04.2).', filename: 'legacy-slug.md', sessionName: uniq('Legacy slug') })
    assert.ok(doc.slug)
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/?view=read#shared=${doc.slug}`)
      await waitForDoc(page, 'Legacy body by slug (AC-04.2).')
      await waitForPath(page, `/d/${doc.slug}`, { search: '?view=read', hash: '' })
      const { initialHistoryLength } = await page.evaluate(() => window.__mdr)
      assert.equal(await historyLength(page), initialHistoryLength, 'history.length must not grow')
    } finally { await context.close() }
  })

  it('AC-04.3 legacy /#dashboard becomes /library?mode=review and the library/dashboard renders', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/#dashboard`)
      await waitForPath(page, '/library', { search: '?mode=review', hash: '' })
      await page.locator('[data-testid="library-page"], .dashboard').first().waitFor({ state: 'visible', timeout: 10000 })
      const { initialHistoryLength } = await page.evaluate(() => window.__mdr)
      assert.equal(await historyLength(page), initialHistoryLength, 'redirect uses replaceState')
    } finally { await context.close() }
  })
})

// ── AC-04.4 – 04.8: in-doc anchors ─────────────────────────────────────────
describe('#4 routes — heading anchors', () => {
  /** AC-04.4's steps: open the doc, click [go](#intro). Returns state for the follow-ups. */
  async function openAndClickIntro() {
    const title = uniq('Anchors')
    const doc = await createDoc({ markdown: anchorDoc(title), filename: 'anchors.md', sessionName: title })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    await page.goto(`${BASE}/d/${key}`)
    await waitForDoc(page, 'Intro section body text.')
    const token = await setProbe(page)
    const before = await historyLength(page)
    await clickInDocAnchor(page, '#intro')
    await waitForPath(page, `/d/${key}`, { hash: '#intro' })
    return { context, page, doc, key, title, token, before }
  }

  it('AC-04.4 clicking [go](#intro) pushes /d/<slug>#intro, keeps the doc, and aligns Intro under the header', T, async () => {
    const { context, page, key, title, before } = await openAndClickIntro()
    try {
      assert.equal(here(page).pathname, `/d/${key}`)
      assert.equal(here(page).hash, '#intro')
      await waitForDoc(page, title)
      const offset = await waitAligned(page, '.preview-pane #intro')
      assert.ok(offset !== null && offset >= 0 && offset <= 48, `Intro top should be 0–48px below the header, got ${offset}`)
      assert.equal(await historyLength(page), before + 1, 'anchor click adds exactly one history entry')
    } finally { await context.close() }
  })

  it('AC-04.5 reloading /d/<slug>#intro renders the same doc scrolled to Intro', T, async () => {
    const { context, page, key, title } = await openAndClickIntro()
    try {
      await page.reload()
      await waitForDoc(page, title)
      assert.equal(here(page).pathname, `/d/${key}`)
      assert.equal(here(page).hash, '#intro')
      const offset = await waitAligned(page, '.preview-pane #intro')
      assert.ok(offset !== null && offset >= 0 && offset <= 48, `after reload Intro should be 0–48px below the header, got ${offset}`)
    } finally { await context.close() }
  })

  it('AC-04.6 Back after the anchor click returns to /d/<slug> without a fragment and without a reload', T, async () => {
    const { context, page, key, title, token } = await openAndClickIntro()
    try {
      await page.goBack()
      await waitForPath(page, `/d/${key}`, { hash: '' })
      await waitForDoc(page, title)
      assert.equal(await probe(page), token, 'window.__probe survived (no reload)')
    } finally { await context.close() }
  })

  it('AC-04.7 unsaved edits survive anchor click + Back + Forward while autosave is stalled', T, async () => {
    const title = uniq('Dirty anchors')
    const doc = await createDoc({ markdown: anchorDoc(title), filename: 'dirty.md', sessionName: title })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    const stalled = []
    try {
      // Stall every content write so the edit stays unsaved.
      await page.route((u) => u.href.startsWith(API) && /\/paste\/[^/]+\/markdown$/.test(u.pathname), (route) => {
        if (route.request().method() === 'PUT') stalled.push(route) // never answered
        else route.continue()
      })
      await page.goto(`${BASE}/d/${key}`)
      await waitForDoc(page, 'Intro section body text.')
      const token = await setProbe(page)

      await switchView(page, 'edit')
      const editor = page.locator('.cm-content').first()
      await editor.waitFor({ state: 'visible', timeout: 15000 })
      await editor.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nTyped while offline ZQX704.')
      await switchView(page, 'read')
      await waitForDoc(page, 'Typed while offline ZQX704.')

      await clickInDocAnchor(page, '#intro')
      await page.waitForFunction(() => location.hash === '#intro')
      await page.goBack()
      await page.waitForFunction(() => location.hash === '')
      await page.goForward()
      await page.waitForFunction(() => location.hash === '#intro')

      await waitForDoc(page, 'Typed while offline ZQX704.', { timeout: 5000 })
      assert.equal(await probe(page), token, 'no reload happened')
      assert.equal(here(page).pathname, `/d/${key}`)
    } finally {
      for (const r of stalled) await r.abort().catch(() => {})
      await context.close()
    }
  })

  it('AC-04.8 changing the fragment to #intro while the share is still loading does not abort the load', T, async () => {
    const title = uniq('Slow load')
    const doc = await createDoc({ markdown: anchorDoc(title), filename: 'slow.md', sessionName: title })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    try {
      const isDocGet = (u) => u.href.startsWith(API) && /^\/paste\/[^/]+$/.test(u.pathname)
      await page.route(isDocGet, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        await new Promise((r) => setTimeout(r, 2000)) // the AC's "API delayed 2 s"
        await route.continue().catch(() => {})
      })
      const requested = page.waitForRequest((r) => r.method() === 'GET' && isDocGet(new URL(r.url())), { timeout: 10000 })
      await page.goto(`${BASE}/d/${key}`, { waitUntil: 'domcontentloaded' })
      await requested
      await page.evaluate(() => { location.hash = '#intro' })
      await waitForDoc(page, 'Intro section body text.', { timeout: 15000 })
      assert.equal(here(page).pathname, `/d/${key}`)
      assert.equal(here(page).hash, '#intro')
    } finally { await context.close() }
  })
})

// ── AC-04.9 ────────────────────────────────────────────────────────────────
describe('#4 routes — library navigation', () => {
  it('AC-04.9 /library → click a row → /d/<slug||id> → Back → /library, all without a reload', T, async () => {
    const name = uniq('Library nav')
    const doc = await createDoc({ markdown: `# ${name}\n\nLibrary target body (AC-04.9).`, filename: 'lib.md', sessionName: name })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/library`)
      const row = page.locator('[data-testid="library-row"], .session-card').filter({ hasText: name }).first()
      await row.waitFor({ state: 'visible', timeout: 10000 })
      const token = await setProbe(page)
      await row.click()
      await waitForPath(page, `/d/${key}`)
      await waitForDoc(page, 'Library target body (AC-04.9).')
      await page.goBack()
      await waitForPath(page, '/library')
      await page.locator('[data-testid="library-page"], .dashboard').first().waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await probe(page), token, 'window.__probe survived (no full reload)')
    } finally { await context.close() }
  })
})

// ── AC-04.10 ───────────────────────────────────────────────────────────────
describe('#4 routes — not found', () => {
  it('AC-04.10 /d/<unknown> shows doc-not-found (never the upload screen) with a link home', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${uniq('does-not-exist')}`)
      const nf = page.locator('[data-testid="doc-not-found"]')
      await nf.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await page.locator('.upload-area, .upload-screen').filter({ visible: true }).count(), 0, 'no upload drop zone')
      const homes = await nf.locator('a[href]').evaluateAll((as) => as.map((a) => new URL(a.href).pathname))
      assert.ok(homes.includes('/'), `doc-not-found links home, got ${JSON.stringify(homes)}`)
    } finally { await context.close() }
  })

  it('AC-04.10 an unknown route (/nope/x) shows not-found, links home, and fetches nothing', T, async () => {
    const { context, page } = await open()
    const apiCalls = []
    page.on('request', (r) => { if (r.url().startsWith(API + '/paste')) apiCalls.push(r.url()) })
    try {
      await page.goto(`${BASE}/nope/x`)
      const nf = page.locator('[data-testid="not-found"]')
      await nf.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await page.locator('[data-testid="doc-not-found"]').count(), 0)
      assert.equal(await page.locator('.upload-area, .upload-screen').filter({ visible: true }).count(), 0, 'no upload drop zone')
      const homes = await nf.locator('a[href]').evaluateAll((as) => as.map((a) => new URL(a.href).pathname))
      assert.ok(homes.includes('/'), `not-found links home, got ${JSON.stringify(homes)}`)
      assert.deepEqual(apiCalls, [], 'an unknown route fetches no doc')
    } finally { await context.close() }
  })
})

// ── AC-04.11 ───────────────────────────────────────────────────────────────
describe('#4 routes — edit token stripping', () => {
  it('AC-04.11 ?edit=<token> is gone from the URL by the first render and never reaches history.state or share links', T, async () => {
    const marker = 'Edit token body (AC-04.11).'
    const doc = await createDoc({ markdown: `# Token doc\n\n${marker}`, filename: 'token.md' })
    const { context, page } = await open({ marker })
    try {
      await page.goto(`${BASE}/d/${doc.id}?edit=tok123`)
      await waitForDoc(page, marker)
      const rec = await page.evaluate(() => window.__mdr)
      assert.ok(rec.firstRender, 'first render observed')
      assert.ok(!/[?&]edit=/.test(new URL(rec.firstRender.href).search), `URL at first render still had edit=: ${rec.firstRender.href}`)
      assert.ok(!rec.firstRender.href.includes('tok123'))
      assert.ok(!/[?&]edit=/.test(await page.evaluate(() => location.search)), 'location.search has no edit')
      assert.ok(!String(await page.evaluate(() => JSON.stringify(history.state))).includes('tok123'), 'history.state has no token')
      for (const e of rec.log) {
        assert.ok(!String(e.state).includes('tok123'), `history entry state leaked the token: ${JSON.stringify(e)}`)
        if (e.kind === 'push') assert.ok(!e.url.includes('tok123'), `a pushed URL leaked the token: ${e.url}`)
      }

      const urls = await collectShareUrls(page)
      // No slug on this doc, so the link names the id (rule 11 / 00 §6).
      assert.ok(urls.some((u) => pathOf(u) === `/d/${doc.id}`), `a /d/<id> share link was shown or copied: ${JSON.stringify(urls)}`)
      for (const u of urls) assert.ok(!u.includes('tok123'), `share/copy link leaked the token: ${u}`)
      assert.ok(!page.url().includes('tok123'), `location.href leaked the token later: ${page.url()}`)
    } finally { await context.close() }
  })
})

// ── AC-04.12 ───────────────────────────────────────────────────────────────
describe('#4 routes — ?view resolution', () => {
  let doc, oldHash
  before(async () => {
    doc = await createDoc({ markdown: '# View doc\n\nView v1 body (AC-04.12).', filename: 'view.md', sessionName: uniq('View doc'), author: 'Alice' })
    await putMarkdown(doc.id, '# View doc\n\nView v2 body (AC-04.12).', { author: 'Bob' })
    const list = await listRevisions(doc.id)
    oldHash = list.revisions.find((r) => r.hash !== list.current)?.hash
    assert.match(oldHash ?? '', /^[0-9a-f]{32}$/, 'an older revision exists')
  })

  async function expectReadWithViewRead(url, text) {
    const { context, page } = await open()
    try {
      await page.goto(url)
      await waitForDoc(page, text)
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
        .catch(() => {})
      assert.equal(here(page).searchParams.get('view'), 'read', `URL query should read view=read, got ${here(page).search}`)
      assert.equal(await page.locator('.cm-editor').count(), 0, 'no editor rendered')
      const { initialHistoryLength } = await page.evaluate(() => window.__mdr)
      assert.equal(await historyLength(page), initialHistoryLength, 'the rewrite uses replaceState')
    } finally { await context.close() }
  }

  it('AC-04.12 a viewer (pinned revision) opening ?view=edit gets the read view and view=read', T, async () => {
    await expectReadWithViewRead(`${BASE}/d/${doc.id}@${oldHash}?view=edit`, 'View v1 body (AC-04.12).')
  })

  it('AC-04.12 a viewer (pinned revision) opening ?view=bogus gets the read view and view=read', T, async () => {
    await expectReadWithViewRead(`${BASE}/d/${doc.id}@${oldHash}?view=bogus`, 'View v1 body (AC-04.12).')
  })

  it('AC-04.12 any reader opening /d/<id>?view=bogus gets the read view and view=read', T, async () => {
    await expectReadWithViewRead(`${BASE}/d/${doc.id}?view=bogus`, 'View v2 body (AC-04.12).')
  })
})

// ── AC-04.13 / 04.14: HTML docs ────────────────────────────────────────────
const PARTS_HTML = (extraHead = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>Parts</title>${extraHead}</head>
<body>
<p>HTML parts doc</p>
<div style="height:2400px">spacer A</div>
<h2 id="part-1">Part 1</h2>
<div style="height:2400px">spacer B</div>
<h2 id="part-2">Part 2</h2>
<p><a id="to-part-1" href="#part-1">back to part 1</a></p>
<div style="height:2400px">spacer C</div>
</body></html>`

async function docFrame(page) {
  const handle = await page.locator('iframe').first().elementHandle({ timeout: 15000 })
  let frame = await handle.contentFrame()
  for (let i = 0; i < 50 && !frame; i++) { await page.waitForTimeout(100); frame = await handle.contentFrame() }
  assert.ok(frame, 'HTML doc iframe has a frame')
  await frame.waitForSelector('#part-2', { state: 'attached', timeout: 15000 })
  return frame
}

describe('#4 routes — HTML doc anchors (iframe bridge)', () => {
  it('AC-04.13 /d/<id>#part-2 scrolls the iframe to part-2; an in-frame #part-1 click replaces the parent fragment', T, async () => {
    const doc = await createDoc({ markdown: PARTS_HTML(), filename: 'parts.html', contentType: 'html', sessionName: uniq('Parts') })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key}#part-2`)
      const frame = await docFrame(page)
      await frame.waitForFunction(() => {
        const r = document.getElementById('part-2').getBoundingClientRect()
        return window.scrollY > 0 && r.top >= -1 && r.top < window.innerHeight
      }, null, { timeout: 8000 })

      const before = await historyLength(page)
      await frame.click('#to-part-1')
      await page.waitForFunction(() => location.hash === '#part-1', null, { timeout: 5000 })
      assert.equal(here(page).pathname, `/d/${key}`)
      assert.equal(await historyLength(page), before, 'HTML-doc anchors use replaceState')
    } finally { await context.close() }
  })

  it('AC-04.14 oversized ids and messages from other windows never change the parent fragment', T, async () => {
    const spoof = `<script>
      window.addEventListener('load', function () {
        parent.postMessage({ __mdreview: true, type: 'anchor-changed', id: 'x'.repeat(300) }, '*');
        parent.postMessage({ __mdreview: true, type: 'anchor-changed', id: 4242 }, '*');
        window.__posted = true;
      });
    </script>`
    const doc = await createDoc({ markdown: PARTS_HTML(spoof), filename: 'spoof.html', contentType: 'html', sessionName: uniq('Spoof') })
    const key = doc.slug || doc.id
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${key}`)
      const frame = await docFrame(page)
      await frame.waitForFunction(() => window.__posted === true, null, { timeout: 8000 })

      // Valid-looking messages from windows that are not the doc's iframe.
      await page.evaluate(() => new Promise((resolve) => {
        window.postMessage({ __mdreview: true, type: 'anchor-changed', id: 'evil-self' }, '*')
        const f = document.createElement('iframe')
        f.style.display = 'none'
        f.srcdoc = '<script>parent.postMessage({__mdreview:true,type:"anchor-changed",id:"evil-other"},"*")<\/script>'
        f.onload = () => resolve()
        document.body.appendChild(f)
      }))

      // Positive control (and a barrier behind the messages above): a genuine in-frame anchor click.
      await frame.click('#to-part-1')
      await page.waitForFunction(() => location.hash === '#part-1', null, { timeout: 5000 })

      const seen = (await urlLog(page)).map((e) => new URL(e.url).hash)
      for (const h of seen) {
        assert.ok(!h.includes('xxxxxxxx') && !h.includes('evil') && !h.includes('4242'), `fragment was changed by a rejected message: ${h}`)
      }
      assert.equal(here(page).hash, '#part-1')
    } finally { await context.close() }
  })
})

// ── AC-04.15 ───────────────────────────────────────────────────────────────
describe('#4 routes — pinned revision', () => {
  it('AC-04.15 /d/<id>@<hash> renders that version read-only with a banner and a link to the latest', T, async () => {
    const doc = await createDoc({ markdown: '# Pinned\n\nVersion ONE text (AC-04.15).', filename: 'pinned.md', sessionName: uniq('Pinned'), author: 'Alice' })
    await putMarkdown(doc.id, '# Pinned\n\nVersion TWO text (AC-04.15).', { author: 'Bob' })
    const list = await listRevisions(doc.id)
    const H = list.revisions.find((r) => r.hash !== list.current)?.hash
    assert.match(H ?? '', /^[0-9a-f]{32}$/)

    const { context, page } = await open()
    const gets = []
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().startsWith(API + '/paste/')) gets.push(new URL(r.url()).pathname) })
    try {
      await page.goto(`${BASE}/d/${doc.id}@${H}`)
      await waitForDoc(page, 'Version ONE text (AC-04.15).')
      assert.equal(await page.locator('.preview-pane').filter({ hasText: 'Version TWO text' }).count(), 0, 'the old version, not the current one')
      await page.locator('[data-testid="pinned-revision-banner"]').waitFor({ state: 'visible', timeout: 5000 })

      assert.equal(await page.locator('[data-testid="view-toggle-edit"]').count(), 0, 'no view-toggle-edit')
      assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0, 'no Edit control of any kind')
      assert.equal(await page.locator('.cm-editor').count(), 0, 'no editor')
      assert.equal(await page.locator('aside.sidebar, [data-testid="comments-drawer"], [data-testid="comments-toggle"]').filter({ visible: true }).count(), 0, 'no comments sidebar')

      assert.ok(gets.includes(`/paste/${doc.id}/revisions/${H}`), `loads the revision: ${JSON.stringify(gets)}`)
      assert.ok(!gets.includes(`/paste/${doc.id}`), `never loads the live doc for a pinned revision: ${JSON.stringify(gets)}`)

      await page.locator('[data-testid="pinned-revision-latest-link"]').click()
      await waitForPath(page, `/d/${doc.id}`)
      await waitForDoc(page, 'Version TWO text (AC-04.15).')
    } finally { await context.close() }
  })
})

// ── AC-04.18 ───────────────────────────────────────────────────────────────
describe('#4 routes — dev loader', () => {
  it('AC-04.18 /?filePath=<fixture> renders the fixture and the path stays /', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`)
      await page.locator('.preview-pane, .cm-content').filter({ hasText: 'This is a paragraph for testing inline comments.' })
        .first().waitFor({ state: 'visible', timeout: 15000 })
      assert.equal(here(page).pathname, '/')
      assert.equal(await page.locator('[data-testid="not-found"], [data-testid="doc-not-found"]').count(), 0)
    } finally { await context.close() }
  })
})

// ── AC-04.19 ───────────────────────────────────────────────────────────────
describe('#4 routes — links between docs', () => {
  it('AC-04.19 an absolute <origin><base>d/<other> link navigates in-app; Back returns to the first doc', T, async () => {
    const other = await createDoc({ markdown: '# Other\n\nOther doc body (AC-04.19).', filename: 'other.md', sessionName: uniq('Other') })
    const otherKey = other.slug || other.id
    const first = await createDoc({
      markdown: `# First\n\nFirst doc body (AC-04.19).\n\n[open the other doc](${BASE}/d/${otherKey})\n`,
      filename: 'first.md', sessionName: uniq('First'),
    })
    const firstKey = first.slug || first.id
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${firstKey}`)
      await waitForDoc(page, 'First doc body (AC-04.19).')
      const token = await setProbe(page)
      await page.locator('.preview-pane a', { hasText: 'open the other doc' }).click()
      await waitForPath(page, `/d/${otherKey}`)
      await waitForDoc(page, 'Other doc body (AC-04.19).')
      assert.equal(await probe(page), token, 'no reload on an in-app doc link')
      await page.goBack()
      await waitForPath(page, `/d/${firstKey}`)
      await waitForDoc(page, 'First doc body (AC-04.19).')
      assert.equal(await probe(page), token, 'no reload on Back')
    } finally { await context.close() }
  })
})
