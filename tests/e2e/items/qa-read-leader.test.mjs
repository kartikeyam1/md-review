// Persona QA "leader" (phone between meetings) — regression tests for the read-lane fixes
// (scratchpad persona-leader.md: M1, M2, M5, m1–m4, m6, m7, c1–c4, c7). Each test failed on 8be2187.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE } from '../helpers.mjs'
import { createDoc, uniq } from '../lib/docs.mjs'
import { openCtx, VIEWPORTS, tid, eventually, contrast } from './14-lib.mjs'

const T = { timeout: 60_000 }
const PHONE_TOUCH = { viewport: VIEWPORTS.phone, touch: true, deviceScaleFactor: 2 }
const TABLET_TOUCH = { viewport: VIEWPORTS.tablet, touch: true }
const LANDSCAPE = { viewport: { width: 844, height: 390 }, touch: true }

const WEEKLY = [
  '---', 'title: Weekly leadership update', 'owner: Kartikeya', '---', '',
  '# Weekly leadership update — Routing & Dispatch (wk 41)', '',
  'Intro paragraph for the weekly.', '',
  '## Metrics', '',
  '| Metric | Owner | This week | Last week | Target | Trend |', '|---|---|---|---|---|---|',
  '| Geocode success rate | Kartikeya Manchanda | 97.1% | 98.4% | 99% | regressing |',
  '| Route compute p95 | Kartikeya Manchanda | 1.2s | 1.4s | 1.5s | improving |', '',
  '## Architecture', '',
  '```mermaid', 'flowchart LR', '  A[Order intake] --> B[Geocoder FR]', '  B --> C[(Address cache)]', '  B -->|fallback| E[Provider v2]',
  '  C --> D[Routing engine]', '  E --> D', '  D --> F[Dispatch board]', '  style E fill:#f8d7da', '```', '',
  'The new provider is on the critical path.', '',
  '## Incidents this week', '', 'None this week.', '',
  '## Next week', '', '- More work.',
].join('\n')

let browser
const docs = {}
before(async () => {
  browser = await chromium.launch({ headless: true })
  docs.weekly = await createDoc({ markdown: WEEKLY, filename: 'weekly.md', sessionName: uniq('Weekly'), mode: 'publish', protected: true })
  docs.review = await createDoc({ markdown: WEEKLY, filename: 'weekly-review.md', sessionName: uniq('Weekly review'), mode: 'review', protected: true })
})
after(async () => { await browser?.close() })

const key = (d) => d.slug || d.id
const open = async (page, d, rest = '') => {
  await page.goto(`${BASE}/d/${key(d)}${rest}`)
  await page.locator('.preview-pane h2').first().waitFor({ timeout: 15_000 })
}
const rectsIntersect = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('qa-read: leader persona', () => {
  it('M1 a tap on a mermaid diagram on a phone opens the zoom viewer', T, async () => {
    const { context, page } = await openCtx(browser, PHONE_TOUCH)
    try {
      await open(page, docs.weekly)
      const trig = page.locator(`.preview-pane ${tid('zoom-trigger')}`).first()
      await trig.waitFor()
      await trig.scrollIntoViewIfNeeded()
      await trig.tap()
      await page.locator(tid('zoom-viewer')).waitFor({ state: 'visible', timeout: 5000 })
    } finally { await context.close() }
  })

  it('M2 mermaid labels in slides fit their boxes (not clipped)', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.desktop, theme: 'locus-light' })
    try {
      await page.goto(`${BASE}/d/${key(docs.weekly)}?view=slides&slide=3`)
      const svg = page.locator('.slide.current .mermaid svg')
      await svg.waitFor({ timeout: 15_000 })
      await eventually(async () => {
        const bad = await page.evaluate(() => [...document.querySelectorAll('.slide.current .mermaid foreignObject')].flatMap((fo) => {
          const label = fo.querySelector('.nodeLabel, .edgeLabel')
          if (!label || !label.textContent.trim()) return []
          const f = fo.getBoundingClientRect()
          const l = label.getBoundingClientRect()
          return l.width > f.width + 1 || l.height > f.height + 1 ? [`${label.textContent} ${Math.round(l.width)}x${Math.round(l.height)} in ${Math.round(f.width)}x${Math.round(f.height)}`] : []
        }))
        assert.deepEqual(bad, [], 'labels overflow their foreignObject')
      }, { timeout: 8000 })
    } finally { await context.close() }
  })

  it('M5 landscape phone slides: the canvas fills the height and no control covers it', T, async () => {
    const { context, page } = await openCtx(browser, LANDSCAPE)
    try {
      await page.goto(`${BASE}/d/${key(docs.weekly)}?view=slides&slide=2`)
      await page.locator(tid('slides-counter')).waitFor()
      await eventually(async () => {
        const canvas = await page.locator(tid('slides-canvas')).boundingBox()
        assert.ok(Math.abs(canvas.height - 390) <= 2, `canvas height ${canvas.height}`)
        for (const id of ['slides-exit', 'slides-prev', 'slides-next', 'slides-notes-btn', 'slides-counter']) {
          const b = await page.locator(tid(id)).boundingBox()
          assert.ok(b && !rectsIntersect(b, canvas), `${id} ${JSON.stringify(b)} overlaps the canvas ${JSON.stringify(canvas)}`)
        }
      })
      await page.locator(tid('slides-next')).tap()
      await eventually(async () => assert.match(await page.locator(tid('slides-counter')).innerText(), /^3 \//))
    } finally { await context.close() }
  })

  it('m1 front matter: no Field/Value table for a viewer in publish mode; kept in review mode and for editors', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await open(page, docs.weekly)
      assert.equal(await page.locator('.preview-pane table.frontmatter').count(), 0, 'viewer, publish')
      assert.equal(await page.locator('.preview-pane h1').count(), 1)
      assert.match(await page.title(), /Weekly/)
      await open(page, docs.review)
      assert.equal(await page.locator('.preview-pane table.frontmatter').count(), 1, 'review mode keeps it (comment anchors)')
    } finally { await context.close() }
    const ed = await openCtx(browser)
    try {
      await open(ed.page, docs.weekly, `?edit=${docs.weekly.editToken}`)
      await ed.page.locator('.preview-pane table.frontmatter').waitFor({ timeout: 5000 })
    } finally { await ed.context.close() }
  })

  it('m2 the rotate hint shows on slide 1 when presenting from the overflow menu on a phone', T, async () => {
    const { context, page } = await openCtx(browser, PHONE_TOUCH)
    try {
      await open(page, docs.weekly)
      await page.locator(tid('header-overflow-btn')).tap()
      await page.locator(tid('slides-enter-btn')).tap()
      await page.locator(tid('slides-counter')).waitFor()
      assert.match(await page.locator(tid('slides-counter')).innerText(), /^1 \//)
      await page.locator(tid('slides-rotate-hint')).waitFor({ state: 'visible', timeout: 5000 })
    } finally { await context.close() }
  })

  it('m3 touch targets are ≥ 44px: tablet header, slide controls, reactions, notice button', T, async () => {
    const { context, page } = await openCtx(browser, TABLET_TOUCH)
    try {
      await open(page, docs.weekly)
      await page.waitForTimeout(300)
      const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="doc-header"] button, [data-testid="doc-header"] a[href], [data-testid="reaction-btn"]')]
        .filter((e) => e.getClientRects().length && !e.closest('[role="menu"]'))
        .map((e) => [e.dataset.testid || e.className, e.getBoundingClientRect()])
        .filter(([, r]) => r.width < 44 - 0.5 || r.height < 44 - 0.5)
        .map(([n, r]) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`))
      assert.deepEqual(small, [])
      // The section-reaction trigger keeps its small chip but answers taps across a 44×44 square around it.
      const miss = await page.evaluate(() => {
        const t = document.querySelector('.preview-pane [data-testid="section-reaction-trigger"]')
        t.scrollIntoView({ block: 'center' })
        const r = t.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        return [[-21, 0], [21, 0], [0, -21], [0, 21]].filter(([dx, dy]) => document.elementFromPoint(cx + dx, cy + dy)?.closest('[data-testid="section-reaction-trigger"]') !== t)
      })
      assert.deepEqual(miss, [], 'section-reaction-trigger answers ±21px around its centre')
    } finally { await context.close() }
    const s = await openCtx(browser, PHONE_TOUCH)
    try {
      await s.page.goto(`${BASE}/d/${key(docs.weekly)}?view=slides`)
      await s.page.locator(tid('slides-counter')).waitFor()
      for (const id of ['slides-exit', 'slides-prev', 'slides-next', 'slides-notes-btn']) {
        const b = await s.page.locator(tid(id)).boundingBox()
        assert.ok(b.width >= 44 - 0.5 && b.height >= 44 - 0.5, `${id} ${b.width}x${b.height}`)
      }
    } finally { await s.context.close() }
  })

  it('m4 a view-link reader has no "Open file…"; an editor does', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await open(page, docs.weekly)
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('header-overflow-menu')).waitFor()
      assert.equal(await page.locator(tid('menu-open-file')).count(), 0)
      await page.keyboard.press('Escape')
      await open(page, docs.weekly, `?edit=${docs.weekly.editToken}`)
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('menu-open-file')).waitFor()
    } finally { await context.close() }
  })

  it('m6 an author-filled node keeps a readable label in Locus dark', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.desktop, theme: 'locus-dark' })
    try {
      await open(page, docs.weekly)
      await page.locator('.preview-pane .mermaid svg .node').first().waitFor({ timeout: 15_000 })
      const r = await eventually(async () => {
        const v = await page.evaluate(() => {
          const node = [...document.querySelectorAll('.preview-pane .mermaid .node')].find((n) => n.textContent.includes('Provider v2'))
          const shape = node.querySelector('[style*="fill"]')
          const label = node.querySelector('.nodeLabel')
          return { fill: getComputedStyle(shape).fill, fg: getComputedStyle(label).color }
        })
        assert.ok(v.fill && v.fg)
        return v
      })
      const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
      const ratio = contrast(rgb(r.fg), rgb(r.fill))
      assert.ok(ratio >= 3, `label ${r.fg} on ${r.fill}: ${ratio.toFixed(2)}:1`)
    } finally { await context.close() }
  })

  it('m7 a wide table shows which side has more columns', T, async () => {
    const { context, page } = await openCtx(browser, PHONE_TOUCH)
    try {
      await open(page, docs.weekly)
      const box = page.locator('.preview-pane .table-scroll').first()
      await eventually(async () => assert.equal(await box.getAttribute('data-overflow'), 'r'))
      assert.notEqual(await box.evaluate((e) => getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage), 'none')
      await box.evaluate((e) => { e.scrollLeft = e.scrollWidth })
      await eventually(async () => assert.equal(await box.getAttribute('data-overflow'), 'l'))
    } finally { await context.close() }
  })

  it('c1/c7 heading controls do not wrap onto a line of their own; collapse-all leaves no gap', T, async () => {
    const { context, page } = await openCtx(browser, { ...PHONE_TOUCH, theme: 'locus-light' })
    try {
      await open(page, docs.weekly)
      await page.locator(`.preview-pane h2 ${tid('heading-anchor')}`).first().waitFor()
      const h = page.locator('.preview-pane h2', { hasText: 'Incidents this week' })
      const r = await h.evaluate((el) => {
        const lh = parseFloat(getComputedStyle(el).lineHeight)
        const a = el.querySelector('[data-testid="heading-anchor"]').getBoundingClientRect()
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
        const text = document.createRange(); text.selectNodeContents(w.nextNode())
        const t = text.getBoundingClientRect()
        return { lines: Math.round(el.getBoundingClientRect().height / lh), anchorMid: a.top + a.height / 2, textTop: t.top, textBottom: t.bottom }
      })
      assert.equal(r.lines, 1, 'a short h2 stays on one line with its controls')
      assert.ok(r.anchorMid >= r.textTop && r.anchorMid <= r.textBottom, `anchor on the text line ${JSON.stringify(r)}`)
    } finally { await context.close() }
  })

  it('c2 a wrapped H1 with a fold toggle has no hanging indent', T, async () => {
    const { context, page } = await openCtx(browser, PHONE_TOUCH)
    try {
      await open(page, docs.weekly)
      await page.locator(`.preview-pane h1 ${tid('heading-fold-toggle')}`).waitFor()
      const lefts = await page.evaluate(() => {
        const h = document.querySelector('.preview-pane h1')
        const w = document.createTreeWalker(h, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
        const t = w.nextNode()
        const r = document.createRange(); r.selectNodeContents(t)
        return [...r.getClientRects()].map((x) => Math.round(x.left))
      })
      assert.ok(lefts.length >= 2, `the H1 wraps (${lefts})`)
      assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, `every line starts at the same x: ${lefts}`)
    } finally { await context.close() }
  })

  it('c3 the TOC drawer labels Collapse / Expand', T, async () => {
    const { context, page } = await openCtx(browser, PHONE_TOUCH)
    try {
      await open(page, docs.weekly)
      await page.locator(tid('toc-toggle')).tap()
      await page.locator(tid('toc-drawer')).waitFor()
      assert.equal((await page.locator(`${tid('toc-drawer')} ${tid('fold-collapse-all')}`).innerText()).trim(), 'Collapse')
      assert.equal((await page.locator(`${tid('toc-drawer')} ${tid('fold-expand-all')}`).innerText()).trim(), 'Expand')
      assert.equal(await page.locator(`${tid('toc-drawer')} ${tid('fold-collapse-all')}`).getAttribute('aria-label'), 'Collapse all sections')
    } finally { await context.close() }
  })

  it('c4 the unseen-changes dot and an open menu trigger use theme colours, no browser tap flash', T, async () => {
    const { context, page } = await openCtx(browser, { ...PHONE_TOUCH, theme: 'locus-light' })
    try {
      await open(page, docs.weekly)
      const btn = page.locator(tid('header-overflow-btn'))
      assert.equal(await btn.evaluate((e) => getComputedStyle(e).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)')
      await btn.tap()
      await page.locator(tid('header-overflow-menu')).waitFor()
      const border = await btn.evaluate((e) => getComputedStyle(e).borderTopColor)
      assert.equal(border, 'rgb(176, 102, 255)', 'open trigger outlined in the Locus accent')
    } finally { await context.close() }
  })
})
