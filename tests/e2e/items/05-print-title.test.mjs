// #5 Print CSS and document.title — frozen acceptance tests
// (docs/build/specs/05-mobile-print-title.md rules 11–20, AC-05.7–AC-05.17,
// AC-05.19 e2e half; 00-cross-cutting.md §5).
// Layout/phone tests live in 05-mobile-layout.test.mjs; pure docTitle and
// line-offset rules in tests/items/05-mobile-print-title.test.ts.
//
// Print is checked with page.emulateMedia({ media: 'print' }) + computed styles,
// and with page.pdf() (Chromium headless) for page count and printed text.
// emulateMedia does not fire beforeprint/afterprint, so the mermaid light
// re-render (rule 13) is driven by dispatching those events.
//
// Elements owned by later items (toc-panel/#3, heading-anchor/#3,
// code-toolbar/#14) are asserted hidden when present; their own items add
// print ACs (spec "Dependencies").
//
// Artefacts for the visual verifier: .verify/screens/05/print-*.png and
// print-dark.pdf.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, waitForDoc } from '../lib/docs.mjs'
import { pdfInfo, squash, parseRgb, luminance, contrast, eventually } from './05-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const SCREENS = join(ROOT, '.verify/screens/05')

const T = { timeout: 60_000 }
const SLOW = { timeout: 120_000 }
const tid = (id) => `[data-testid="${id}"]`
const DESKTOP = { width: 1400, height: 900 }
const TABLET = { width: 820, height: 1180 }
const THEME_KEY = 'md-review-theme'
const WHITE = [255, 255, 255]
const SUFFIX = ' · md-review'

// ── fixtures ────────────────────────────────────────────────────────────────

const PRINT_MARK = 'Print fixture body paragraph (AC-05.7).'
const PRINT_DOC = `# Print fixture

${PRINT_MARK} See [spec](https://ex.com/a), https://ex.com/b, [intro](#print-fixture), [mail](mailto:a@ex.com) and <https://ex.com/c>.

## Code and table

\`\`\`js
const printed = "${'wrap-me-'.repeat(40)}END"
\`\`\`

| Name | Value |
|------|-------|
| alpha | 1 |
| beta | 2 |

> A quoted note for break rules.

![tiny](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)

\`\`\`mermaid
flowchart LR
  A[Start] --> B[Middle] --> C[End]
\`\`\`

### Small heading

Closing paragraph of the print fixture.
`

// ~6+ printed pages: 70 paragraphs, a wide code line and a 12-column table.
const PDF_LAST = 'Final paragraph PDFENDMARKER closes the document.'
const PDF_CODE_END = 'CODELINEENDMARKER'
const PDF_TABLE_END = 'LASTCOLUMNMARKER'
const PDF_DOC = (() => {
  const out = ['# Five page fixture', '', 'First paragraph of the long print fixture.', '']
  for (let i = 1; i <= 70; i++) {
    if (i === 20) out.push('```text', `${'x'.repeat(300)}${PDF_CODE_END}`, '```', '')
    if (i === 40) {
      const cols = Array.from({ length: 12 }, (_, c) => `Col${c + 1}`)
      out.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`,
        `| ${cols.map((_, c) => (c === 11 ? PDF_TABLE_END : `cell${c + 1}`)).join(' | ')} |`, '')
    }
    out.push(`Paragraph ${i}. ${'The quick brown fox jumps over the lazy dog while the print stylesheet decides where pages break. '.repeat(3)}`, '')
  }
  out.push(PDF_LAST, '')
  return out.join('\n')
})()

let browser
const docs = {}
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-05-'))
  docs.print = await createDoc({ markdown: PRINT_DOC, filename: 'print.md', sessionName: uniq('Print fixture'), mode: 'review' })
  for (const body of ['Print comment one', 'Print comment two']) await addComment(docs.print.id, body)
  docs.pdf = await createDoc({ markdown: PDF_DOC, filename: 'five.md', sessionName: uniq('Five pages'), mode: 'publish' })
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function addComment(id, body) {
  const res = await fetch(`${API}/paste/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startLine: 2, endLine: 2, selectedText: 'Print fixture body', body, category: 'suggestion', author: 'agent' }),
  })
  assert.equal(res.status, 201, `POST comment: ${res.status} ${await res.text()}`)
}

// ── helpers ─────────────────────────────────────────────────────────────────

const docUrl = (doc, rest = '') => `${BASE}/d/${doc.slug || doc.id}${rest}`
const fileUrl = (path) => `${BASE}/?filePath=${encodeURIComponent(path)}`

async function open({ viewport = DESKTOP, theme } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  if (theme) {
    await context.addInitScript(([k, v]) => {
      if (window.top !== window) return
      try {
        if (!sessionStorage.getItem('__t05_seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__t05_seeded', '1') }
      } catch { /* storage unavailable */ }
    }, [THEME_KEY, theme])
  }
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  return { context, page }
}

async function openDoc(page, doc, text, rest = '') {
  await page.goto(docUrl(doc, rest))
  await waitForDoc(page, text)
}

function writeLocal(name, content) {
  const p = join(tmp, name)
  writeFileSync(p, content)
  return p
}

/** Wait for document.title to equal `want`, then return it (or the last value seen). */
async function expectTitle(page, want, timeout = 10000) {
  await page.waitForFunction((w) => document.title === w, want, { timeout }).catch(() => {})
  assert.equal(await page.title(), want)
}

async function waitMermaid(page) {
  const m = page.locator('.preview-pane .mermaid').first()
  await m.scrollIntoViewIfNeeded()
  await m.locator('svg').first().waitFor({ state: 'attached', timeout: 15000 })
}

/** For each selector: how many matches exist and how many are still displayed (no `display: none` on self or an ancestor). */
const printVisibility = (page, selectors) => page.evaluate((sels) => {
  const hidden = (el) => { for (let e = el; e; e = e.parentElement) { if (getComputedStyle(e).display === 'none') return true } return false }
  return Object.fromEntries(sels.map((s) => {
    const els = [...document.querySelectorAll(s)]
    return [s, { count: els.length, shown: els.filter((e) => !hidden(e)).length }]
  }))
}, selectors)

/** The colour actually behind an element: first non-transparent background up the tree (white canvas if none). */
const effectiveBg = (page, selector) => page.evaluate((sel) => {
  const el = typeof sel === 'string' ? document.querySelector(sel) : null
  for (let e = el; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg
  }
  return 'rgb(255, 255, 255)'
}, selector)

const colorOf = (page, selector, prop = 'color', pseudo = null) => page.evaluate(([s, p, ps]) => {
  const e = document.querySelector(s)
  return e ? getComputedStyle(e, ps).getPropertyValue(p) : null
}, [selector, prop, pseudo])

const mermaidNodeFill = (page) => page.evaluate(() => {
  const r = document.querySelector('.preview-pane .mermaid svg .node rect, .preview-pane .mermaid svg .node polygon, .preview-pane .mermaid svg .node path')
  return r ? getComputedStyle(r).fill : null
})

async function printMedia(page) {
  await page.emulateMedia({ media: 'print' })
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
}
async function screenMedia(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await page.emulateMedia({ media: 'screen' })
}

// ── AC-05.7 / rule 11: chrome hidden in print ───────────────────────────────
describe('#5 print hides app chrome (rule 11)', () => {
  it('AC-05.7 print emulation hides the header, TOC, comments sidebar, approval banner, summary panel, heading anchors and code toolbars', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.print, PRINT_MARK)
      await page.locator(tid('doc-header')).waitFor({ state: 'visible', timeout: 10000 })
      for (const sel of ['.sidebar', '.approval-banner', '.summary-panel']) {
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: 10000 })
      }
      await printMedia(page)
      const MUST_EXIST = [tid('doc-header'), '.sidebar', '.approval-banner', '.summary-panel']
      const IF_PRESENT = [
        'header', tid('toc-panel'), tid('toc-toggle'), tid('toc-drawer'), tid('heading-anchor'), tid('code-toolbar'),
        tid('doc-meta-row'), tid('comments-toggle'), tid('comments-drawer'), '.sidebar-toggle', '.notice-bar',
        tid('changes-banner'), tid('conflict-bar'), tid('app-toast'), tid('header-overflow-menu'), tid('embed-open-link'),
        '.preview-pane button', '.cm-editor',
      ]
      const v = await printVisibility(page, [...MUST_EXIST, ...IF_PRESENT])
      await page.screenshot({ path: join(SCREENS, 'print-review-desktop.png'), fullPage: true }).catch(() => {})
      for (const s of MUST_EXIST) assert.ok(v[s].count > 0, `${s} exists on the review doc (fixture check)`)
      const shown = Object.entries(v).filter(([, x]) => x.shown > 0).map(([s, x]) => `${s} (${x.shown}/${x.count})`)
      assert.deepEqual(shown, [], 'elements still displayed in print')
      // The doc itself still prints.
      assert.ok(await page.locator('.preview-pane').getByText(PRINT_MARK).isVisible(), 'the content is visible in print')
    } finally { await context.close() }
  })

  it('AC-05.7 rule 11: an open overflow menu, the selection bar/popover and the comments drawer never print', T, async () => {
    const { context, page } = await open({ viewport: TABLET })
    try {
      await openDoc(page, docs.print, PRINT_MARK)
      await page.locator(tid('doc-header')).waitFor({ state: 'visible', timeout: 10000 })
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('header-overflow-menu')).waitFor({ state: 'visible', timeout: 5000 })
      await printMedia(page)
      let v = await printVisibility(page, [tid('header-overflow-menu'), tid('doc-header')])
      assert.equal(v[tid('header-overflow-menu')].shown, 0, 'open overflow menu is hidden in print')
      await screenMedia(page)
      await page.keyboard.press('Escape')

      await page.locator(tid('comments-toggle')).click()
      await page.locator(tid('comments-drawer')).waitFor({ state: 'visible', timeout: 5000 })
      await printMedia(page)
      v = await printVisibility(page, [tid('comments-drawer'), tid('comments-toggle'), '.sidebar'])
      const shown = Object.entries(v).filter(([, x]) => x.shown > 0).map(([s]) => s)
      assert.deepEqual(shown, [], 'comments drawer / toggle are hidden in print')
    } finally { await context.close() }
  })
})

// ── AC-05.8 / rule 13: light palette forced ─────────────────────────────────
describe('#5 print forces a light palette (rule 13)', () => {
  for (const theme of ['dark', 'github-dark', 'locus-dark']) {
    it(`AC-05.8 theme ${theme}: white content background, ≥ 7:1 body text, light mermaid in print; restored after print`, SLOW, async () => {
      const { context, page } = await open({ theme })
      try {
        await openDoc(page, docs.print, PRINT_MARK)
        await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5000 })
        await waitMermaid(page)
        const screenFill = await mermaidNodeFill(page)

        await printMedia(page)
        const p = `.preview-pane p`
        const bgContent = parseRgb(await effectiveBg(page, p))
        const bgBody = parseRgb(await effectiveBg(page, 'body'))
        const bgPane = parseRgb(await effectiveBg(page, '.preview-pane'))
        const text = parseRgb(await colorOf(page, p))
        const link = parseRgb(await colorOf(page, '.preview-pane a[href="https://ex.com/a"]'))
        const preBg = parseRgb(await effectiveBg(page, '.preview-pane pre'))
        assert.deepEqual(bgContent?.slice(0, 3), WHITE, `content background behind a paragraph is white (${theme}), got ${bgContent}`)
        assert.deepEqual(bgPane?.slice(0, 3), WHITE, `.preview-pane background is white (${theme}), got ${bgPane}`)
        assert.deepEqual(bgBody?.slice(0, 3), WHITE, `page background is white (${theme}), got ${bgBody}`)
        assert.ok(text && contrast(text, WHITE) >= 7, `paragraph text contrast vs white ≥ 7:1, got ${text && contrast(text, WHITE).toFixed(2)} (${text})`)
        assert.ok(link && contrast(link, WHITE) >= 4.5, `link contrast vs white ≥ 4.5:1, got ${link && contrast(link, WHITE).toFixed(2)} (${link})`)
        assert.ok(preBg && luminance(preBg) >= 0.75, `code background is light, got ${preBg}`)

        // Mermaid re-rendered light on beforeprint.
        await eventually(async () => {
          const fill = parseRgb(await mermaidNodeFill(page))
          assert.ok(fill && luminance(fill) >= 0.5, `mermaid node fill is light in print, got ${fill}`)
        }, { timeout: 8000 })
        const svgBg = parseRgb(await effectiveBg(page, '.preview-pane .mermaid svg'))
        assert.ok(svgBg && luminance(svgBg) >= 0.8, `mermaid svg background is light, got ${svgBg}`)
        await page.screenshot({ path: join(SCREENS, `print-${theme}.png`), fullPage: true }).catch(() => {})

        await screenMedia(page)
        await eventually(async () => {
          assert.equal(await mermaidNodeFill(page), screenFill, 'mermaid returns to the screen theme after print')
        }, { timeout: 8000 })
      } finally { await context.close() }
    })
  }
})

// ── AC-05.9 / rule 15: printed link targets ─────────────────────────────────
describe('#5 print shows link targets (rule 15)', () => {
  it('AC-05.9 [spec](https://ex.com/a) prints " (https://ex.com/a)"; autolinks, #anchors and mailto: print nothing extra', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.print, PRINT_MARK)
      const after = (href) => colorOf(page, `.preview-pane a[href="${href}"]`, 'content', '::after')
      const EMPTY = new Set(['none', 'normal', '""', "''", ''])
      assert.ok(EMPTY.has(await after('https://ex.com/a')), 'no link target on screen')
      await printMedia(page)
      assert.equal(await after('https://ex.com/a'), '" (https://ex.com/a)"')
      for (const href of ['https://ex.com/b', 'https://ex.com/c', '#print-fixture', 'mailto:a@ex.com']) {
        const c = await after(href)
        assert.ok(c !== null, `link ${href} exists in the fixture`)
        assert.ok(EMPTY.has(c), `${href} ::after content is none/empty in print, got ${c}`)
      }
    } finally { await context.close() }
  })
})

// ── AC-05.10 / rules 12, 14: print layout ───────────────────────────────────
describe('#5 print layout and page breaks (rules 12, 14)', () => {
  it('AC-05.10 break-inside: avoid on pre/tr/img, break-after: avoid on headings, pre-wrap code, no clipping ancestor', T, async () => {
    const { context, page } = await open()
    try {
      await openDoc(page, docs.print, PRINT_MARK)
      await waitMermaid(page)
      await printMedia(page)
      const r = await page.evaluate(() => {
        const pane = document.querySelector('.preview-pane')
        const cs = (e) => getComputedStyle(e)
        const bi = (s) => [...pane.querySelectorAll(s)].map((e) => cs(e).breakInside)
        const ba = [...pane.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((e) => `${e.tagName}:${cs(e).breakAfter}`)
        const pre = pane.querySelector('pre')
        const scroll = pane.querySelector('.table-scroll')
        const thead = pane.querySelector('thead')
        const p = pane.querySelector('p')
        const clipping = []
        for (let e = p; e && e !== document.documentElement; e = e.parentElement) {
          const c = cs(e)
          const name = `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`
          if (c.overflowX !== 'visible' || c.overflowY !== 'visible') clipping.push(`${name} overflow ${c.overflowX}/${c.overflowY}`)
          if (c.maxHeight !== 'none') clipping.push(`${name} max-height ${c.maxHeight}`)
          if (e.scrollHeight > e.clientHeight + 2 && e !== document.body) clipping.push(`${name} fixed height ${e.clientHeight} < content ${e.scrollHeight}`)
        }
        return {
          pre: bi('pre'), tr: bi('tr'), img: bi('img'), blockquote: bi('blockquote'), mermaid: bi('.mermaid'),
          headings: ba,
          preWs: cs(pre).whiteSpace, preOverflow: `${cs(pre).overflowX}/${cs(pre).overflowY}`,
          scrollOverflow: scroll ? `${cs(scroll).overflowX}/${cs(scroll).overflowY}` : null,
          thead: thead ? cs(thead).display : null,
          clipping,
        }
      })
      for (const k of ['pre', 'tr', 'img']) {
        assert.ok(r[k].length > 0, `fixture has ${k}`)
        assert.deepEqual([...new Set(r[k])], ['avoid'], `${k} break-inside: avoid`)
      }
      for (const k of ['blockquote', 'mermaid']) assert.deepEqual([...new Set(r[k])], ['avoid'], `${k} break-inside: avoid (rule 14)`)
      assert.ok(r.headings.length >= 3)
      assert.deepEqual(r.headings.filter((h) => !h.endsWith(':avoid')), [], 'headings break-after: avoid')
      assert.equal(r.preWs, 'pre-wrap', 'pre wraps in print')
      assert.equal(r.preOverflow, 'visible/visible', 'pre overflow visible in print (rule 12)')
      assert.equal(r.scrollOverflow, 'visible/visible', '.table-scroll overflow visible in print (rule 12)')
      assert.equal(r.thead, 'table-header-group', 'thead repeats per page (rule 14)')
      assert.deepEqual(r.clipping, [], 'no ancestor of the content clips it in print')
    } finally { await context.close() }
  })

  it('AC-05.11 page.pdf() of a 5-page doc in dark theme has ≥ 5 pages and contains the last paragraph', SLOW, async () => {
    const { context, page } = await open({ theme: 'dark' })
    try {
      await openDoc(page, docs.pdf, 'First paragraph of the long print fixture.')
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5000 })
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
      const pdf = await page.pdf({ format: 'A4', printBackground: true })
      writeFileSync(join(SCREENS, 'print-dark.pdf'), pdf)
      const info = pdfInfo(pdf)
      const text = squash(info.text)
      assert.ok(info.pages >= 5, `PDF has ${info.pages} pages (whole doc printed, expected ≥ 5)`)
      assert.ok(text.includes(squash(PDF_LAST)), `PDF contains the last paragraph; text tail: ${info.text.slice(-200)}`)
      assert.ok(text.includes(PDF_CODE_END), 'rule 12: the end of a long code line is printed (pre wraps, not clipped)')
      assert.ok(text.includes(PDF_TABLE_END), 'rule 12: the last column of a 12-column table is printed (not clipped)')
    } finally { await context.close() }
  })
})

// ── document.title (rules 17–19) ────────────────────────────────────────────
describe('#5 document.title (rules 17–19)', () => {
  it('AC-05.12 local ?filePath= docs: front-matter title, else the H1, else the filename without extension', T, async () => {
    const q3 = writeLocal('q3.md', '---\ntitle: "Q3 Plan"\nowner: me\n---\n# Something else\n\nQ3 body (AC-05.12).\n')
    const h1 = writeLocal('heading.md', '# Something else\n\nHeading body (AC-05.12).\n')
    const notes = writeLocal('notes.md', 'Just notes, no heading (AC-05.12).\n\n## Only an H2\n')
    const { context, page } = await open()
    try {
      await page.goto(fileUrl(q3)); await waitForDoc(page, 'Q3 body (AC-05.12).')
      await expectTitle(page, `Q3 Plan${SUFFIX}`)
      await page.goto(fileUrl(h1)); await waitForDoc(page, 'Heading body (AC-05.12).')
      await expectTitle(page, `Something else${SUFFIX}`)
      await page.goto(fileUrl(notes)); await waitForDoc(page, 'Just notes, no heading (AC-05.12).')
      await expectTitle(page, `notes${SUFFIX}`)
    } finally { await context.close() }
  })

  it('AC-05.13 (e2e) an H1 `# **Launch** [plan](http://x) 🚀` titles the tab and doc-title', T, async () => {
    const p = writeLocal('launch.md', '# **Launch** [plan](http://x) 🚀\n\nLaunch body (AC-05.13).\n')
    const { context, page } = await open()
    try {
      await page.goto(fileUrl(p)); await waitForDoc(page, 'Launch body (AC-05.13).')
      await expectTitle(page, `Launch plan 🚀${SUFFIX}`)
      const t = page.locator(`${tid('doc-header')} ${tid('doc-title')}`).first()
      await t.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal((await t.innerText()).replace(/\s+/g, ' ').trim(), 'Launch plan 🚀')
    } finally { await context.close() }
  })

  it('AC-05.14 an HTML doc titles the tab from its <title>; the title parser executes none of its scripts', T, async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Board deck</title>
<script>try { window.parent.__t05script = 1 } catch (e) {} ; window.__t05inner = 1</script></head>
<body><img src="x-invalid:" onerror="try { window.parent.__t05img = 1 } catch (e) {}"><h1>Another heading</h1><p>Board body (AC-05.14).</p></body></html>`
    const doc = await createDoc({ markdown: html, filename: 'board.html', contentType: 'html', mode: 'publish' })
    const { context, page } = await open()
    try {
      await page.goto(docUrl(doc))
      await page.locator('.preview-pane iframe, iframe').first().waitFor({ state: 'attached', timeout: 10000 })
      await expectTitle(page, `Board deck${SUFFIX}`)
      // give any stray handler a moment to fire
      await page.waitForTimeout(300)
      const trace = await page.evaluate(() => ({ s: window.__t05script ?? null, i: window.__t05img ?? null, inner: window.__t05inner ?? null }))
      assert.deepEqual(trace, { s: null, i: null, inner: null }, 'no script or handler from the HTML ran in the app window')
    } finally { await context.close() }
  })

  it('AC-05.15 landing, /library and /nope have fixed titles; navigating doc A → doc B retitles the tab', T, async () => {
    const bName = uniq('Doc B')
    const b = await createDoc({ markdown: '# B heading\n\nDoc B body (AC-05.15).\n', filename: 'b.md', sessionName: bName, mode: 'publish' })
    const aName = uniq('Doc A')
    const a = await createDoc({ markdown: `# A heading\n\nDoc A body (AC-05.15). Go to [doc B](/d/${b.slug || b.id}).\n`, filename: 'a.md', sessionName: aName, mode: 'publish' })
    const { context, page } = await open()
    try {
      // rule 19: the static <title> is md-review
      const index = await (await fetch(`${BASE}/`)).text()
      assert.match(index, /<title>md-review<\/title>/, 'index.html <title> is md-review')

      await page.goto(`${BASE}/`)
      await expectTitle(page, 'md-review')
      await page.goto(`${BASE}/library`)
      await page.locator(`${tid('library-page')}, .dashboard`).first().waitFor({ state: 'visible', timeout: 10000 })
      await expectTitle(page, `Library${SUFFIX}`)
      await page.goto(`${BASE}/nope`)
      await page.locator(tid('not-found')).waitFor({ state: 'visible', timeout: 10000 })
      await expectTitle(page, `Not found${SUFFIX}`)

      await openDoc(page, a, 'Doc A body (AC-05.15).')
      await expectTitle(page, `${aName}${SUFFIX}`)
      await page.locator('.preview-pane a', { hasText: 'doc B' }).click()
      await waitForDoc(page, 'Doc B body (AC-05.15).')
      await expectTitle(page, `${bName}${SUFFIX}`)
      await page.goBack()
      await waitForDoc(page, 'Doc A body (AC-05.15).')
      await expectTitle(page, `${aName}${SUFFIX}`)
    } finally { await context.close() }
  })

  it('AC-05.16 editing the H1 of a doc without sessionName/front-matter title retitles the tab within 1 s', T, async () => {
    const doc = await createDoc({ markdown: '# Original heading\n\nEditable body (AC-05.16).\n', filename: 'edit.md', mode: 'publish' })
    const { context, page } = await open()
    try {
      await page.goto(docUrl(doc, '?view=edit'))
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
      await expectTitle(page, `Original heading${SUFFIX}`)
      await page.locator('.cm-line').first().click()
      await page.keyboard.press('End')
      await page.keyboard.type(' v2')
      const t0 = Date.now()
      await page.waitForFunction((w) => document.title === w, `Original heading v2${SUFFIX}`, { timeout: 1250 }).catch(() => {})
      assert.equal(await page.title(), `Original heading v2${SUFFIX}`, `title updated within ~1 s (waited ${Date.now() - t0} ms)`)
    } finally { await context.close() }
  })

  it('AC-05.16 a shared doc with sessionName "Q3 review" is titled by it regardless of its H1', T, async () => {
    const doc = await createDoc({ markdown: '---\ntitle: Front matter loses\n---\n# Heading loses too\n\nQ3 review body (AC-05.16).\n', filename: 'q3r.md', sessionName: 'Q3 review', mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Q3 review body (AC-05.16).')
      await expectTitle(page, `Q3 review${SUFFIX}`)
      const t = page.locator(`${tid('doc-header')} ${tid('doc-title')}`).first()
      assert.equal((await t.innerText()).trim(), 'Q3 review')
    } finally { await context.close() }
  })

  it('rule 18: a remote H1 change (poll) retitles the tab; a pinned revision adds nothing to the title', T, async () => {
    const doc = await createDoc({ markdown: '# Before poll\n\nPolled body (rule 18).\n', filename: 'poll.md', mode: 'publish' })
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Polled body (rule 18).')
      await expectTitle(page, `Before poll${SUFFIX}`)
      // A different author: same-author writes within REVISION_COALESCE_MS fold into one revision.
      await putMarkdown(doc.id, '# After poll\n\nPolled body (rule 18).\n', { author: 'poller' })
      await expectTitle(page, `After poll${SUFFIX}`, 15000)

      const list = await listRevisions(doc.id)
      const old = list.revisions.find((r) => r.hash !== list.current)?.hash
      assert.match(old ?? '', /^[0-9a-f]{32}$/)
      await page.goto(docUrl(doc, `@${old}`))
      await waitForDoc(page, 'Polled body (rule 18).')
      await expectTitle(page, `Before poll${SUFFIX}`)
    } finally { await context.close() }
  })

  it('AC-05.17 (e2e) a 120-char H1 is cut to 80 characters + "…" in document.title', T, async () => {
    const h = 'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40)
    const p = writeLocal('long-title.md', `# ${h}\n\nLong title body (AC-05.17).\n`)
    const { context, page } = await open()
    try {
      await page.goto(fileUrl(p)); await waitForDoc(page, 'Long title body (AC-05.17).')
      await expectTitle(page, `${h.slice(0, 80)}…${SUFFIX}`)
    } finally { await context.close() }
  })
})

// ── AC-05.19 (e2e half): front-matter line offset in the app ────────────────
describe('#5 absolute source lines in the preview (rule 20)', () => {
  it('AC-05.19 after a 4-line front matter the h1 has data-line-start="4" and a comment on line 4 highlights the h1', T, async () => {
    const src = '---\na: 1\nb: 2\n---\n# Title\n\nParagraph on source line six (AC-05.19).\n'
    const doc = await createDoc({ markdown: src, filename: 'fm.md', sessionName: uniq('Front matter offset'), mode: 'review' })
    const res = await fetch(`${API}/paste/${doc.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Anchored to source line 4 (the h1's [start, end) range, as the app records a selection of it).
      body: JSON.stringify({ startLine: 4, endLine: 5, selectedText: 'Title', body: 'Comment on the title line (AC-05.19)', category: 'suggestion', author: 'agent' }),
    })
    assert.equal(res.status, 201)
    const { context, page } = await open()
    try {
      await openDoc(page, doc, 'Paragraph on source line six (AC-05.19).')
      const h1 = page.locator('.preview-pane h1').first()
      assert.equal(await h1.getAttribute('data-line-start'), '4')
      const p = page.locator('.preview-pane p', { hasText: 'Paragraph on source line six' }).first()
      assert.equal(await p.getAttribute('data-line-start'), '6')
      // The comment anchored to line 4 gets the existing .comment-highlight on the h1 — not on the
      // front-matter table (0..4) and not on the paragraph.
      await eventually(async () => {
        const r = await page.evaluate(() => [...document.querySelectorAll('.preview-pane .comment-highlight')]
          .map((e) => e.tagName.toLowerCase() + (e.classList.contains('frontmatter') ? '.frontmatter' : '')))
        assert.deepEqual(r, ['h1'], 'the line-4 comment highlights exactly the h1')
      }, { timeout: 8000 })
    } finally { await context.close() }
  })
})
