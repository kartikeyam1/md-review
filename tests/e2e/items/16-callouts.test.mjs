// #16 Callouts + RAG badges — acceptance tests in the browser
// (docs/build/specs/16-callouts.md AC-16.5 – 16.8, 16.12, 16.14, rules 6–9, 11, 14, 15).
// Parser/markup ACs are unit tests in tests/items/16-callouts.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDoc, uniq } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'
import { openCtx, openDoc, colorsOf, contrast, THEMES, VIEWPORTS, tid, sleep, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/16')
const T = { timeout: 60_000 }
const SLOW = { timeout: 180_000 }

const MARK = 'Callout fixture intro (AC-16).'
const TYPES = ['note', 'tip', 'important', 'warning', 'caution']
const SRC = [
  '# Callouts', '', MARK, '',
  '## Status :rag-green[On track]', '',
  '> [!NOTE]', '> Note body paragraph.', '',
  '> [!TIP]', '> Tip body paragraph.', '',
  '> [!IMPORTANT]', '> Important body paragraph.', '',
  '> [!WARNING] Data **loss** risk', '> Warning body paragraph.', '',
  '> [!CAUTION]', '> Caution body paragraph.', '',
  '## Rich', '',
  '> [!TIP]', '> - list one', '> - list two', '>', '> ```sh', '> ls -la', '> ```', '>', '> | Col | State |', '> |---|---|', '> | Row | :rag-amber[At risk] |', '',
  'Badges: :rag-green[On track] :rag-amber[At risk] :rag-red[Blocked]', '',
  '| Item | Status |', '|---|---|', '| Very long item name for the phone | :rag-green[Healthy and on track] |', '',
  'End of callout fixture.',
].join('\n')
// line numbers of the NOTE blockquote in SRC: '> [!NOTE]' is line 6, it ends before line 8
const NOTE_START = SRC.split('\n').indexOf('> [!NOTE]')

let browser
const docs = {}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.main = await createDoc({ markdown: SRC, filename: 'callouts.md', sessionName: uniq('Callouts'), mode: 'publish' })
  docs.review = await createDoc({ markdown: SRC, filename: 'callouts-review.md', sessionName: uniq('Callouts review'), mode: 'review' })
})
after(async () => { await browser?.close() })

const callout = (page, type, n = 0) => page.locator(`.preview-pane ${tid('callout')}[data-callout="${type}"]`).nth(n)

async function ready(page, doc = docs.main) {
  await openDoc(page, doc, MARK)
  await page.locator(`.preview-pane ${tid('callout')}`).first().waitFor({ state: 'visible' })
}

describe('#16 callouts and RAG badges', () => {
  it('AC-16.5 a callout holds a list, a code block with the #14 copy button, and a table', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const rich = callout(page, 'tip', 1)
      assert.equal(await rich.locator('li').count(), 2)
      assert.equal(await rich.locator(`${tid('code-block')} ${tid('code-copy-btn')}`).count(), 1)
      assert.equal(await rich.locator('table').count(), 1)
      assert.equal(await rich.locator(`td ${tid('rag-badge')}[data-rag="amber"]`).count(), 1)
    } finally { await context.close() }
  })

  it('AC-16.6 wrapper carries the blockquote range; commenting on a body line highlights that body element', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.review)
      const note = callout(page, 'note')
      assert.equal(await note.getAttribute('data-line-start'), String(NOTE_START))
      assert.equal(await note.getAttribute('data-line-end'), String(NOTE_START + 2))
      // A word double-click: a triple-click selection can end at the start of the next block.
      const body = note.locator('p', { hasText: 'Note body paragraph.' })
      await body.locator('text=Note body paragraph.').dblclick({ position: { x: 12, y: 8 } })
      const bar = page.locator('.selection-action-bar .action-btn')
      await bar.waitFor({ state: 'visible', timeout: 4000 })
      await bar.click()
      await page.locator('.popover-input').fill('Callout body comment')
      await page.locator('.popover .btn-primary').click()
      await page.locator('.preview-pane .comment-highlight').first().waitFor({ state: 'attached', timeout: 4000 })
      const hl = await page.evaluate(() => [...document.querySelectorAll('.preview-pane .comment-highlight')].map((e) => e.dataset.testid || e.tagName + ':' + e.textContent.trim().slice(0, 30)))
      assert.deepEqual(hl, ['P:Note body paragraph.'])
    } finally { await context.close() }
  })

  it('AC-16.7 Locus callouts are cards (no stripe, radius >= 8px); Default light has a >= 3px left accent', T, async () => {
    for (const theme of ['locus-light', 'locus-dark', 'light', 'dark']) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        for (const type of TYPES) {
          const s = await callout(page, type).evaluate((el) => {
            const cs = getComputedStyle(el)
            return { l: parseFloat(cs.borderLeftWidth), t: parseFloat(cs.borderTopWidth), r: parseFloat(cs.borderRightWidth), b: parseFloat(cs.borderBottomWidth), radius: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor }
          })
          if (theme.startsWith('locus')) {
            assert.equal(s.l, s.t, `${theme} ${type}: left ${s.l} == top ${s.t}`)
            assert.equal(s.r, s.t, `${theme} ${type}: equal borders`)
            assert.equal(s.b, s.t, `${theme} ${type}: equal borders`)
            assert.ok(s.t >= 1, `${theme} ${type}: has a border`)
            assert.ok(s.radius >= 8, `${theme} ${type}: radius ${s.radius}`)
          } else {
            assert.ok(s.l >= 3, `${theme} ${type}: left accent ${s.l}`)
          }
          assert.notEqual(s.bg, 'rgba(0, 0, 0, 0)', `${theme} ${type}: tinted background`)
        }
      } finally { await context.close() }
    }
  })

  it('AC-16.8 title + body contrast >= 4.5:1 and five distinct title colours, all six themes', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        await sleep(200)
        const titleColours = []
        for (const type of TYPES) {
          const base = `.preview-pane [data-testid="callout"][data-callout="${type}"]`
          const t = await colorsOf(page, `${base} [data-testid="callout-title"]`)
          const b = await colorsOf(page, `${base} > p:not([data-testid="callout-title"])`)
          const icon = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).color, `${base} [data-testid="callout-title"] svg`)
          assert.ok(contrast(t.fg, t.bg) >= 4.5, `${theme} ${type} title ${contrast(t.fg, t.bg).toFixed(2)}`)
          assert.ok(contrast(b.fg, b.bg) >= 4.5, `${theme} ${type} body ${contrast(b.fg, b.bg).toFixed(2)}`)
          titleColours.push(t.fg.map(Math.round).join(','))
          assert.ok(icon, 'icon coloured')
        }
        assert.equal(new Set(titleColours).size, 5, `${theme}: distinct title colours ${titleColours.join(' | ')}`)
        await page.locator('.preview-pane').screenshot({ path: join(SCREENS, `theme-${theme}.png`) })
      } finally { await context.close() }
    }
  })

  it('rule 14: RAG badge text >= 4.5:1 on its pill in all six themes; amber and red differ in lightness', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        const lum = {}
        for (const rag of ['green', 'amber', 'red']) {
          const sel = `.preview-pane p [data-testid="rag-badge"][data-rag="${rag}"]`
          const c = await colorsOf(page, sel)
          assert.ok(contrast(c.fg, c.bg) >= 4.5, `${theme} ${rag}: ${contrast(c.fg, c.bg).toFixed(2)}`)
          const dot = await page.evaluate((s) => getComputedStyle(document.querySelector(`${s} .rag-dot`)).backgroundColor, sel)
          lum[rag] = { bg: c.bg, dot }
        }
        const L = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
        assert.ok(Math.abs(L(lum.amber.bg) - L(lum.red.bg)) > 8, `${theme}: amber vs red pill lightness differ`)
        assert.notEqual(lum.amber.dot, lum.red.dot)
        await page.locator('.preview-pane p', { hasText: 'Badges:' }).screenshot({ path: join(SCREENS, `rag-${theme}.png`) })
      } finally { await context.close() }
    }
  })

  it('AC-16.12 a badge in a table cell at phone width stays one line and is a pill', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await ready(page)
      const b = page.locator(`.preview-pane td ${tid('rag-badge')}[data-rag="green"]`).last()
      await b.scrollIntoViewIfNeeded()
      const s = await b.evaluate((el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6
        return { ws: cs.whiteSpace, radius: parseFloat(cs.borderTopLeftRadius), h: r.height, lineH, rects: el.getClientRects().length }
      })
      assert.equal(s.ws, 'nowrap')
      assert.equal(s.rects, 1, 'one box (not split across lines)')
      assert.ok(s.radius >= s.h / 2 - 0.5, `pill radius ${s.radius} for height ${s.h}`)
      assert.ok(s.h < s.lineH * 1.8, `single line (${s.h}px)`)
      await page.screenshot({ path: join(SCREENS, 'phone-table.png'), fullPage: false })
    } finally { await context.close() }
  })

  it('QA fix: a long (78-char) label never makes a phone page scroll sideways', T, async () => {
    const long = 'Delivery is on track for the quarter and all teams are aligned on the scope ok'
    assert.equal(long.length, 78)
    const doc = await createDoc({ markdown: `# Long\n\n${MARK}\n\nStatus :rag-green[${long}] today.\n`, filename: 'long-rag.md', sessionName: uniq('Long rag'), mode: 'publish' })
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await openDoc(page, doc, MARK)
      const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ws: getComputedStyle(document.querySelector('[data-testid="rag-badge"]')).whiteSpace, title: document.querySelector('[data-testid="rag-badge"]').title }))
      assert.ok(g.sw <= g.cw + 1, `no sideways scroll (${g.sw} > ${g.cw})`)
      assert.equal(g.ws, 'nowrap')
      assert.equal(g.title, long)
    } finally { await context.close() }
  })

  it('QA fix: inline markup in a custom title takes the title colour; Locus warning and caution differ in hue', T, async () => {
    for (const theme of ['light', 'locus-light', 'locus-dark']) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        const c = await page.evaluate(() => {
          const t = document.querySelector('[data-callout="warning"] [data-testid="callout-title"]')
          const w = getComputedStyle(document.querySelector('[data-callout="warning"]')).borderTopColor
          const k = getComputedStyle(document.querySelector('[data-callout="caution"]')).borderTopColor
          return { title: getComputedStyle(t).color, strong: getComputedStyle(t.querySelector('strong')).color, w, k }
        })
        assert.equal(c.strong, c.title, `${theme}: bold word in title colour`)
        if (theme.startsWith('locus')) {
          const hue = (css) => { const [r, g, b] = css.match(/[\d.]+/g).map(Number); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return 0; let h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn); return ((h * 60) + 360) % 360 }
          assert.ok(Math.abs(hue(c.w) - hue(c.k)) >= 25, `${theme}: warning ${c.w} vs caution ${c.k}`)
        }
      } finally { await context.close() }
    }
  })

  it('review fix: printing a dark theme gives dark text on RAG pills and callout titles', T, async () => {
    for (const theme of ['dark', 'locus-dark', 'github-dark']) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        await page.emulateMedia({ media: 'print' })
        const L = (css) => { const [r, g, b] = css.match(/[\d.]+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
        const cols = await page.evaluate(() => ({
          rag: getComputedStyle(document.querySelector('.preview-pane p [data-testid="rag-badge"]')).color,
          title: getComputedStyle(document.querySelector('[data-callout="tip"] [data-testid="callout-title"]')).color,
        }))
        assert.ok(L(cols.rag) < 120, `${theme}: rag text ${cols.rag}`)
        assert.ok(L(cols.title) < 140, `${theme}: title ${cols.title}`)
      } finally { await context.close() }
    }
  })

  it('AC-16.14 role=note, aria-hidden icons, no serious axe violations in callouts', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const roles = await page.locator(`.preview-pane ${tid('callout')}`).evaluateAll((els) => els.map((e) => e.getAttribute('role')))
      assert.ok(roles.length >= 6 && roles.every((r) => r === 'note'))
      const hidden = await page.locator(`.preview-pane ${tid('callout-title')} svg`).evaluateAll((els) => els.every((e) => e.getAttribute('aria-hidden') === 'true'))
      assert.ok(hidden)
      const v = await runAxe(page, { include: '.preview-pane' })
      assert.equal(v.length, 0, formatViolations(v))
    } finally { await context.close() }
  })

  it('rule 15: the TOC shows the visible badge label, the heading id ignores the syntax', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      assert.equal(await page.locator('.preview-pane h2').first().getAttribute('id'), 'status-on-track')
      const texts = await page.locator(tid('toc-link')).allTextContents()
      assert.ok(texts.map((t) => t.trim()).includes('Status On track'), JSON.stringify(texts))
    } finally { await context.close() }
  })

  it('rule 9: print keeps callout borders and titles and avoids splitting short callouts', T, async () => {
    const { context, page } = await openCtx(browser, { theme: 'locus-dark' })
    try {
      await ready(page)
      await page.emulateMedia({ media: 'print' })
      for (const type of TYPES) {
        const s = await callout(page, type).evaluate((el) => {
          const cs = getComputedStyle(el)
          const t = el.querySelector('[data-testid="callout-title"]')
          return { bw: parseFloat(cs.borderTopWidth), bs: cs.borderTopStyle, brk: cs.breakInside, title: getComputedStyle(t).display }
        })
        assert.ok(s.bw >= 1 && s.bs !== 'none', `${type}: printed border`)
        assert.equal(s.brk, 'avoid', `${type}: break-inside`)
        assert.notEqual(s.title, 'none')
      }
      assert.ok((await page.pdf({ format: 'A4' })).length > 1000)
    } finally { await context.close() }
  })
})
