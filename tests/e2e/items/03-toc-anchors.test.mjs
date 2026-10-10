// #3 Sticky TOC + heading copy-link — frozen acceptance tests
// (docs/build/specs/03-toc-anchors.md rules 8–21, AC-03.3 – AC-03.16;
// 00-cross-cutting.md §2.2, §2.4, §2.5, §3.1, §3.4, §3.7, §10, §12).
// Heading-id / slug / TOC-builder rules (AC-03.1, AC-03.2) are unit tests in
// tests/items/03-toc-anchors.test.ts. Collapsible sections (#17) are not tested here.
//
// Assumes #4 (routes: /d/<slug||id>, ?view=, ?embed=1, pushState anchors,
// fragment on load), #2 (doc-header, app-toast, review/publish mode), #5
// (read view = document scroll with a sticky header, docTitle) and #6 have
// landed. Docs are opened read view at /d/<slug||id>.
//
// Geometry: "header bottom" is the bottom of the sticky doc-header; the
// reading-area offset of a heading is measured with readingOffset() from
// lib/docs.mjs (same as the #4 anchor tests: 0–48px = "just below the header").
//
// Screenshots for the visual verifier go to .verify/screens/03/ (+ index.json).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq, installUrlRecorder, waitForDoc, readingOffset, historyLength } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const SCREENS = join(ROOT, '.verify/screens/03')

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }
const SLOW = { timeout: 120_000 }
const tid = (id) => `[data-testid="${id}"]`

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1400, height: 900 },
}

// ── fixtures ────────────────────────────────────────────────────────────────

const filler = (n, tag) => Array.from({ length: n }, (_, i) =>
  `${tag} paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`,
).join('\n\n')

// AC-03.3 doc: `# Title` + 4 `##` + 2 `###`. Every section but the last is long,
// so a heading 20px under the header has the next heading > 80px below it; the
// last section (Delta) is short, so at the very bottom its heading is visible
// but well below the +80px line (the "bottom" rule decides it, not the 80px one).
const TOC_MARK = 'TOC fixture intro paragraph (AC-03.3).'
const TOC_ENTRIES = [
  { id: 'alpha-section', text: 'Alpha section', level: 2 },
  { id: 'alpha-detail', text: 'Alpha detail', level: 3 },
  { id: 'beta-section', text: 'Beta section', level: 2 },
  { id: 'gamma-section', text: 'Gamma section', level: 2 },
  { id: 'gamma-detail', text: 'Gamma detail', level: 3 },
  { id: 'delta-section', text: 'Delta section', level: 2 },
]
function tocDoc({ insertBefore } = {}) {
  const out = ['# Title', '', TOC_MARK, '']
  for (const e of TOC_ENTRIES) {
    if (insertBefore && insertBefore.before === e.id) out.push(insertBefore.markdown, '')
    out.push(`${'#'.repeat(e.level)} ${e.text}`, '')
    out.push(e.id === 'delta-section' ? 'Delta closing paragraph one.\n\nDelta closing paragraph two.' : filler(10, e.text), '')
  }
  return out.join('\n')
}
const TOC_SRC = tocDoc()

// AC-03.9 – 03.11: a shared doc with `## Über café` far enough down to scroll to.
const UNI_ID = 'über-café'
const UNI_ENC = '%C3%BCber-caf%C3%A9'
const UNI_MARK = 'Unicode copy-link doc intro (AC-03.9).'
const UNI_SRC = [
  '# Weekly', '', UNI_MARK, '',
  '## Intro', '', filler(8, 'Intro'), '',
  '## Über café', '', 'Café section body text.', '', filler(14, 'Cafe'), '',
  '## Wrap up', '', filler(3, 'Wrap'), '',
].join('\n')

// 60 sections: a rail that must scroll itself (rule 10, rule 13).
const MANY_MARK = 'Many-headings fixture intro (rule 13).'
const MANY_SRC = ['# Many', '', MANY_MARK, '', ...Array.from({ length: 60 }, (_, i) =>
  `## Topic number ${i + 1}\n\nTopic ${i + 1} body. Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`)].join('\n')

let browser
const docs = {}
const shots = []

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.toc = await createDoc({ markdown: TOC_SRC, filename: 'toc.md', sessionName: uniq('TOC fixture'), mode: 'publish' })
  docs.uni = await createDoc({ markdown: UNI_SRC, filename: 'weekly.md', sessionName: uniq('Weekly'), slug: uniq('weekly'), mode: 'publish' })
  docs.many = await createDoc({ markdown: MANY_SRC, filename: 'many.md', sessionName: uniq('Many'), mode: 'publish' })
})
after(async () => {
  await browser?.close()
  try {
    writeFileSync(join(SCREENS, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, shots }, null, 2) + '\n')
  } catch { /* screenshots are best effort */ }
})

// ── helpers ─────────────────────────────────────────────────────────────────

const docKey = (doc) => doc.slug || doc.id
const docUrl = (doc, rest = '') => `${BASE}/d/${docKey(doc)}${rest}`
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function eventually(fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    try { return await fn() } catch (e) { if (Date.now() > end) throw e }
    await sleep(interval)
  }
}

/** Fresh context: reduced motion (instant anchor scrolls), optional URL/clipboard recorder and init script. */
async function open({ viewport = VIEWPORTS.desktop, recorder = true, init, permissions, ...ctx } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(permissions ? { permissions } : {}), ...ctx })
  if (recorder) await installUrlRecorder(context)
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  return { context, page }
}

async function openDoc(page, doc, text, rest = '') {
  await page.goto(docUrl(doc, rest))
  await waitForDoc(page, text)
  await page.locator(tid('doc-header')).first().waitFor({ state: 'visible', timeout: 10000 })
}

/** Wait until the preview enhancers have run (every markdown heading carries its heading-anchor), then settle. */
async function waitEnhanced(page) {
  await page.locator(`.preview-pane ${tid('heading-anchor')}`).first().waitFor({ state: 'attached', timeout: 8000 })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await sleep(300)
}

const headerBottom = (page) => page.evaluate(() => {
  const h = document.querySelector('[data-testid="doc-header"]') || document.querySelector('header')
  return h ? h.getBoundingClientRect().bottom : 0
})

const scrollY = (page) => page.evaluate(() => (document.scrollingElement || document.documentElement).scrollTop)

/** Scroll the document so heading #id's top sits `px` below the sticky header bottom. */
async function scrollHeadingBelowHeader(page, id, px) {
  for (let i = 0; i < 3; i++) {
    const done = await page.evaluate(([hid, off]) => {
      const el = document.getElementById(hid)
      if (!el) throw new Error(`no element #${hid}`)
      const h = document.querySelector('[data-testid="doc-header"]') || document.querySelector('header')
      const hb = h ? h.getBoundingClientRect().bottom : 0
      const delta = el.getBoundingClientRect().top - hb - off
      if (Math.abs(delta) < 1) return true
      window.scrollBy({ top: delta, behavior: 'instant' })
      return false
    }, [id, px])
    if (done) return
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
  }
  const off = await page.evaluate(([hid]) => {
    const h = document.querySelector('[data-testid="doc-header"]') || document.querySelector('header')
    return document.getElementById(hid).getBoundingClientRect().top - (h ? h.getBoundingClientRect().bottom : 0)
  }, [id])
  assert.ok(Math.abs(off - px) <= 2, `could not place #${id} ${px}px below the header (got ${off})`)
}

/** Decoded ids of the toc-links with aria-current="location" inside `scope`. */
const activeIds = (page, scope) => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  if (!root) return null
  return [...root.querySelectorAll('[data-testid="toc-link"][aria-current="location"]')].map((a) => {
    const h = a.getAttribute('href') || ''
    try { return decodeURIComponent(h.slice(h.indexOf('#') + 1)) } catch { return h }
  })
}, scope)

async function waitActive(page, scope, id, { timeout = 1500 } = {}) {
  await page.waitForFunction(([sel, want]) => {
    const root = document.querySelector(sel)
    if (!root) return false
    const act = [...root.querySelectorAll('[data-testid="toc-link"][aria-current="location"]')]
    if (act.length !== 1) return false
    const h = act[0].getAttribute('href') || ''
    try { return decodeURIComponent(h.slice(h.indexOf('#') + 1)) === want } catch { return false }
  }, [scope, id], { timeout }).catch(() => {})
  return activeIds(page, scope)
}

/** The toc-link (inside `scope`) whose href targets `id`. */
const tocLink = (page, scope, id) => page.locator(
  `${scope} ${tid('toc-link')}[href="#${id}"], ${scope} ${tid('toc-link')}[href="#${encodeURIComponent(id)}"]`,
).first()

/** Mirrors lib/docs.mjs readingOffset(), but waits (≤ timeout) for the target to land 0–48px under the header. */
async function waitAligned(page, selector, { timeout = 5000 } = {}) {
  await page.waitForFunction(([sel]) => {
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

/** Left x of the first rendered glyph of an element's text (indentation-agnostic of padding vs margin). */
const textLeft = (locator) => locator.evaluate((el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) })
  const first = walker.nextNode()
  if (!first) return el.getBoundingClientRect().left
  const r = document.createRange()
  const i = first.textContent.search(/\S/)
  r.setStart(first, i); r.setEnd(first, i + 1)
  return r.getBoundingClientRect().left
})

const visibleCount = async (page, selector) => {
  let n = 0
  for (const l of await page.locator(selector).all()) if (await l.isVisible().catch(() => false)) n++
  return n
}

const activeTestid = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
const focusInside = (page, selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  return !!root && !!document.activeElement && root.contains(document.activeElement)
}, selector)

async function shot(page, name, meta = {}, opts = {}) {
  const file = `${name}.png`
  try {
    await page.screenshot({ path: join(SCREENS, file), ...opts })
    shots.push({ file, ...meta, viewport: page.viewportSize() })
  } catch { /* best effort */ }
}

const PANEL = tid('toc-panel')
const DRAWER = tid('toc-drawer')

// ── Desktop rail ────────────────────────────────────────────────────────────
describe('#3 TOC — desktop rail', () => {
  it('AC-03.3 1400×900: toc-panel visible, 6 toc-links (no "Title"), ### indented more than ##, sticky after scrolling 3000px', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.toc, TOC_MARK)
      const panel = page.locator(PANEL)
      await panel.waitFor({ state: 'visible', timeout: 8000 })
      const links = panel.locator(tid('toc-link'))
      assert.equal(await links.count(), 6, 'six entries: 4 × ## + 2 × ###')
      const texts = (await links.allTextContents()).map(norm)
      assert.deepEqual(texts, TOC_ENTRIES.map((e) => e.text), 'entries in document order, lone leading H1 "Title" omitted')
      assert.ok(!texts.includes('Title'))

      // real hrefs to the heading ids (rule 12)
      const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))
      assert.deepEqual(hrefs, TOC_ENTRIES.map((e) => `#${e.id}`))

      // indentation: every ### entry's text starts right of every ## entry's text
      const lefts = []
      for (let i = 0; i < 6; i++) lefts.push(await textLeft(links.nth(i)))
      const h2 = lefts.filter((_, i) => TOC_ENTRIES[i].level === 2)
      const h3 = lefts.filter((_, i) => TOC_ENTRIES[i].level === 3)
      assert.ok(Math.max(...h2) - Math.min(...h2) <= 1, `## entries share one indent: ${h2}`)
      assert.ok(Math.min(...h3) >= Math.max(...h2) + 4, `### entries are indented more than ##: ## ${h2} vs ### ${h3}`)

      // sticky: same viewport top before and after scrolling the document 3000px, below the header
      const top0 = (await panel.boundingBox()).y
      await page.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' }))
      await page.waitForFunction(() => (document.scrollingElement || document.documentElement).scrollTop >= 2990, null, { timeout: 3000 })
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
      const box = await panel.boundingBox()
      assert.ok(Math.abs(box.y - top0) <= 1, `toc-panel top moved from ${top0} to ${box.y} after scrolling 3000px`)
      const hb = await headerBottom(page)
      assert.ok(box.y >= hb - 1, `toc-panel (top ${box.y}) sits below the sticky header (bottom ${hb})`)
      assert.ok(await panel.isVisible(), 'toc-panel still visible after scrolling')
      // rule 10: max-height = viewport − header (the rail never runs off the bottom)
      assert.ok(box.y + box.height <= VIEWPORTS.desktop.height + 1, `rail bottom ${box.y + box.height} within the viewport`)
      await shot(page, 'desktop-rail-scrolled', { ac: 'AC-03.3' })
    } finally { await context.close() }
  })

  it('AC-03.4 a doc with only one ## (or only an H1, or H1 + one ##) has neither toc-panel nor toc-toggle in the DOM', T, async () => {
    const cases = [
      { name: 'one ##', md: 'Only-h2 intro (AC-03.4).\n\n## Only section\n\nSome text.\n', mark: 'Only-h2 intro (AC-03.4).' },
      { name: 'only H1', md: '# Only title\n\nOnly-h1 body (AC-03.4).\n', mark: 'Only-h1 body (AC-03.4).' },
      { name: 'H1 + one ##', md: '# Title here\n\nH1-plus-one body (AC-03.4).\n\n## The one\n\nText.\n\n#### Deep one\n\nText.\n', mark: 'H1-plus-one body (AC-03.4).' },
    ]
    for (const c of cases) {
      const doc = await createDoc({ markdown: c.md, filename: 'small.md', sessionName: uniq('Small'), mode: 'publish' })
      for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.phone]) {
        const { context, page } = await open({ viewport })
        try {
          await openDoc(page, doc, c.mark)
          await waitEnhanced(page)
          for (const id of ['toc-panel', 'toc-toggle', 'toc-drawer', 'toc-link']) {
            assert.equal(await page.locator(tid(id)).count(), 0, `${c.name} @${viewport.width}: no ${id} in the DOM`)
          }
        } finally { await context.close() }
      }
    }
  })

  it('AC-03.5 the 3rd ## 20px below the header is the only active entry; the very bottom activates the last entry', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.toc, TOC_MARK)
      await page.locator(PANEL).waitFor({ state: 'visible', timeout: 8000 })

      // rule 13: before the first heading -> the first entry
      assert.deepEqual(await waitActive(page, PANEL, 'alpha-section'), ['alpha-section'], 'at the top the first entry is active')

      await scrollHeadingBelowHeader(page, 'gamma-section', 20)
      assert.deepEqual(await waitActive(page, PANEL, 'gamma-section'), ['gamma-section'],
        'Gamma section (3rd ##) is the only toc-link with aria-current="location"')
      const cls = await tocLink(page, PANEL, 'gamma-section').getAttribute('class')
      assert.match(cls ?? '', /\bactive\b/, 'the active toc-link also carries class "active"')
      assert.equal(await page.locator(`${PANEL} ${tid('toc-link')}.active`).count(), 1, 'exactly one .active toc-link')
      for (const l of await page.locator(`${PANEL} ${tid('toc-link')}`).all()) {
        const cur = await l.getAttribute('aria-current')
        assert.ok(cur === null || cur === 'location', `aria-current is "location" or absent, got ${cur}`)
      }

      // 100px further down: Gamma still active (Gamma detail is far below the +80px line)
      await page.evaluate(() => window.scrollBy({ top: 100, behavior: 'instant' }))
      assert.deepEqual(await waitActive(page, PANEL, 'gamma-section'), ['gamma-section'])

      // very bottom: Delta's heading is visible but far below +80px -> still the last entry
      await page.evaluate(() => window.scrollTo({ top: (document.scrollingElement || document.documentElement).scrollHeight, behavior: 'instant' }))
      assert.deepEqual(await waitActive(page, PANEL, 'delta-section'), ['delta-section'], 'scrolled to the very bottom -> last entry active')
      const deltaTop = await page.evaluate(() => document.getElementById('delta-section').getBoundingClientRect().top)
      const hb = await headerBottom(page)
      assert.ok(deltaTop > hb + 80, `fixture sanity: Delta heading (${deltaTop}) is below the +80px line (${hb + 80}) at the bottom`)

      // back up: the active entry follows the scroll position
      await scrollHeadingBelowHeader(page, 'alpha-detail', 10)
      assert.deepEqual(await waitActive(page, PANEL, 'alpha-detail'), ['alpha-detail'])
    } finally { await context.close() }
  })

  it('AC-03.6 clicking a toc-link pushes its fragment, lands the heading 0–48px under the header and makes the link active', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.toc, TOC_MARK)
      await page.locator(PANEL).waitFor({ state: 'visible', timeout: 8000 })
      const before = await historyLength(page)
      const link = tocLink(page, PANEL, 'gamma-section')
      const href = await link.getAttribute('href')
      await link.click()
      await page.waitForFunction((h) => location.hash === h, href, { timeout: 3000 })
      assert.equal(new URL(page.url()).hash, href, 'URL fragment equals the link href')
      assert.equal(new URL(page.url()).pathname, `/d/${docKey(docs.toc)}`, 'still on the doc route')
      const offset = await waitAligned(page, '#gamma-section')
      assert.ok(offset !== null && offset >= 0 && offset <= 48, `Gamma heading should be 0–48px below the header, got ${offset}`)
      assert.deepEqual(await waitActive(page, PANEL, 'gamma-section', { timeout: 500 }), ['gamma-section'], 'clicked entry is active immediately')
      await sleep(400) // scroll settles; the active entry must not flip away
      assert.deepEqual(await activeIds(page, PANEL), ['gamma-section'], 'clicked entry stays active after the scroll settles')
      assert.equal(await historyLength(page), before + 1, 'plain click = pushState, one history entry (#4 rule 12)')
    } finally { await context.close() }
  })

  it('AC-03.7 collapsing the rail persists across reload; toc-toggle reopens it and clears the preference', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.toc, TOC_MARK)
      const panel = page.locator(PANEL)
      await panel.waitFor({ state: 'visible', timeout: 8000 })
      assert.equal(await visibleCount(page, tid('toc-toggle')), 0, 'desktop: toc-toggle only while the rail is collapsed (00 §2.2)')
      const collapse = page.locator(tid('toc-collapse-btn'))
      await collapse.click()
      await panel.waitFor({ state: 'hidden', timeout: 3000 })
      assert.equal(await page.evaluate(() => localStorage.getItem('md-review-toc-collapsed')), '1')

      await page.reload()
      await waitForDoc(page, TOC_MARK)
      const toggle = page.locator(`${tid('doc-header')} ${tid('toc-toggle')}`)
      await toggle.waitFor({ state: 'visible', timeout: 8000 })
      assert.equal(await visibleCount(page, PANEL), 0, 'after reload the rail stays collapsed')
      await shot(page, 'desktop-rail-collapsed', { ac: 'AC-03.7' })

      await toggle.click()
      await panel.waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await page.evaluate(() => localStorage.getItem('md-review-toc-collapsed')), null, 'reopening clears the preference')
      await page.waitForFunction(() => {
        const t = document.querySelector('[data-testid="toc-toggle"]')
        return !t || !(t.offsetWidth || t.offsetHeight || t.getClientRects().length)
      }, null, { timeout: 3000 }).catch(() => {})
      assert.equal(await visibleCount(page, tid('toc-toggle')), 0, 'toc-toggle hides again once the rail is open')
    } finally { await context.close() }
  })

  it('rule 13: with 60 headings the rail scrolls itself and keeps the active entry visible; the page never jumps', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.many, MANY_MARK)
      const panel = page.locator(PANEL)
      await panel.waitFor({ state: 'visible', timeout: 8000 })
      const scroller = await panel.evaluate((nav) => {
        for (let el = nav.querySelector('[data-testid="toc-link"]'); el && el !== nav.parentElement; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return true
        }
        return false
      })
      assert.ok(scroller, 'the rail (or a box inside it) scrolls independently')
      await scrollHeadingBelowHeader(page, 'topic-number-50', 10)
      assert.deepEqual(await waitActive(page, PANEL, 'topic-number-50'), ['topic-number-50'])
      const y0 = await scrollY(page)
      await sleep(300)
      const inView = await tocLink(page, PANEL, 'topic-number-50').evaluate((a) => {
        const nav = a.closest('[data-testid="toc-panel"]')
        const r = a.getBoundingClientRect(); const n = nav.getBoundingClientRect()
        return r.top >= n.top - 1 && r.bottom <= n.bottom + 1 && r.bottom <= innerHeight + 1
      })
      assert.ok(inView, 'the active entry is scrolled into view inside the rail')
      assert.equal(await scrollY(page), y0, 'keeping the active entry visible scrolls the rail only, never the page')
    } finally { await context.close() }
  })
})

// ── Drawer (< 1100px) ───────────────────────────────────────────────────────
describe('#3 TOC — drawer below 1100px', () => {
  for (const [name, viewport] of [['tablet', VIEWPORTS.tablet], ['phone', VIEWPORTS.phone]]) {
    it(`AC-03.8 ${viewport.width}×${viewport.height}: no rail; toc-toggle opens toc-drawer with trapped focus; Esc/backdrop/close return focus; a link navigates and closes`, SLOW, async () => {
      const { context, page } = await open({ viewport })
      try {
        await openDoc(page, docs.toc, TOC_MARK)
        const toggle = page.locator(`${tid('doc-header')} ${tid('toc-toggle')}`)
        await toggle.waitFor({ state: 'visible', timeout: 8000 })
        assert.equal(await visibleCount(page, PANEL), 0, 'no rail below 1100px')
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
        const controls = await toggle.getAttribute('aria-controls')
        assert.ok(controls, 'toc-toggle has aria-controls')

        const drawer = page.locator(DRAWER)
        const openDrawer = async () => {
          await toggle.click()
          await drawer.waitFor({ state: 'visible', timeout: 3000 })
          await page.waitForFunction((sel) => {
            const root = document.querySelector(sel)
            return !!root && root.contains(document.activeElement)
          }, DRAWER, { timeout: 2000 }).catch(() => {})
        }
        const expectClosed = async (how) => {
          await drawer.waitFor({ state: 'hidden', timeout: 3000 })
          await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'toc-toggle', null, { timeout: 2000 }).catch(() => {})
          assert.equal(await activeTestid(page), 'toc-toggle', `${how}: focus returns to toc-toggle`)
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${how}: aria-expanded back to false`)
        }

        // open: from the left, min(85vw, 320px), over a backdrop
        await openDrawer()
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
        assert.equal(await drawer.getAttribute('id'), controls, 'aria-controls points at the drawer')
        const box = await drawer.boundingBox()
        assert.ok(box.x <= 1, `drawer opens from the left edge (x=${box.x})`)
        assert.ok(box.width <= Math.min(0.85 * viewport.width, 320) + 1, `drawer width ${box.width} <= min(85vw, 320px)`)
        await page.locator(tid('toc-backdrop')).waitFor({ state: 'visible', timeout: 2000 })
        assert.equal(await drawer.locator(tid('toc-link')).count(), 6)
        await shot(page, `${name}-drawer-open`, { ac: 'AC-03.8' })

        // focus moves into the drawer, onto the active (here: first) link
        assert.ok(await focusInside(page, DRAWER), 'focus is inside toc-drawer after opening')
        const focused = await page.evaluate(() => ({
          testid: document.activeElement?.getAttribute('data-testid'),
          href: document.activeElement?.getAttribute('href'),
          current: document.activeElement?.getAttribute('aria-current'),
        }))
        assert.equal(focused.testid, 'toc-link', 'focus lands on a toc-link')
        assert.ok(focused.current === 'location' || focused.href === '#alpha-section', `focus on the active or first link: ${JSON.stringify(focused)}`)

        // focus trap: Tab / Shift+Tab never leave the drawer
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('Tab')
          assert.ok(await focusInside(page, DRAWER), `Tab #${i + 1} stays inside the drawer (on ${await activeTestid(page)})`)
        }
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('Shift+Tab')
          assert.ok(await focusInside(page, DRAWER), `Shift+Tab #${i + 1} stays inside the drawer (on ${await activeTestid(page)})`)
        }

        // the page behind does not scroll while the drawer is open
        const y0 = await scrollY(page)
        await page.mouse.move(viewport.width - 10, Math.round(viewport.height / 2))
        await page.mouse.wheel(0, 600)
        await sleep(250)
        assert.equal(await scrollY(page), y0, 'wheel over the backdrop does not scroll the page')

        // Esc closes (00 §3.4 layer 4), focus back on the toggle
        await page.keyboard.press('Escape')
        await expectClosed('Esc')

        // backdrop click closes
        await openDrawer()
        await page.mouse.click(viewport.width - 10, Math.round(viewport.height / 2))
        await expectClosed('backdrop click')

        // toc-drawer-close closes
        await openDrawer()
        await drawer.locator(tid('toc-drawer-close')).click()
        await expectClosed('toc-drawer-close')

        // a link click navigates, then closes the drawer
        await openDrawer()
        await tocLink(page, DRAWER, 'gamma-section').click()
        await drawer.waitFor({ state: 'hidden', timeout: 3000 })
        await page.waitForFunction(() => location.hash === '#gamma-section', null, { timeout: 3000 })
        const offset = await waitAligned(page, '#gamma-section')
        assert.ok(offset !== null && offset >= 0 && offset <= 48, `Gamma heading 0–48px below the header after a drawer link, got ${offset}`)

        // no stuck scroll lock once the drawer is closed
        const y1 = await scrollY(page)
        await page.mouse.move(Math.round(viewport.width / 2), Math.round(viewport.height / 2))
        await page.mouse.wheel(0, 400)
        await page.waitForFunction((y) => (document.scrollingElement || document.documentElement).scrollTop > y, y1, { timeout: 3000 }).catch(() => {})
        assert.ok(await scrollY(page) > y1, 'the page scrolls again after the drawer closed')
      } finally { await context.close() }
    })
  }
})

// ── Heading copy-link ───────────────────────────────────────────────────────
describe('#3 heading copy-link', () => {
  const uniUrl = () => `${BASE}/d/${docKey(docs.uni)}#${UNI_ENC}`
  const heading = (page) => page.locator(`.preview-pane [id="${UNI_ID}"]`)

  async function clickAnchor(page) {
    const h = heading(page)
    await h.waitFor({ state: 'visible', timeout: 8000 })
    await h.scrollIntoViewIfNeeded()
    await h.hover()
    await h.locator(tid('heading-anchor')).click()
  }

  it('AC-03.9 the heading-anchor of `## Über café` copies <origin><base>d/<slug>#%C3%BCber-caf%C3%A9, toasts "Link copied", sets the fragment', T, async () => {
    assert.ok(docs.uni.slug, 'server assigned the requested slug')
    const { context, page } = await open({ recorder: true, permissions: ['clipboard-read', 'clipboard-write'] })
    try {
      // ?view=read must not leak into the copied link (rule 18)
      await openDoc(page, docs.uni, UNI_MARK, '?view=read')
      const before = await historyLength(page)
      await clickAnchor(page)
      await page.waitForFunction(() => (window.__mdr?.clipboard?.length ?? 0) > 0, null, { timeout: 5000 }).catch(() => {})
      const clip = await page.evaluate(() => window.__mdr?.clipboard ?? [])
      assert.equal(clip[clip.length - 1], uniUrl(), `clipboard holds ${uniUrl()}`)
      const toast = page.locator(tid('app-toast')).filter({ hasText: 'Link copied' }).first()
      await toast.waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForFunction((id) => { try { return decodeURIComponent(location.hash) === `#${id}` } catch { return false } }, UNI_ID, { timeout: 3000 }).catch(() => {})
      assert.equal(decodeURIComponent(new URL(page.url()).hash), `#${UNI_ID}`, 'location.hash decodes to #über-café')
      assert.equal(new URL(page.url()).pathname, `/d/${docKey(docs.uni)}`)
      assert.equal(await historyLength(page), before, 'copy-link uses replaceState (no Back step)')
      await shot(page, 'desktop-copy-link-toast', { ac: 'AC-03.9' })
    } finally { await context.close() }
  })

  it('AC-03.9 with clipboard permission granted, the real system clipboard holds the link', T, async () => {
    const { context, page } = await open({ recorder: false, permissions: ['clipboard-read', 'clipboard-write'] })
    try {
      await openDoc(page, docs.uni, UNI_MARK, '?view=read')
      await page.evaluate(() => navigator.clipboard.writeText('sentinel-before-copy'))
      await clickAnchor(page)
      const got = await eventually(async () => {
        const t = await page.evaluate(() => navigator.clipboard.readText())
        assert.notEqual(t, 'sentinel-before-copy', 'clipboard not written yet')
        return t
      }, { timeout: 5000 })
      assert.equal(got, uniUrl())
    } finally { await context.close() }
  })

  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    it(`AC-03.10 (${name}) the copied link opened in a fresh context lands über-café just below the sticky header`, T, async () => {
      const { context, page } = await open({ viewport })
      try {
        await page.goto(uniUrl())
        await waitForDoc(page, 'Café section body text.')
        const offset = await waitAligned(page, `[id="${UNI_ID}"]`)
        assert.ok(offset !== null && offset >= 0 && offset <= 48, `über-café top should be 0–48px below the header, got ${offset}`)
        // rule 19: scroll-margin-top >= sticky header height + 12px
        const m = await page.evaluate((id) => {
          const h = document.querySelector('[data-testid="doc-header"]') || document.querySelector('header')
          return { margin: parseFloat(getComputedStyle(document.getElementById(id)).scrollMarginTop) || 0, header: h ? h.getBoundingClientRect().height : 0 }
        }, UNI_ID)
        assert.ok(m.margin >= m.header + 12 - 0.5, `scroll-margin-top ${m.margin}px >= header ${m.header}px + 12px`)
        await shot(page, `${name}-deep-link-landing`, { ac: 'AC-03.10' })
      } finally { await context.close() }
    })
  }

  it('AC-03.11 clipboard denied (API and execCommand fail): an error app-toast appears and the fragment is still updated', T, async () => {
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
      await openDoc(page, docs.uni, UNI_MARK)
      await clickAnchor(page)
      const toast = page.locator(`${tid('app-toast')}[data-kind="error"]`).first()
      await toast.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(norm(await toast.textContent()), /Couldn.t copy/i, `error toast text: ${await toast.textContent()}`)
      assert.equal(await page.locator(tid('app-toast')).filter({ hasText: 'Link copied' }).count(), 0, 'no success toast')
      await page.waitForFunction((id) => { try { return decodeURIComponent(location.hash) === `#${id}` } catch { return false } }, UNI_ID, { timeout: 3000 }).catch(() => {})
      assert.equal(decodeURIComponent(new URL(page.url()).hash), `#${UNI_ID}`, 'the address bar fragment is still updated')
    } finally { await context.close() }
  })

  it('rule 17: Clipboard API denied but execCommand works -> textarea fallback copies the link and toasts "Link copied"', T, async () => {
    const { context, page } = await open({
      recorder: false,
      init: () => {
        const rec = []
        Object.defineProperty(window, '__copied', { value: rec })
        try {
          if (navigator.clipboard) {
            navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
            navigator.clipboard.write = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
          }
        } catch { /* ignore */ }
        document.execCommand = (cmd) => {
          if (String(cmd).toLowerCase() !== 'copy') return false
          const a = document.activeElement
          const v = a && typeof a.value === 'string'
            ? a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? a.value.length)
            : String(getSelection() ?? '')
          rec.push(v)
          return true
        }
      },
    })
    try {
      await openDoc(page, docs.uni, UNI_MARK)
      await clickAnchor(page)
      await page.waitForFunction(() => window.__copied.length > 0, null, { timeout: 5000 }).catch(() => {})
      assert.deepEqual(await page.evaluate(() => window.__copied), [uniUrl()])
      await page.locator(tid('app-toast')).filter({ hasText: 'Link copied' }).first().waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-03.12 heading-anchor contributes nothing to TOC text, document.title or a triple-click selection of the heading', T, async () => {
    const doc = await createDoc({
      markdown: `# Release notes\n\nRelease notes intro (AC-03.12).\n\n## Alpha section\n\n${filler(3, 'A')}\n\n## Beta section\n\n${filler(3, 'B')}\n`,
      filename: 'release.md', mode: 'publish',
    })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Release notes intro (AC-03.12).')
      const h2 = page.locator('.preview-pane h2#alpha-section')
      await h2.locator(tid('heading-anchor')).waitFor({ state: 'attached', timeout: 8000 })

      const links = page.locator(`${PANEL} ${tid('toc-link')}`)
      await links.first().waitFor({ state: 'visible', timeout: 5000 })
      assert.deepEqual((await links.allTextContents()).map(norm), ['Alpha section', 'Beta section'], 'TOC text has no button text/label')
      assert.deepEqual(await links.evaluateAll((as) => as.map((a) => a.getAttribute('title'))), ['Alpha section', 'Beta section'], 'full text in title')

      await page.waitForFunction(() => document.title === 'Release notes · md-review', null, { timeout: 3000 }).catch(() => {})
      assert.equal(await page.title(), 'Release notes · md-review', 'document.title is the H1 plain text only')

      const pt = await h2.evaluate((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) })
        const first = walker.nextNode()
        const r = document.createRange(); r.setStart(first, 0); r.setEnd(first, 1)
        const b = r.getBoundingClientRect()
        return { x: b.left + 2, y: b.top + b.height / 2 }
      })
      await page.mouse.click(pt.x, pt.y, { clickCount: 3 })
      const sel = await page.evaluate(() => String(getSelection() ?? ''))
      assert.equal(norm(sel), 'Alpha section', `triple-click selection is the heading text only, got ${JSON.stringify(sel)}`)
      assert.doesNotMatch(sel, /copy|link|section:/i)
    } finally { await context.close() }
  })

  it('rules 15, 16: every heading ends with one icon-only <button type=button> heading-anchor, tabbable, user-select none, ≥32×32', T, async () => {
    const doc = await createDoc({
      markdown: '# H one\n\nAnatomy intro (rule 15).\n\n## H two\n\nx\n\n### H three\n\nx\n\n#### H four\n\nx\n\n##### H five\n\nx\n\n###### H six\n\nx\n\n> ## In quote\n\n- ### In list\n',
      filename: 'anatomy.md', mode: 'publish',
    })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Anatomy intro (rule 15).')
      await waitEnhanced(page)
      const report = await page.evaluate(() => [...document.querySelectorAll('.preview-pane :is(h1,h2,h3,h4,h5,h6)')].map((h) => {
        const anchors = h.querySelectorAll('[data-testid="heading-anchor"]')
        const a = anchors[0]
        const cs = a ? getComputedStyle(a) : null
        return {
          id: h.id,
          count: anchors.length,
          last: !!a && h.lastElementChild === a,
          tag: a?.tagName,
          type: a?.getAttribute('type'),
          label: a?.getAttribute('aria-label'),
          text: a ? a.textContent.trim() : null,
          svgHidden: !!a && [...a.querySelectorAll('svg')].length > 0 && [...a.querySelectorAll('svg')].every((s) => s.getAttribute('aria-hidden') === 'true'),
          tabIndex: a ? a.tabIndex : null,
          userSelect: cs ? (cs.userSelect || cs.webkitUserSelect) : null,
        }
      }))
      assert.equal(report.length, 8, `8 markdown headings rendered: ${report.map((r) => r.id)}`)
      const TEXT = { 'h-one': 'H one', 'h-two': 'H two', 'h-three': 'H three', 'h-four': 'H four', 'h-five': 'H five', 'h-six': 'H six', 'in-quote': 'In quote', 'in-list': 'In list' }
      for (const r of report) {
        assert.equal(r.count, 1, `${r.id}: exactly one heading-anchor`)
        assert.ok(r.last, `${r.id}: heading-anchor is the heading's last element (00 §2.5)`)
        assert.equal(r.tag, 'BUTTON', `${r.id}: a <button>`)
        assert.equal(r.type, 'button', `${r.id}: type="button"`)
        assert.equal(r.label, `Copy link to section: ${TEXT[r.id]}`, `${r.id}: aria-label`)
        assert.equal(r.text, '', `${r.id}: icon only, no text`)
        assert.ok(r.svgHidden, `${r.id}: aria-hidden svg icon`)
        assert.ok(r.tabIndex >= 0, `${r.id}: in tab order`)
        assert.equal(r.userSelect, 'none', `${r.id}: user-select none`)
      }
      // hover device: visible on hover, hit area >= 32×32
      const h2 = page.locator('.preview-pane h2#h-two')
      await h2.hover()
      const a = h2.locator(tid('heading-anchor'))
      await page.waitForFunction(() => {
        const el = document.querySelector('.preview-pane h2#h-two [data-testid="heading-anchor"]')
        const cs = el && getComputedStyle(el)
        return cs && cs.visibility !== 'hidden' && parseFloat(cs.opacity) >= 0.5
      }, null, { timeout: 2000 }).catch(() => {})
      const vis = await a.evaluate((el) => { const cs = getComputedStyle(el); return { o: parseFloat(cs.opacity), v: cs.visibility } })
      assert.ok(vis.v !== 'hidden' && vis.o >= 0.5, `heading-anchor visible on heading hover: ${JSON.stringify(vis)}`)
      const box = await a.boundingBox()
      assert.ok(box.width >= 32 - 0.5 && box.height >= 32 - 0.5, `hit area ${box.width}×${box.height} >= 32×32`)
    } finally { await context.close() }
  })

  it('rule 16: on (hover: none) the heading-anchor is always visible (reduced opacity) with a ≥44×44 hit area', T, async () => {
    const { context, page } = await open({ viewport: VIEWPORTS.phone, hasTouch: true, isMobile: true })
    try {
      await openDoc(page, docs.uni, UNI_MARK)
      assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true, 'emulated touch device matches (hover: none)')
      await waitEnhanced(page)
      const a = page.locator(`.preview-pane h2#intro ${tid('heading-anchor')}`)
      const vis = await a.evaluate((el) => { const cs = getComputedStyle(el); return { o: parseFloat(cs.opacity), v: cs.visibility, d: cs.display } })
      assert.ok(vis.d !== 'none' && vis.v !== 'hidden' && vis.o > 0, `always visible without hover: ${JSON.stringify(vis)}`)
      const box = await a.boundingBox()
      assert.ok(box.width >= 44 - 0.5 && box.height >= 44 - 0.5, `hit area ${box.width}×${box.height} >= 44×44`)
    } finally { await context.close() }
  })
})

// ── Visibility rules, layout, a11y, print, live updates ────────────────────
describe('#3 TOC — where it shows', () => {
  it('AC-03.13 an HTML doc, edit view of a markdown doc, and ?embed=1 have no toc-panel / toc-toggle', T, async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Html deck</title></head><body>
<h1>Html deck</h1><p>Html body (AC-03.13).</p><h2 id="one">One</h2><p>x</p><h2 id="two">Two</h2><p>y</p><h2 id="three">Three</h2></body></html>`
    const htmlDoc = await createDoc({ markdown: html, filename: 'deck.html', contentType: 'html', mode: 'publish' })
    const { context, page } = await open()
    try {
      await page.goto(docUrl(htmlDoc))
      await page.locator('.preview-pane iframe, iframe').first().waitFor({ state: 'attached', timeout: 10000 })
      await page.locator(tid('doc-header')).first().waitFor({ state: 'visible', timeout: 10000 })
      await sleep(400)
      assert.equal(await page.locator(PANEL).count(), 0, 'HTML doc: no toc-panel')
      assert.equal(await page.locator(tid('toc-toggle')).count(), 0, 'HTML doc: no toc-toggle')

      // markdown doc: TOC in read view (control) …
      await openDoc(page, docs.toc, TOC_MARK)
      await page.locator(PANEL).waitFor({ state: 'visible', timeout: 8000 })
      // … gone in edit view
      await page.goto(docUrl(docs.toc, '?view=edit'))
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
      await sleep(300)
      assert.equal(await page.locator(PANEL).count(), 0, 'edit view: no toc-panel')
      assert.equal(await page.locator(tid('toc-toggle')).count(), 0, 'edit view: no toc-toggle')

      // rule 9: never in ?embed=1
      await page.goto(docUrl(docs.toc, '?embed=1'))
      await waitForDoc(page, TOC_MARK)
      await sleep(300)
      assert.equal(await page.locator(PANEL).count(), 0, 'embed: no toc-panel')
      assert.equal(await page.locator(tid('toc-toggle')).count(), 0, 'embed: no toc-toggle')
    } finally { await context.close() }
  })

  it('AC-03.13 (phone) edit view of a markdown doc has no toc-toggle or toc-drawer', T, async () => {
    const { context, page } = await open({ viewport: VIEWPORTS.phone })
    try {
      // control: read view at phone has the drawer toggle …
      await openDoc(page, docs.toc, TOC_MARK)
      await page.locator(`${tid('doc-header')} ${tid('toc-toggle')}`).waitFor({ state: 'visible', timeout: 8000 })
      // … edit view has none of it
      await page.goto(docUrl(docs.toc, '?view=edit'))
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
      await sleep(300)
      for (const id of ['toc-toggle', 'toc-drawer', 'toc-panel']) assert.equal(await page.locator(tid(id)).count(), 0, `edit view phone: no ${id}`)
    } finally { await context.close() }
  })

  it('AC-03.14 review-mode doc at 1400×900: TOC rail, content and comments sidebar all visible, no overlap, no horizontal page scroll', T, async () => {
    const doc = await createDoc({ markdown: tocDoc(), filename: 'review-toc.md', sessionName: uniq('Review TOC'), mode: 'review' })
    const res = await fetch(`${API}/paste/${doc.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startLine: 2, endLine: 2, selectedText: 'TOC fixture', body: 'Rail + sidebar comment (AC-03.14)', category: 'suggestion', author: 'agent' }),
    })
    assert.equal(res.status, 201, `POST comment: ${res.status}`)
    const { context, page } = await open()
    try {
      await openDoc(page, doc, TOC_MARK)
      await page.locator(PANEL).waitFor({ state: 'visible', timeout: 8000 })
      await page.locator('.sidebar').first().waitFor({ state: 'visible', timeout: 8000 })
      const g = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, h: b.height } }
        const text = document.querySelector('.preview-pane p')
        return {
          rail: r(document.querySelector('[data-testid="toc-panel"]')),
          text: r(text),
          sidebar: r(document.querySelector('.sidebar')),
          sw: document.documentElement.scrollWidth,
          iw: innerWidth,
        }
      })
      assert.ok(g.sw <= g.iw, `no horizontal page scroll: scrollWidth ${g.sw} > innerWidth ${g.iw}`)
      for (const k of ['rail', 'text', 'sidebar']) assert.ok(g[k].w > 0 && g[k].h > 0, `${k} has a box`)
      assert.ok(g.rail.r <= g.text.l + 1, `rail (right ${g.rail.r}) does not overlap the content (left ${g.text.l})`)
      assert.ok(g.text.r <= g.sidebar.l + 1, `content (right ${g.text.r}) does not overlap the sidebar (left ${g.sidebar.l})`)
      assert.ok(g.sidebar.r <= g.iw + 1, 'sidebar inside the viewport')
      await shot(page, 'desktop-review-rail-sidebar', { ac: 'AC-03.14' })
    } finally { await context.close() }
  })

  it('AC-03.15 axe: no violations in toc-panel / heading-anchors (desktop) or toc-drawer (phone); names and nav label', T, async () => {
    {
      const { context, page } = await open()
      try {
        await openDoc(page, docs.toc, TOC_MARK)
        const panel = page.locator(PANEL)
        await panel.waitFor({ state: 'visible', timeout: 8000 })
        await waitEnhanced(page)
        assert.equal(await panel.evaluate((el) => el.tagName), 'NAV')
        assert.equal(await panel.getAttribute('aria-label'), 'Table of contents')
        const labels = await page.locator(`.preview-pane ${tid('heading-anchor')}`).evaluateAll((as) => as.map((a) => a.getAttribute('aria-label')))
        assert.equal(labels.length, 7, 'one anchor per heading (Title + 6)')
        for (const l of labels) assert.ok(String(l).startsWith('Copy link to section:'), `accessible name: ${l}`)
        assert.ok(labels.includes('Copy link to section: Gamma section'))
        const v = await runAxe(page, { include: [PANEL, '.preview-pane h1', '.preview-pane h2', '.preview-pane h3'], minImpact: 'minor' })
        assert.equal(v.length, 0, formatViolations(v))
      } finally { await context.close() }
    }
    {
      const { context, page } = await open({ viewport: VIEWPORTS.phone })
      try {
        await openDoc(page, docs.toc, TOC_MARK)
        await page.locator(tid('toc-toggle')).click()
        await page.locator(DRAWER).waitFor({ state: 'visible', timeout: 3000 })
        const v = await runAxe(page, { include: [DRAWER, tid('toc-toggle')], minImpact: 'minor' })
        assert.equal(v.length, 0, formatViolations(v))
      } finally { await context.close() }
    }
  })

  it('AC-03.16 a poll update that inserts a ## before the active heading adds the entry and keeps the same id active', T, async () => {
    const doc = await createDoc({ markdown: tocDoc(), filename: 'poll-toc.md', sessionName: uniq('Poll TOC'), mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, TOC_MARK)
      await page.locator(PANEL).waitFor({ state: 'visible', timeout: 8000 })
      await scrollHeadingBelowHeader(page, 'gamma-section', 4)
      assert.deepEqual(await waitActive(page, PANEL, 'gamma-section'), ['gamma-section'])

      await putMarkdown(doc.id, tocDoc({ insertBefore: { before: 'beta-section', markdown: '## Inserted section' } }), { author: 'agent' })
      // nudge the poller (it also runs every 5 s)
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      const inserted = page.locator(`${PANEL} ${tid('toc-link')}`).filter({ hasText: 'Inserted section' })
      await inserted.waitFor({ state: 'visible', timeout: 15000 })

      const texts = (await page.locator(`${PANEL} ${tid('toc-link')}`).allTextContents()).map(norm)
      assert.deepEqual(texts, ['Alpha section', 'Alpha detail', 'Inserted section', 'Beta section', 'Gamma section', 'Gamma detail', 'Delta section'])
      await sleep(300)
      assert.deepEqual(await activeIds(page, PANEL), ['gamma-section'], 'the previously active heading (same id) is still the only active entry')
    } finally { await context.close() }
  })

  it('rule 20: print hides toc-panel and every heading-anchor', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.toc, TOC_MARK)
      await page.locator(PANEL).waitFor({ state: 'visible', timeout: 8000 })
      await waitEnhanced(page)
      await page.emulateMedia({ media: 'print' })
      const shown = await page.evaluate(() => [...document.querySelectorAll('[data-testid="toc-panel"], [data-testid="toc-toggle"], [data-testid="toc-drawer"], [data-testid="heading-anchor"]')]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => el.getAttribute('data-testid')))
      assert.deepEqual(shown, [], 'TOC controls and heading anchors are display:none in print')
    } finally { await context.close() }
  })
})
