// #5 Mobile layout — frozen acceptance tests (docs/build/specs/05-mobile-print-title.md
// rules 1–10, AC-05.1–AC-05.6, AC-05.18, AC-05.20; 00-cross-cutting.md §2, §3.2, §12).
// Print and document.title live in 05-print-title.test.mjs.
//
// Assumes #4 (routes: /d/<slug||id>, ?view=), #2 (doc-header, doc-title,
// overflow menu, review/publish mode), #6 (lazy editor) and #1 (theme switcher)
// have landed. Before #23 every shared doc is editor-capable (00 §1.2).
//
// Screenshots for the visual verifier go to .verify/screens/05/ (+ index.json):
// wide-content fixture at phone / tablet / desktop, the phone header and its
// overflow menu, the comments drawer, and the tablet meta row.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, uniq, waitForDoc } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'
import { pngDataUri, eventually } from './05-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const SCREENS = join(ROOT, '.verify/screens/05')

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }
const SLOW = { timeout: 180_000 }
const tid = (id) => `[data-testid="${id}"]`

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1400, height: 900 },
}

// ── fixtures ────────────────────────────────────────────────────────────────

const WIDE_MARK = 'Wide content fixture intro paragraph (AC-05.1).'
const WIDE_END = 'Wide content fixture closing paragraph.'
const COLS = Array.from({ length: 12 }, (_, i) => `Column header ${i + 1}`)
const LONG_CODE = `const veryLongIdentifier = "${'a1b2c3d4e5'.repeat(38)}"` // > 400 chars, no spaces in the string
const LONG_URL = `https://example.com/${'p9q8r7s6t5'.repeat(28)}` // 300 chars, unbroken
const LONG_INLINE_CODE = 'z'.repeat(220)
const LONG_CELL = 'n'.repeat(500)
const MERMAID_NODES = Array.from({ length: 14 }, (_, i) => `N${i}[Pipeline stage number ${i + 1}]`)

const WIDE_DOC = [
  '---',
  'title: Wide content fixture',
  `source: ${'frontmatter-value-without-spaces-'.repeat(6)}`,
  '---',
  '# Wide content',
  '',
  WIDE_MARK,
  '',
  `| ${COLS.join(' | ')} |`,
  `|${COLS.map(() => '---').join('|')}|`,
  `| ${COLS.map((_, i) => `row one cell ${i + 1}`).join(' | ')} |`,
  `| ${COLS.map((_, i) => `row two value ${i + 1}`).join(' | ')} |`,
  '',
  '```js',
  LONG_CODE,
  '```',
  '',
  `A paragraph with a long unbroken URL ${LONG_URL} in the middle of its text.`,
  '',
  `Inline code that is far too wide: \`${LONG_INLINE_CODE}\` and more words.`,
  '',
  `![A 2000px wide image](${pngDataUri(2000, 60)})`,
  '',
  '```mermaid',
  'flowchart LR',
  `  ${MERMAID_NODES.join(' --> ')}`,
  '```',
  '',
  '> - A list inside a blockquote holding a table:',
  '>',
  '>   | key | value |',
  '>   |-----|-------|',
  `>   | ${LONG_CELL} | short |`,
  '',
  WIDE_END,
  '',
].join('\n')

const LONG_MARK = 'Long document first paragraph (AC-05.6).'
const LONG_DOC = ['# Long document', '', LONG_MARK, '']
for (let i = 1; i <= 40; i++) {
  LONG_DOC.push(`## Section ${i}`, '', `Paragraph ${i}: ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4)}`, '')
}
const LONG_DOC_SRC = LONG_DOC.join('\n')

const REVIEW_MARK = 'Review doc body for the phone drawer (AC-05.5).'
const REVIEW_DOC = `# Review doc\n\n${REVIEW_MARK}\n\nSecond paragraph with more words.\n`

let browser
const docs = {}
const shots = []

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.wide = await createDoc({ markdown: WIDE_DOC, filename: 'wide.md', sessionName: uniq('Wide fixture'), mode: 'publish' })
  docs.long = await createDoc({ markdown: LONG_DOC_SRC, filename: 'long.md', sessionName: uniq('Long fixture'), mode: 'publish' })
  docs.review = await createDoc({ markdown: REVIEW_DOC, filename: 'review.md', sessionName: uniq('Phone review'), mode: 'review' })
  for (const body of ['First phone comment (AC-05.5)', 'Second phone comment (AC-05.5)']) await addComment(docs.review.id, body)
})
after(async () => {
  await browser?.close()
  try {
    writeFileSync(join(SCREENS, 'index-mobile.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, shots }, null, 2) + '\n')
  } catch { /* screenshots are best effort */ }
})

async function addComment(id, body) {
  const res = await fetch(`${API}/paste/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startLine: 2, endLine: 2, selectedText: 'Review doc body', body, category: 'suggestion', author: 'agent' }),
  })
  assert.equal(res.status, 201, `POST comment: ${res.status} ${await res.text()}`)
}

// ── helpers ─────────────────────────────────────────────────────────────────

const docUrl = (doc, rest = '') => `${BASE}/d/${doc.slug || doc.id}${rest}`

async function open(viewport = VIEWPORTS.desktop) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  return { context, page }
}

async function openDoc(page, doc, text, rest = '') {
  await page.goto(docUrl(doc, rest))
  await waitForDoc(page, text)
}

const header = (page) => page.locator(tid('doc-header')).first()
async function waitHeader(page) {
  await header(page).waitFor({ state: 'visible', timeout: 10000 })
}

async function shot(page, name, meta = {}, opts = {}) {
  const file = `${name}.png`
  try {
    await page.screenshot({ path: join(SCREENS, file), ...opts })
    const vp = page.viewportSize()
    shots.push({ file, width: vp?.width, height: vp?.height, ...meta })
  } catch { /* best effort; never fails a test */ }
}

/** Wait until mermaid has drawn and every image has decoded. */
async function waitWideAssets(page) {
  const m = page.locator('.preview-pane .mermaid').first()
  await m.scrollIntoViewIfNeeded()
  await m.locator('svg').first().waitFor({ state: 'attached', timeout: 15000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.preview-pane img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 })
  await page.evaluate(() => window.scrollTo(0, 0))
}

const pageOverflow = (page) => page.evaluate(() => ({
  docScrollWidth: document.documentElement.scrollWidth,
  scrollingScrollWidth: document.scrollingElement?.scrollWidth ?? 0,
  innerWidth: window.innerWidth,
  offenders: [...document.querySelectorAll('body *')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1 })
    .slice(0, 5)
    .map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''} right=${Math.round(e.getBoundingClientRect().right)}`),
}))

function assertNoHorizontalScroll(o, label) {
  assert.ok(o.docScrollWidth <= o.innerWidth,
    `${label}: documentElement.scrollWidth ${o.docScrollWidth} > innerWidth ${o.innerWidth}; widest: ${o.offenders.join(', ')}`)
  assert.ok(o.scrollingScrollWidth <= o.innerWidth,
    `${label}: scrollingElement.scrollWidth ${o.scrollingScrollWidth} > innerWidth ${o.innerWidth}`)
}

/** Visible (rendered, non-zero, not visibility:hidden) elements matching `sel` inside `root` (default document). */
const visibleIn = (page, sel, rootSel = null) => page.evaluate(([s, r]) => {
  const root = r ? document.querySelector(r) : document
  if (!root) return []
  return [...root.querySelectorAll(s)].filter((e) => {
    const rect = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    return rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
  }).map((e) => e.getAttribute('data-testid') || e.tagName.toLowerCase())
}, [sel, rootSel])

/** How many `testid` elements are rendered outside any open menu (i.e. in the bar or the page). */
const inBar = (page, id) => page.evaluate((x) => [...document.querySelectorAll(`[data-testid="${x}"]`)]
  .filter((e) => !e.closest('[role="menu"]') && !e.closest('[data-testid="header-overflow-menu"]'))
  .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' })
  .length, id)

const rectOf = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } })

const menu = (page) => page.locator(tid('header-overflow-menu'))
async function openOverflow(page) {
  if (!(await menu(page).isVisible().catch(() => false))) await page.locator(tid('header-overflow-btn')).click()
  await menu(page).waitFor({ state: 'visible', timeout: 5000 })
  return menu(page)
}

/** Interactive controls rendered in the header bar (not in an open menu). */
const headerControls = (page) => page.evaluate(() => {
  const h = document.querySelector('[data-testid="doc-header"]')
  if (!h) return null
  const sel = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
  return [...h.querySelectorAll(sel)]
    .filter((e) => !e.closest('[role="menu"]'))
    .filter((e) => {
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
    })
    .map((e) => {
      const r = e.getBoundingClientRect()
      return {
        id: e.getAttribute('data-testid') || `${e.tagName.toLowerCase()}${e.getAttribute('aria-label') ? `[aria-label="${e.getAttribute('aria-label')}"]` : ''}`,
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      }
    })
})

// ── AC-05.1 / AC-05.2: overflow containment ─────────────────────────────────
describe('#5 no horizontal page scroll (rules 3, 5)', () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    it(`AC-05.1 wide table, 400-char code line, 300-char URL, 2000px image and wide mermaid: no horizontal page scroll at ${viewport.width}×${viewport.height}`, SLOW, async () => {
      const { context, page } = await open(viewport)
      try {
        await openDoc(page, docs.wide, WIDE_MARK)
        await waitWideAssets(page)
        await shot(page, `wide-${name}-top`, { target: 'wide', viewport: name })
        const o = await pageOverflow(page)
        // Scroll through the doc so lazily laid-out content (mermaid, images) is measured too.
        const mermaid = page.locator('.preview-pane .mermaid').first()
        await mermaid.scrollIntoViewIfNeeded()
        await shot(page, `wide-${name}-mermaid`, { target: 'wide', viewport: name })
        await page.locator('.preview-pane img').first().scrollIntoViewIfNeeded()
        await shot(page, `wide-${name}-image`, { target: 'wide', viewport: name })
        await page.locator('.preview-pane').getByText(WIDE_END).scrollIntoViewIfNeeded()
        const o2 = await pageOverflow(page)
        await shot(page, `wide-${name}-full`, { target: 'wide', viewport: name, fullPage: true }, { fullPage: true })
        assertNoHorizontalScroll(o, `${name} (top)`)
        assertNoHorizontalScroll(o2, `${name} (after scrolling)`)
        assert.equal(await page.evaluate(() => window.scrollX), 0, 'the page never scrolls sideways')
      } finally { await context.close() }
    })
  }

  it('AC-05.1 rule 5: images and the mermaid svg are capped at the content width; pre and table wrappers scroll inside themselves', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      await waitWideAssets(page)
      const r = await page.evaluate(() => {
        const pane = document.querySelector('.preview-pane')
        const img = pane.querySelector('img')
        const svg = pane.querySelector('.mermaid svg')
        const pre = pane.querySelector('pre')
        const p = [...pane.querySelectorAll('p')].find((e) => e.textContent.includes('long unbroken URL'))
        const code = [...pane.querySelectorAll('p code')].find((e) => e.textContent.length > 200)
        const cs = (e) => getComputedStyle(e)
        return {
          innerWidth: window.innerWidth,
          img: { right: img.getBoundingClientRect().right, maxWidth: cs(img).maxWidth },
          svg: { right: svg.getBoundingClientRect().right, maxWidth: cs(svg).maxWidth },
          pre: { right: pre.getBoundingClientRect().right, overflowX: cs(pre).overflowX, scrolls: pre.scrollWidth > pre.clientWidth },
          p: { right: p.getBoundingClientRect().right, wrap: cs(p).overflowWrap },
          code: { right: code.getBoundingClientRect().right },
        }
      })
      assert.ok(r.img.right <= r.innerWidth, `2000px image fits: right ${r.img.right} > ${r.innerWidth}`)
      assert.equal(r.img.maxWidth, '100%', 'img max-width: 100%')
      assert.ok(r.svg.right <= r.innerWidth, `mermaid svg fits: right ${r.svg.right} > ${r.innerWidth}`)
      assert.ok(['auto', 'scroll'].includes(r.pre.overflowX), `pre overflow-x auto, got ${r.pre.overflowX}`)
      assert.ok(r.pre.scrolls, 'the long code line scrolls inside the pre')
      assert.ok(r.pre.right <= r.innerWidth, `pre box fits: right ${r.pre.right}`)
      assert.equal(r.p.wrap, 'anywhere', 'paragraphs use overflow-wrap: anywhere')
      assert.ok(r.p.right <= r.innerWidth, `URL paragraph fits: right ${r.p.right}`)
      assert.ok(r.code.right <= r.innerWidth, `inline code wraps inside the paragraph: right ${r.code.right}`)
    } finally { await context.close() }
  })

  it('AC-05.2 at 390×844 the 12-column table sits in a table-scroll that scrolls sideways without moving the page', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      const wrapper = page.locator(tid('table-scroll')).filter({ has: page.locator('th', { hasText: 'Column header 12' }) }).first()
      await wrapper.waitFor({ state: 'visible', timeout: 5000 })
      const a = await wrapper.evaluate((w) => ({
        tabindex: w.getAttribute('tabindex'),
        role: w.getAttribute('role'),
        label: w.getAttribute('aria-label'),
        cls: w.classList.contains('table-scroll'),
        lineAttrs: [...w.attributes].map((x) => x.name).filter((n) => n.startsWith('data-line')),
        overflowX: getComputedStyle(w).overflowX,
        scrollWidth: w.scrollWidth,
        clientWidth: w.clientWidth,
        directTable: w.querySelector(':scope > table') !== null,
      }))
      assert.equal(a.cls, true, 'wrapper has class table-scroll')
      assert.equal(a.directTable, true, 'the table is the wrapper\'s child')
      assert.equal(a.tabindex, '0')
      assert.equal(a.role, 'region')
      assert.equal(a.label, 'Table')
      assert.deepEqual(a.lineAttrs, [], 'the wrapper carries no data-line-*')
      assert.ok(['auto', 'scroll'].includes(a.overflowX), `overflow-x auto, got ${a.overflowX}`)
      assert.ok(a.scrollWidth > a.clientWidth, `table-scroll scrollWidth ${a.scrollWidth} > clientWidth ${a.clientWidth}`)

      await wrapper.scrollIntoViewIfNeeded()
      const box = await rectOf(wrapper)
      await page.mouse.move(box.left + box.width / 2, box.top + Math.min(20, box.height / 2))
      await page.mouse.wheel(400, 0)
      await page.waitForFunction((el) => el.scrollLeft > 0, await wrapper.elementHandle(), { timeout: 3000 })
      assert.equal(await page.evaluate(() => window.scrollX), 0, 'page scrollX stays 0 while the table scrolls')
      assert.equal(await page.evaluate(() => document.scrollingElement.scrollLeft), 0)

      // Keyboard: the focusable region scrolls with the arrow keys.
      await wrapper.evaluate((w) => { w.scrollLeft = 0 })
      await wrapper.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await page.waitForFunction((el) => el.scrollLeft > 0, await wrapper.elementHandle(), { timeout: 3000 })
      assert.equal(await page.evaluate(() => window.scrollX), 0, 'page scrollX stays 0 on keyboard scroll')
      await shot(page, 'wide-phone-table-scrolled', { target: 'wide', viewport: 'phone' })
    } finally { await context.close() }
  })

  it('AC-05.2 rule 5: the front-matter table and a table nested in a list in a blockquote are wrapped too', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      const r = await page.evaluate(() => {
        const pane = document.querySelector('.preview-pane')
        const fm = pane.querySelector('table.frontmatter')
        const nested = pane.querySelector('blockquote li table')
        const inViewport = (e) => e.getBoundingClientRect().right <= window.innerWidth
        return {
          fm: !!fm?.closest('[data-testid="table-scroll"]'),
          nested: !!nested?.closest('[data-testid="table-scroll"]'),
          nestedWrapperFits: nested ? inViewport(nested.closest('[data-testid="table-scroll"]') ?? nested) : false,
          all: [...pane.querySelectorAll('table')].every((t) => t.parentElement?.getAttribute('data-testid') === 'table-scroll'),
        }
      })
      assert.equal(r.fm, true, 'front-matter table is inside a table-scroll')
      assert.equal(r.nested, true, 'nested table is inside a table-scroll')
      assert.equal(r.nestedWrapperFits, true, 'nested table wrapper fits the viewport')
      assert.equal(r.all, true, 'every table\'s parent is a table-scroll')
    } finally { await context.close() }
  })
})

// ── AC-05.3 / AC-05.4 / rule 6: phone header ────────────────────────────────
describe('#5 phone header (rule 6, 00 §2.2)', () => {
  it('AC-05.3 at 390×844 the editor header is ≤ 56px, fits, shows the theme switcher and overflow button; copy-link only in the menu', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      await waitHeader(page)
      const h = await header(page).evaluate((e) => {
        const r = e.getBoundingClientRect()
        const kids = [...e.querySelectorAll('*')].filter((k) => {
          if (k.closest('[role="menu"]')) return false
          const kr = k.getBoundingClientRect(); const cs = getComputedStyle(k)
          return kr.width > 1 && kr.height > 1 && cs.visibility !== 'hidden'
        }).map((k) => {
          const kr = k.getBoundingClientRect()
          return { id: k.getAttribute('data-testid') || k.tagName.toLowerCase(), left: kr.left, right: kr.right, top: kr.top, bottom: kr.bottom }
        })
        return { height: r.height, top: r.top, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, kids }
      })
      await shot(page, 'phone-header', { target: 'header', viewport: 'phone' }, { clip: { x: 0, y: 0, width: 390, height: 120 } })
      assert.ok(h.height <= 56, `header bar height ${h.height} ≤ 56`)
      assert.ok(h.scrollWidth <= h.clientWidth, `header never overflows: scrollWidth ${h.scrollWidth} > clientWidth ${h.clientWidth}`)
      const vw = 390; const vh = 844
      const outside = h.kids.filter((k) => k.left < -0.5 || k.right > vw + 0.5 || k.top < -0.5 || k.bottom > vh + 0.5)
      assert.deepEqual(outside, [], 'every visible header child is inside the viewport')

      for (const id of ['theme-toggle', 'theme-style-menu', 'header-overflow-btn', 'doc-title']) {
        const loc = header(page).locator(tid(id))
        assert.ok(await loc.first().isVisible(), `${id} is visible in the header bar`)
      }
      assert.deepEqual(await visibleIn(page, tid('copy-link-btn')), [], 'copy-link-btn is not visible anywhere while the menu is closed')

      const m = await openOverflow(page)
      await m.locator(tid('copy-link-btn')).waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await page.locator(tid('copy-link-btn')).count(), 1, 'copy-link-btn exists once (in the menu), never in the bar and the menu at once')
      assert.equal(await header(page).locator(tid('copy-link-btn')).evaluateAll((els) => els.filter((e) => !e.closest('[role="menu"]')).length), 0)
      await shot(page, 'phone-overflow-menu', { target: 'header-menu', viewport: 'phone' })
    } finally { await context.close() }
  })

  it('AC-05.3 rule 6: on phone share-btn, nav-library and app-home-link move into the overflow menu; doc-updated leaves the bar', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      await waitHeader(page)
      for (const id of ['share-btn', 'nav-library', 'app-home-link', 'copy-link-btn', 'download-menu-btn', 'slides-enter-btn', 'reader-settings-btn']) {
        assert.equal(await inBar(page, id), 0, `${id} is only reachable through the overflow menu on phone`)
      }
      // doc-updated moves to doc-meta-row (below the bar), never inside the header bar.
      assert.equal(await header(page).locator(tid('doc-updated')).count(), 0, 'doc-updated is not in the phone header bar')
      await page.locator(`${tid('doc-meta-row')} ${tid('doc-updated')}`).first().waitFor({ state: 'visible', timeout: 3000 })
      const m = await openOverflow(page)
      for (const id of ['share-btn', 'nav-library', 'app-home-link', 'copy-link-btn']) {
        await m.locator(tid(id)).first().waitFor({ state: 'visible', timeout: 3000 })
      }
    } finally { await context.close() }
  })

  it('AC-05.3 rule 6: the phone view toggle is icon-only with aria-labels', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      await waitHeader(page)
      for (const id of ['view-toggle-read', 'view-toggle-edit']) {
        const seg = header(page).locator(tid(id)).first()
        assert.ok(await seg.isVisible(), `${id} visible on phone (editors)`)
        const a = await seg.evaluate((e) => ({ label: e.getAttribute('aria-label') ?? '', text: e.innerText.trim() }))
        assert.ok(a.label.trim().length > 0, `${id} has an aria-label`)
        assert.equal(a.text, '', `${id} shows no visible text on phone`)
      }
    } finally { await context.close() }
  })

  it('AC-05.3 edge: a long unbroken title ellipsises inside the phone header', T, async () => {
    const doc = await createDoc({ markdown: '# T\n\nLong title body (AC-05.3).\n', filename: 'longtitle.md', sessionName: `Quarterly${'X'.repeat(120)}`, mode: 'publish' })
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, doc, 'Long title body (AC-05.3).')
      await waitHeader(page)
      const t = await header(page).locator(tid('doc-title')).first().evaluate((e) => {
        const cs = getComputedStyle(e); const r = e.getBoundingClientRect()
        return { overflow: cs.textOverflow, ws: cs.whiteSpace, right: r.right, truncated: e.scrollWidth > e.clientWidth }
      })
      const h = await header(page).evaluate((e) => ({ height: e.getBoundingClientRect().height, sw: e.scrollWidth, cw: e.clientWidth }))
      await shot(page, 'phone-header-long-title', { target: 'header', viewport: 'phone' }, { clip: { x: 0, y: 0, width: 390, height: 120 } })
      assert.equal(t.overflow, 'ellipsis', 'doc-title uses text-overflow: ellipsis')
      assert.equal(t.ws, 'nowrap', 'doc-title stays on one line')
      assert.ok(t.truncated, 'the long title is visually truncated')
      assert.ok(t.right <= 390, `doc-title stays inside the viewport (right ${t.right})`)
      assert.ok(h.height <= 56, `header height ${h.height} ≤ 56`)
      assert.ok(h.sw <= h.cw, 'header does not overflow')
      const o = await pageOverflow(page)
      assertNoHorizontalScroll(o, 'long title')
    } finally { await context.close() }
  })

  it('AC-05.4 at 390×844 every visible header control is at least 40×40', T, async () => {
    for (const doc of [docs.wide, docs.review]) {
      const { context, page } = await open(VIEWPORTS.phone)
      try {
        await openDoc(page, doc, doc === docs.wide ? WIDE_MARK : REVIEW_MARK)
        await waitHeader(page)
        const controls = await headerControls(page)
        assert.ok(controls && controls.length >= 3, `found header controls: ${JSON.stringify(controls?.map((c) => c.id))}`)
        const small = controls.filter((c) => c.width < 40 || c.height < 40).map((c) => `${c.id} ${Math.round(c.width)}×${Math.round(c.height)}`)
        assert.deepEqual(small, [], 'controls smaller than 40×40')
      } finally { await context.close() }
    }
  })
})

// ── rule 7: overflow menu sheet; AC-05.18 a11y ─────────────────────────────
describe('#5 phone overflow menu (rule 7, AC-05.18)', () => {
  it('rule 7: on phone the overflow menu is a full-width sheet under the header, ≤ 70dvh, closing on item click, Esc and outside tap', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      await waitHeader(page)
      const m = await openOverflow(page)
      const r = await rectOf(m)
      const hb = await rectOf(header(page))
      assert.ok(r.left <= 1 && r.right >= 389, `full width: left ${r.left}, right ${r.right}`)
      assert.ok(r.top >= hb.bottom - 1, `anchored under the header: menu top ${r.top} vs header bottom ${hb.bottom}`)
      assert.ok(r.height <= 844 * 0.7 + 1, `max-height 70dvh: ${r.height}`)
      assert.ok(r.bottom <= 844, 'inside the viewport')
      const oy = await m.evaluate((e) => getComputedStyle(e).overflowY)
      assert.ok(['auto', 'scroll'].includes(oy), `internal scroll, overflow-y ${oy}`)

      await page.keyboard.press('Escape')
      await m.waitFor({ state: 'hidden', timeout: 3000 })

      await openOverflow(page)
      await page.mouse.click(195, 800) // outside tap, below the sheet
      await m.waitFor({ state: 'hidden', timeout: 3000 })

      await openOverflow(page)
      await m.locator(tid('copy-link-btn')).click()
      await m.waitFor({ state: 'hidden', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-05.18 at 390×844 axe finds no target-size / reflow violations in the header, and the overflow menu is keyboard operable', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      await waitHeader(page)
      const RULES = new Set(['target-size', 'meta-viewport', 'meta-viewport-large'])
      const v = (await runAxe(page, { include: tid('doc-header'), minImpact: 'minor', tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }))
        .filter((x) => RULES.has(x.id))
      assert.equal(v.length, 0, formatViolations(v))
      const pageWide = (await runAxe(page, { minImpact: 'minor', tags: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] })).filter((x) => x.id.startsWith('meta-viewport'))
      assert.equal(pageWide.length, 0, formatViolations(pageWide))
      assertNoHorizontalScroll(await pageOverflow(page), 'review doc at 390 (reflow)')

      // Keyboard: Enter opens and focuses an item, arrows move, Esc closes and returns focus.
      const trigger = page.locator(tid('header-overflow-btn'))
      await trigger.focus()
      assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu')
      await page.keyboard.press('Enter')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
      const focused = () => page.evaluate(() => {
        const a = document.activeElement
        const m = document.querySelector('[data-testid="header-overflow-menu"]')
        const items = m ? [...m.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')] : []
        return { inMenu: !!m && m.contains(a), index: items.indexOf(a), count: items.length }
      })
      await eventually(async () => {
        const f = await focused()
        assert.ok(f.inMenu && f.index >= 0, `focus moves to a menu item on open: ${JSON.stringify(f)}`)
      }, { timeout: 2000 })
      const f1 = await focused()
      assert.ok(f1.count >= 2, `menu has items: ${f1.count}`)
      await page.keyboard.press('ArrowDown')
      const f2 = await focused()
      assert.ok(f2.inMenu && f2.index >= 0 && f2.index !== f1.index, `ArrowDown moves focus: ${f1.index} -> ${f2.index}`)
      await page.keyboard.press('Escape')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'header-overflow-btn', 'Esc returns focus to the trigger')
    } finally { await context.close() }
  })
})

// ── AC-05.5 / rules 8–10: comments, banners, modals on phone ────────────────
describe('#5 phone and tablet review UI (rules 8–10)', () => {
  it('AC-05.5 at 390×844 there is no side rail; comments-toggle shows the count and opens comments-drawer; Esc closes it', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      const toggle = page.locator(tid('comments-toggle'))
      await toggle.waitFor({ state: 'visible', timeout: 10000 })
      assert.deepEqual(await visibleIn(page, '.sidebar'), [], 'no .sidebar is visible beside the content')
      assert.deepEqual(await visibleIn(page, '.sidebar-toggle'), [], 'no 16px sidebar toggle strip')

      const text = (await toggle.innerText()).replace(/\s+/g, ' ')
      assert.match(text, /Comments/i, 'toggle is labelled Comments')
      assert.match(text, /\b2\b/, `toggle shows the count 2: "${text}"`)
      const tr = await rectOf(toggle)
      assert.equal(await toggle.evaluate((e) => getComputedStyle(e).position), 'fixed', 'comments-toggle is position: fixed')
      assert.ok(tr.right <= 390 && tr.bottom <= 844 && tr.left >= 0, `toggle inside the viewport: ${JSON.stringify(tr)}`)
      assert.ok(tr.right > 390 * 0.6 && tr.bottom > 844 * 0.6, `toggle sits bottom-right: ${JSON.stringify(tr)}`)
      await shot(page, 'phone-review-closed', { target: 'review', viewport: 'phone' })

      await toggle.click()
      const drawer = page.locator(tid('comments-drawer'))
      await drawer.waitFor({ state: 'visible', timeout: 3000 })
      for (const body of ['First phone comment (AC-05.5)', 'Second phone comment (AC-05.5)']) {
        await drawer.getByText(body).first().waitFor({ state: 'visible', timeout: 3000 })
      }
      const dr = await rectOf(drawer)
      assert.ok(dr.left >= -0.5 && dr.right <= 390.5 && dr.bottom <= 844.5, `drawer inside the viewport: ${JSON.stringify(dr)}`)
      assert.ok(dr.height <= 844 * 0.8 + 1, `bottom sheet max-height 80dvh: ${dr.height}`)
      assert.ok(dr.bottom >= 844 - 1, `drawer is anchored to the bottom: bottom ${dr.bottom}`)
      await shot(page, 'phone-comments-drawer', { target: 'review', viewport: 'phone' })

      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'hidden', timeout: 3000 })

      await toggle.click()
      await drawer.waitFor({ state: 'visible', timeout: 3000 })
      await page.locator(tid('comments-drawer-close')).click()
      await drawer.waitFor({ state: 'hidden', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-05.5 rule 8: at 820×1180 (tablet) the comments are also a drawer, not a side rail', T, async () => {
    const { context, page } = await open(VIEWPORTS.tablet)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      await page.locator(tid('comments-toggle')).waitFor({ state: 'visible', timeout: 10000 })
      assert.deepEqual(await visibleIn(page, '.sidebar'), [], 'no side rail below 1100px')
      assert.deepEqual(await visibleIn(page, '.sidebar-toggle'), [], 'no toggle strip below 1100px')
    } finally { await context.close() }
  })

  it('AC-05.5 rule 8: at 1400×900 the side rail stays and there is no comments-toggle', T, async () => {
    const { context, page } = await open(VIEWPORTS.desktop)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      await page.locator('.sidebar').first().waitFor({ state: 'visible', timeout: 10000 })
      assert.deepEqual(await visibleIn(page, tid('comments-toggle')), [], 'no comments-toggle on desktop')
    } finally { await context.close() }
  })

  it('rule 9: review banners fit the phone width (no horizontal page scroll on a review doc)', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      await page.locator('.approval-banner, .summary-panel').first().waitFor({ state: 'visible', timeout: 10000 })
      const wide = await page.evaluate(() => [...document.querySelectorAll('.approval-banner, .summary-panel, .notice-bar, .changes-banner, .conflict-bar, [data-testid="changes-banner"], [data-testid="conflict-bar"]')]
        .filter((e) => e.getBoundingClientRect().width > 0)
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5 || e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.className))
      assert.deepEqual(wide, [], 'banners never exceed the viewport width')
      assertNoHorizontalScroll(await pageOverflow(page), 'review doc at 390')
    } finally { await context.close() }
  })

  it('rule 10: the revisions modal fits at 390 (width ≤ 100vw − 32px, inside the viewport)', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.review, REVIEW_MARK)
      await waitHeader(page)
      const m = await openOverflow(page)
      await m.locator(tid('menu-history')).click()
      const modal = page.locator(tid('revisions-modal'))
      await modal.waitFor({ state: 'visible', timeout: 5000 })
      const box = await modal.evaluate((e) => {
        // The dialog box is the largest element in the modal subtree that is not the full-screen backdrop.
        const cands = [e, ...e.querySelectorAll('*')].filter((x) => {
          const r = x.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && !(r.width >= window.innerWidth && r.height >= window.innerHeight)
        })
        const area = (x) => { const b = x.getBoundingClientRect(); return b.width * b.height }
        const r = (cands.sort((p, q) => area(q) - area(p))[0] ?? e).getBoundingClientRect()
        return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }
      })
      await shot(page, 'phone-revisions-modal', { target: 'modal', viewport: 'phone' })
      assert.ok(box.left >= 0 && box.right <= 390, `modal inside the viewport: ${JSON.stringify(box)}`)
      assert.ok(box.width <= 390 - 32 + 0.5, `modal width ${box.width} ≤ 100vw − 32px`)
      assertNoHorizontalScroll(await pageOverflow(page), 'revisions modal open')
    } finally { await context.close() }
  })
})

// ── AC-05.6 / rule 2: document scroll + sticky header ───────────────────────
describe('#5 scroll model (rule 2)', () => {
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    it(`AC-05.6 read view at ${viewport.width}×${viewport.height} scrolls the document and the header sticks at top 0`, T, async () => {
      const { context, page } = await open(viewport)
      try {
        await openDoc(page, docs.long, LONG_MARK)
        await waitHeader(page)
        assert.ok(await page.evaluate(() => document.scrollingElement.scrollHeight > window.innerHeight + 100), 'the document itself is taller than the viewport')
        await page.mouse.move(viewport.width / 2, viewport.height / 2)
        await page.mouse.wheel(0, 1500)
        await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 3000 }).catch(() => {})
        const s = await page.evaluate(() => ({ y: window.scrollY, top: document.querySelector('[data-testid="doc-header"]')?.getBoundingClientRect().top }))
        assert.ok(s.y > 0, `window.scrollY > 0 after scrolling (document scroll), got ${s.y}`)
        assert.ok(Math.abs(s.top) < 0.5, `header top is 0 while scrolled, got ${s.top}`)
        assert.ok(await header(page).isVisible(), 'header stays visible')
        await shot(page, `long-${name}-scrolled`, { target: 'long', viewport: name })
      } finally { await context.close() }
    })
  }

  it('rule 2: edit view keeps the fixed-viewport layout (the editor scrolls, the page does not)', T, async () => {
    const { context, page } = await open(VIEWPORTS.desktop)
    try {
      await page.goto(docUrl(docs.long, '?view=edit'))
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
      const box = await rectOf(page.locator('.cm-scroller').first())
      await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2)
      await page.mouse.wheel(0, 1500)
      await page.waitForFunction(() => (document.querySelector('.cm-scroller')?.scrollTop ?? 0) > 0, null, { timeout: 3000 })
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'window.scrollY stays 0 in edit view')
    } finally { await context.close() }
  })

  it('rule 4: body text is at least 16px on phone', T, async () => {
    const { context, page } = await open(VIEWPORTS.phone)
    try {
      await openDoc(page, docs.long, LONG_MARK)
      const px = await page.locator('.preview-pane p').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
      assert.ok(px >= 16, `paragraph font-size ${px}px ≥ 16px`)
    } finally { await context.close() }
  })
})

// ── AC-05.20: tablet meta row and overflow placement ────────────────────────
describe('#5 tablet header (rule 6, 00 §2.2)', () => {
  it('AC-05.20 at 820×1180 doc-meta-row sits below the header bar with doc-updated; download/slides only via the overflow menu', T, async () => {
    const { context, page } = await open(VIEWPORTS.tablet)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      await waitHeader(page)
      const row = page.locator(tid('doc-meta-row'))
      await row.waitFor({ state: 'visible', timeout: 5000 })
      const hb = await rectOf(header(page))
      const rb = await rectOf(row)
      assert.ok(hb.height <= 56, `header bar height ${hb.height} ≤ 56`)
      assert.ok(rb.top >= hb.bottom - 1, `doc-meta-row (top ${rb.top}) is below the header bar (bottom ${hb.bottom})`)
      assert.equal(await header(page).locator(tid('doc-meta-row')).count(), 0, 'doc-meta-row is not inside the header bar')
      await row.locator(tid('doc-updated')).waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await header(page).locator(tid('doc-updated')).count(), 0, 'doc-updated is not in the header bar')
      const hw = await header(page).evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }))
      assert.ok(hw.sw <= hw.cw, 'tablet header never overflows')

      for (const id of ['download-menu-btn', 'slides-enter-btn', 'reviewer-name']) {
        assert.equal(await inBar(page, id), 0, `${id} is not visible outside the overflow menu at tablet width`)
      }
      // Tablet keeps copy-link-btn in the bar, icon only (00 §2.2).
      const copy = header(page).locator(tid('copy-link-btn')).first()
      assert.ok(await copy.isVisible(), 'copy-link-btn in the tablet bar')
      assert.equal((await copy.innerText()).trim(), '', 'copy-link-btn is icon-only at tablet width')
      assert.ok(((await copy.getAttribute('aria-label')) ?? '').trim().length > 0, 'icon-only copy-link-btn has an aria-label')
      await shot(page, 'tablet-header-meta-row', { target: 'header', viewport: 'tablet' }, { clip: { x: 0, y: 0, width: 820, height: 160 } })

      // When #19 has landed, the Download group is reachable in the menu.
      await openOverflow(page)
      const downloadsOutside = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="download-"]')]
        .filter((e) => !e.closest('[data-testid="header-overflow-menu"]') && e.getBoundingClientRect().width > 0).length)
      assert.equal(downloadsOutside, 0, 'download controls only appear inside header-overflow-menu')
      await shot(page, 'tablet-overflow-menu', { target: 'header-menu', viewport: 'tablet' })
    } finally { await context.close() }
  })

  it('AC-05.20 at 1400×900 there is no doc-meta-row; doc-updated is in the header bar', T, async () => {
    const { context, page } = await open(VIEWPORTS.desktop)
    try {
      await openDoc(page, docs.wide, WIDE_MARK)
      await waitHeader(page)
      await header(page).locator(tid('doc-updated')).first().waitFor({ state: 'visible', timeout: 5000 })
      assert.deepEqual(await visibleIn(page, tid('doc-meta-row')), [], 'no doc-meta-row at ≥ 1100px')
    } finally { await context.close() }
  })
})
