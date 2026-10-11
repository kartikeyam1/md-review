// #29 Slides view — acceptance tests in the browser
// (docs/build/specs/29-slides.md AC-29.1, 29.4–29.19; 00 §1.3, §2.2, §3.4, §3.5, §10.2, §10.3).
// Splitter ACs (29.2, 29.3) are unit tests in tests/items/29-slides.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq, historyLength } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'
import { openCtx, THEMES, VIEWPORTS, tid, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/29')
const T = { timeout: 60_000 }
const SLOW = { timeout: 240_000 }

const DECK = ['# Deck Title', '', 'Intro line for the deck.', '', '## A', '', 'Slide A body [a link](https://example.com).', '',
  '## B', '', 'Slide B body.', '', '## C', '', 'Slide C body.'].join('\n')
const RICH = ['# Rich', '', 'Rich intro.', '',
  '## Code', '', '```js', 'const answer = 42', '```', '',
  '## Diagram', '', '```mermaid', 'graph TD', '  A-->B', '```', '',
  '## Table', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '## Callout', '', '> [!WARNING]', '> Careful now', '',
  '## Notes', '', 'Visible notes slide.', '', '<!-- notes -->', 'Say hi', '<!-- /notes -->', '',
  '## Agent', '', 'Agent slide body.', '', '<!-- agent -->', 'Agent secret evidence.', '<!-- /agent -->',
].join('\n')
const LONG = ['## Long', '', ...Array.from({ length: 60 }, (_, i) => `- bullet line ${i + 1}`), '', '## Short', '', ...Array.from({ length: 5 }, (_, i) => `- short ${i + 1}`)].join('\n')

let browser
const docs = {}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.deck = await createDoc({ markdown: DECK, filename: 'deck.md', sessionName: uniq('Deck'), mode: 'publish' })
  docs.rich = await createDoc({ markdown: RICH, filename: 'rich.md', sessionName: uniq('Rich'), mode: 'publish' })
  docs.long = await createDoc({ markdown: LONG, filename: 'long.md', sessionName: uniq('Long'), mode: 'publish' })
  docs.flat = await createDoc({ markdown: 'Just text without headings.\n\nSecond paragraph.\n', filename: 'flat.md', sessionName: uniq('Flat'), mode: 'publish' })
  docs.html = await createDoc({ markdown: '<!doctype html><html><body><h1>Html deck</h1><p>Html slides body.</p></body></html>', filename: 'p.html', contentType: 'html', sessionName: uniq('Html'), mode: 'publish' })
})
after(async () => { await browser?.close() })

const key = (doc) => doc.slug || doc.id
/** `fn` keeps holding for `ms` (a "nothing changes" check that polls instead of sleeping once). */
async function stays(fn, ms = 400) {
  const end = Date.now() + ms
  do { await fn(); await new Promise((r) => setTimeout(r, 50)) } while (Date.now() < end)
}
const counter = (page) => page.locator(tid('slides-counter')).innerText().then((t) => t.trim())
const urlOf = (page) => new URL(page.url())
const current = (page) => page.locator(`${tid('slides-slide')}[aria-roledescription="slide"]`)

async function openSlides(page, doc, rest = '') {
  await page.goto(`${BASE}/d/${key(doc)}?view=slides${rest}`)
  await page.locator(tid('slides-root')).waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator(tid('slides-counter')).waitFor({ state: 'visible' })
}

describe('#29 slides view', () => {
  it('AC-29.1 four slides, the first a title slide, counter "1 / 4"; header absent; Present enters', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${key(docs.deck)}`)
      await page.locator('.preview-pane', { hasText: 'Intro line for the deck.' }).waitFor()
      const len = await historyLength(page)
      await page.locator(tid('slides-enter-btn')).click()
      await page.locator(tid('slides-root')).waitFor({ state: 'visible' })
      assert.equal(urlOf(page).searchParams.get('view'), 'slides')
      assert.equal(await historyLength(page), len, 'replaceState')
      assert.equal(await page.locator(tid('slides-slide')).count(), 4)
      assert.equal(await page.locator(tid('slides-slide')).first().getAttribute('data-slide-kind'), 'title')
      assert.equal(await page.locator(tid('slides-slide')).nth(1).getAttribute('data-slide-kind'), 'content')
      assert.equal(await counter(page), '1 / 4')
      assert.equal(await page.locator(tid('doc-header')).count(), 0, 'no app header')
      assert.equal(await page.locator('.app').getAttribute('data-view'), 'slides')
      await page.screenshot({ path: join(SCREENS, 'title.png') })
    } finally { await context.close() }
  })

  it('AC-29.4 keys advance, clamp, Home/End, go back; Ctrl+→ does nothing', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck)
      for (const [k, want] of [['ArrowRight', '2 / 4'], ['Space', '3 / 4'], ['PageDown', '4 / 4'], ['ArrowDown', '4 / 4'], ['Enter', '4 / 4']]) {
        await page.keyboard.press(k)
        await eventually(async () => assert.equal(await counter(page), want, k))
      }
      await page.keyboard.press('Home'); await eventually(async () => assert.equal(await counter(page), '1 / 4'))
      await page.keyboard.press('End'); await eventually(async () => assert.equal(await counter(page), '4 / 4'))
      for (const [k, want] of [['ArrowLeft', '3 / 4'], ['PageUp', '2 / 4'], ['Shift+Space', '1 / 4'], ['End', '4 / 4'], ['Backspace', '3 / 4'], ['ArrowUp', '2 / 4']]) {
        await page.keyboard.press(k)
        await eventually(async () => assert.equal(await counter(page), want, k))
      }
      await page.keyboard.press('Control+ArrowRight')
      await stays(async () => assert.equal(await counter(page), '2 / 4'))
      assert.equal(await page.evaluate(() => scrollY), 0, 'no page scroll')
    } finally { await context.close() }
  })

  it('AC-29.5 ?slide=N deep link: replaceState per navigation, reload keeps it, 99 → last, abc → 1', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck)
      const len = await historyLength(page)
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
      await eventually(async () => assert.equal(urlOf(page).searchParams.get('slide'), '3'))
      assert.equal(urlOf(page).searchParams.get('view'), 'slides')
      assert.equal(await historyLength(page), len)
      await page.reload()
      await page.locator(tid('slides-counter')).waitFor()
      assert.equal(await counter(page), '3 / 4')
      await openSlides(page, docs.deck, '&slide=99'); assert.equal(await counter(page), '4 / 4')
      await eventually(async () => assert.equal(urlOf(page).searchParams.get('slide'), '4', 'clamped deep link rewritten'))
      await openSlides(page, docs.deck, '&slide=abc'); assert.equal(await counter(page), '1 / 4')
      await openSlides(page, docs.deck, '&slide=0'); assert.equal(await counter(page), '1 / 4')
    } finally { await context.close() }
  })

  it('AC-29.6 ?view=slides#b opens on B; the fragment is dropped on the first navigation', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck, '#b')
      assert.equal(await counter(page), '3 / 4')
      await page.keyboard.press('ArrowRight')
      await eventually(async () => assert.equal(urlOf(page).hash, ''))
      assert.equal(urlOf(page).searchParams.get('slide'), '4')
    } finally { await context.close() }
  })

  it('AC-29.7 canvas is 16:9, centred and inside the viewport (desktop, phone); rotate hint on a coarse-pointer phone', T, async () => {
    for (const [name, vp, touch] of [['desktop', VIEWPORTS.desktop, false], ['phone', VIEWPORTS.phone, true]]) {
      const { context, page } = await openCtx(browser, { viewport: vp, touch })
      try {
        await openSlides(page, docs.deck)
        const box = await page.locator(tid('slides-canvas')).boundingBox()
        assert.ok(Math.abs(box.width / box.height - 16 / 9) < 0.01 * (16 / 9), `${name} aspect ${box.width}x${box.height}`)
        assert.ok(box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= vp.width + 0.5 && box.y + box.height <= vp.height + 0.5, `${name} fits`)
        assert.ok(Math.abs(box.x + box.width / 2 - vp.width / 2) <= 2, `${name} centred horizontally`)
        if (name === 'phone') {
          assert.ok(Math.abs(box.width - vp.width) <= 2, 'fills the width')
          await page.locator(tid('slides-rotate-hint')).waitFor({ state: 'visible' })
          await page.screenshot({ path: join(SCREENS, 'phone.png') })
        } else {
          assert.equal(await page.locator(tid('slides-rotate-hint')).count(), 0, 'no hint for a fine pointer')
        }
      } finally { await context.close() }
    }
  })

  it('AC-29.8 a 60-bullet slide keeps the canvas size and scrolls; a 5-line slide does not', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.long)
      const before = await page.locator(tid('slides-canvas')).boundingBox()
      const m = await current(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, fs: parseFloat(getComputedStyle(el).fontSize) }))
      assert.ok(m.sh > m.ch, `long slide scrolls (${m.sh} > ${m.ch})`)
      const after = await page.locator(tid('slides-canvas')).boundingBox()
      assert.deepEqual(after, before)
      await page.keyboard.press('ArrowRight')
      await eventually(async () => assert.equal(await counter(page), '2 / 2'))
      const s = await current(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
      assert.ok(s.sh <= s.ch, `short slide fits (${s.sh} <= ${s.ch})`)
    } finally { await context.close() }
  })

  it('AC-29.9 mermaid is an SVG, code has hljs + copy button, table, #16 callout — each when shown', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.rich, '&slide=2')
      await current(page).locator(`${tid('code-block')} [class^="hljs-"]`).first().waitFor({ state: 'attached' })
      assert.equal(await current(page).locator(tid('code-copy-btn')).count(), 1)
      await page.keyboard.press('ArrowRight')
      await current(page).locator('.mermaid svg').waitFor({ state: 'attached', timeout: 15_000 })
      await page.keyboard.press('ArrowRight')
      await eventually(async () => assert.equal(await current(page).locator('table').count(), 1))
      await page.keyboard.press('ArrowRight')
      await eventually(async () => assert.equal(await current(page).locator(`${tid('callout')}[data-callout="warning"]`).count(), 1))
      await page.screenshot({ path: join(SCREENS, 'callout.png') })
    } finally { await context.close() }
  })

  it('AC-29.10 tap at 75% → next, 25% → previous; a link or zoom trigger does not navigate; left swipe advances on a phone', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck)
      const box = await page.locator(tid('slides-canvas')).boundingBox()
      await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5)
      await eventually(async () => assert.equal(await counter(page), '2 / 4'))
      await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5)
      await eventually(async () => assert.equal(await counter(page), '1 / 4'))
      await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5)
      await eventually(async () => assert.equal(await counter(page), '2 / 4'))
      // A link (made inert here so the page stays put): the click is the link's, not a slide step.
      const link = current(page).locator('a', { hasText: 'a link' })
      await link.evaluate((a) => { a.setAttribute('href', 'javascript:void 0') })
      const lb = await link.boundingBox()
      assert.ok(lb.x + lb.width / 2 < box.x + box.width / 2, 'the link sits in the left half (a click there would go back)')
      await link.click()
      await stays(async () => assert.equal(await counter(page), '2 / 4'))
    } finally { await context.close() }
    const r = await openCtx(browser)
    try {
      await openSlides(r.page, docs.rich, '&slide=3')
      const trig = current(r.page).locator(tid('zoom-trigger'))
      await trig.waitFor({ state: 'attached', timeout: 15_000 })
      await trig.click()
      await r.page.locator(tid('zoom-viewer')).waitFor({ state: 'visible' })
      assert.equal(await counter(r.page), '3 / 7')
      await r.page.keyboard.press('ArrowRight')
      await stays(async () => assert.equal(await counter(r.page), '3 / 7', 'keys go to the zoom viewer'))
      await r.page.keyboard.press('Escape')
      await r.page.locator(tid('zoom-viewer')).waitFor({ state: 'detached' })
      assert.equal(urlOf(r.page).searchParams.get('view'), 'slides', 'Esc closed only the zoom viewer')
    } finally { await r.context.close() }
    const p = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await openSlides(p.page, docs.deck)
      const box = await p.page.locator(tid('slides-canvas')).boundingBox()
      const y = box.y + box.height / 2
      const cdp = await p.context.newCDPSession(p.page)
      const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
      await touch('touchStart', box.x + 250)
      for (const x of [220, 190, 160, 130, 150 - 0]) await touch('touchMove', box.x + x)
      await touch('touchEnd', 0)
      await eventually(async () => assert.equal(await counter(p.page), '2 / 4'))
    } finally { await p.context.close() }
  })

  it('AC-29.11 Esc (not fullscreen) leaves slides: no view/slide, read view, the slide heading in view; slides-exit does the same', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck, '&slide=3')
      await page.keyboard.press('Escape')
      await page.locator('.preview-pane', { hasText: 'Slide B body.' }).waitFor()
      const u = urlOf(page)
      assert.equal(u.searchParams.get('view'), null)
      assert.equal(u.searchParams.get('slide'), null)
      assert.equal(u.hash, '#b')
      await eventually(async () => {
        const top = await page.locator('#b').evaluate((el) => el.getBoundingClientRect().top)
        assert.ok(top >= 0 && top < 500, `heading in view (${top})`)
      })
      await openSlides(page, docs.deck, '&slide=2')
      await page.locator(tid('slides-exit')).click()
      await page.locator('.preview-pane', { hasText: 'Slide A body' }).waitFor()
      assert.equal(urlOf(page).searchParams.get('view'), null)
      assert.equal(urlOf(page).hash, '#a')
    } finally { await context.close() }
  })

  it('AC-29.12 F toggles fullscreen on the slides root; Esc in fullscreen stays in slides', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck)
      await page.keyboard.press('f')
      await eventually(async () => assert.equal(await page.evaluate(() => document.fullscreenElement?.dataset.testid), 'slides-root'))
      await page.keyboard.press('f')
      await eventually(async () => assert.equal(await page.evaluate(() => document.fullscreenElement), null))
      await page.locator(tid('slides-fullscreen-btn')).click()
      await eventually(async () => assert.equal(await page.evaluate(() => document.fullscreenElement?.dataset.testid), 'slides-root'))
      // Esc in fullscreen is the browser's: emulate its exit and check slides survive it.
      await page.evaluate(() => document.exitFullscreen())
      await eventually(async () => assert.equal(await page.evaluate(() => document.fullscreenElement), null))
      assert.equal(urlOf(page).searchParams.get('view'), 'slides')
      await page.locator(tid('slides-root')).waitFor({ state: 'visible' })
    } finally { await context.close() }
  })

  it('AC-29.13 notes: "Say hi" off the canvas; N shows it; other slides say "No notes for this slide."; read view shows it; state remembered', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.rich, '&slide=6')
      assert.ok(!(await page.locator(tid('slides-canvas')).innerText()).includes('Say hi'))
      assert.equal(await page.locator(tid('slides-notes')).isVisible().catch(() => false), false, 'hidden by default')
      await page.keyboard.press('n')
      await page.locator(tid('slides-notes')).waitFor({ state: 'visible' })
      assert.match(await page.locator(tid('slides-notes')).innerText(), /Say hi/)
      assert.equal(await page.evaluate(() => localStorage.getItem('md-review-slides-notes')), '1')
      await page.keyboard.press('ArrowLeft')
      await eventually(async () => assert.match(await page.locator(tid('slides-notes')).innerText(), /No notes for this slide\./))
      // Canvas shrinks to make room but stays 16:9.
      const box = await page.locator(tid('slides-canvas')).boundingBox()
      assert.ok(Math.abs(box.width / box.height - 16 / 9) < 0.02)
      await page.reload()
      await page.locator(tid('slides-notes')).waitFor({ state: 'visible' })
      await page.locator(tid('slides-notes-btn')).click()
      await eventually(async () => assert.equal(await page.evaluate(() => localStorage.getItem('md-review-slides-notes')), null))
      await page.goto(`${BASE}/d/${key(docs.rich)}`)
      await page.locator('.preview-pane', { hasText: 'Say hi' }).waitFor()
    } finally { await context.close() }
  })

  it('AC-29.14 an agent-only section appears on no slide and in no notes', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.rich)
      await page.keyboard.press('n')
      for (let i = 0; i < 7; i++) {
        assert.ok(!(await page.locator(tid('slides-root')).innerText()).includes('Agent secret evidence'), `slide ${i + 1}`)
        await page.keyboard.press('ArrowRight')
      }
      const all = await page.locator(tid('slides-root')).evaluate((el) => el.textContent)
      assert.ok(!all.includes('Agent secret evidence'))
    } finally { await context.close() }
  })

  it('AC-29.15 Locus title slide is #280A38 with a white H1; default light uses --bg-surface; every theme screenshot', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await openSlides(page, docs.deck)
        const st = await page.locator(`${tid('slides-slide')}[data-slide-kind="title"]`).first().evaluate((el) => ({
          bg: getComputedStyle(el).backgroundColor,
          h1: getComputedStyle(el.querySelector('h1')).color,
          font: getComputedStyle(el.querySelector('h1')).fontFamily,
          surface: getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim(),
        }))
        if (theme.startsWith('locus')) {
          assert.equal(st.bg, 'rgb(40, 10, 56)', theme)
          assert.equal(st.h1, 'rgb(255, 255, 255)', theme)
          assert.match(st.font, /Montserrat/, theme)
        }
        if (theme === 'light') {
          const want = await page.evaluate((c) => { const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v }, st.surface)
          assert.equal(st.bg, want)
        }
        await page.screenshot({ path: join(SCREENS, `title-${theme}.png`) })
        await page.keyboard.press('ArrowRight')
        await page.screenshot({ path: join(SCREENS, `content-${theme}.png`) })
      } finally { await context.close() }
    }
  })

  it('AC-29.16 print emulation: every slide displayed with break-after: page; counter, progress, notes, header hidden', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck)
      await page.keyboard.press('n')
      await page.emulateMedia({ media: 'print' })
      const r = await page.evaluate(() => {
        const q = (id) => document.querySelector(`[data-testid="${id}"]`)
        const slides = [...document.querySelectorAll('[data-testid="slides-slide"]')]
        return {
          shown: slides.filter((s) => getComputedStyle(s).display !== 'none' && getComputedStyle(s).visibility !== 'hidden').length,
          breaks: slides.map((s) => getComputedStyle(s).breakAfter),
          hidden: ['slides-counter', 'slides-progress', 'slides-notes', 'slides-prev', 'slides-next', 'slides-exit'].map((id) => (q(id) ? getComputedStyle(q(id)).display : 'none')),
          header: document.querySelector('[data-testid="doc-header"]'),
        }
      })
      assert.equal(r.shown, 4)
      // Every slide breaks after itself except the last (a forced break there adds a blank page — DECISIONS #29).
      assert.deepEqual(r.breaks, ['page', 'page', 'page', 'auto'])
      assert.deepEqual(r.hidden, ['none', 'none', 'none', 'none', 'none', 'none'])
      assert.equal(r.header, null)
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
      assert.equal(pages, 4, `pdf pages ${pages}`)
    } finally { await context.close() }
  })

  it('AC-29.17 HTML doc: ?view=slides rewritten away, iframe shows, no Present button', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${key(docs.html)}?view=slides`)
      await page.locator('iframe.html-frame').waitFor({ state: 'visible', timeout: 15_000 })
      await eventually(async () => assert.notEqual(urlOf(page).searchParams.get('view'), 'slides'))
      assert.equal(await page.locator(tid('slides-root')).count(), 0)
      assert.equal(await page.locator(tid('slides-enter-btn')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-29.18 no headings: one slide, "1 / 1", prev and next disabled', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.flat)
      assert.equal(await page.locator(tid('slides-slide')).count(), 1)
      assert.equal(await counter(page), '1 / 1')
      assert.equal(await page.locator(tid('slides-prev')).isDisabled(), true)
      assert.equal(await page.locator(tid('slides-next')).isDisabled(), true)
    } finally { await context.close() }
  })

  it('AC-29.19 axe: no serious violations; the current slide is labelled "Slide 1 of T"; progress has aria values', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.deck)
      assert.equal(await current(page).getAttribute('aria-label'), 'Slide 1 of 4')
      assert.equal(await current(page).getAttribute('role'), 'group')
      assert.equal(await page.locator(tid('slides-progress')).getAttribute('aria-valuenow'), '1')
      assert.equal(await page.locator(tid('slides-progress')).getAttribute('aria-valuemax'), '4')
      const v = (await runAxe(page)).filter((x) => x.impact === 'serious' || x.impact === 'critical')
      assert.equal(v.length, 0, formatViolations(v))
    } finally { await context.close() }
  })

  it('progress width and live updates: a poll that removes the current slide clamps the index', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      const doc = await createDoc({ markdown: '## A\n\na\n\n## B\n\nb\n\n## C\n\nLive c.\n', filename: 'live.md', sessionName: uniq('LiveDeck'), mode: 'publish' })
      await openSlides(page, doc, '&slide=3')
      const w = await page.locator(tid('slides-progress')).evaluate((el) => el.querySelector('*')?.getBoundingClientRect().width ?? el.getBoundingClientRect().width)
      assert.ok(Math.abs(w - VIEWPORTS.desktop.width) <= 2, `progress full at 3/3 (${w})`)
      await putMarkdown(doc.id, '## A\n\na\n\n## B\n\nb\n')
      await eventually(async () => assert.equal(await counter(page), '2 / 2'), { timeout: 20_000 })
      await eventually(async () => assert.equal(urlOf(page).searchParams.get('slide'), '2', 'the deep link follows the clamp'))
    } finally { await context.close() }
  })

  it('review-mode doc in slides shows no comment UI; ?embed=1&view=slides renders read', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      const doc = await createDoc({ markdown: DECK, filename: 'rev.md', sessionName: uniq('RevDeck'), mode: 'review' })
      await openSlides(page, doc)
      assert.equal(await page.locator('.sidebar, [data-testid="comments-toggle"], .approval-banner').count(), 0)
      await page.goto(`${BASE}/d/${key(doc)}?view=slides&embed=1`)
      await page.locator('.preview-pane', { hasText: 'Intro line for the deck.' }).waitFor()
      assert.equal(await page.locator(tid('slides-root')).count(), 0)
    } finally { await context.close() }
  })
})

describe('#29 slides — fix-round regressions', () => {
  it('a diagram fits the slide: no wider than the body, its bottom inside the canvas, no slide scroll', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      const doc = await createDoc({ markdown: '## Diagram\n\n```mermaid\ngraph TD\n  A[Start]-->B[Middle]\n  B-->C[Next]\n  C-->D[End]\n```\n', filename: 'mm.md', sessionName: uniq('Mermaid'), mode: 'publish' })
      await openSlides(page, doc)
      const svg = current(page).locator('.mermaid svg')
      await svg.waitFor({ state: 'attached', timeout: 15_000 })
      await eventually(async () => {
        const r = await current(page).evaluate((el) => {
          const s = el.querySelector('.mermaid svg').getBoundingClientRect(); const c = el.getBoundingClientRect()
          return { bottom: s.bottom, cBottom: c.bottom, sh: el.scrollHeight, ch: el.clientHeight, w: s.width, cw: c.width }
        })
        assert.ok(r.bottom <= r.cBottom + 1, `diagram bottom ${r.bottom} inside canvas ${r.cBottom}`)
        assert.ok(r.sh <= r.ch + 1, `slide does not scroll (${r.sh} > ${r.ch})`)
        assert.ok(r.w < r.cw, 'narrower than the canvas')
      })
      // Printing a deck with a diagram: still one page per slide (mermaid's body-level tooltip stays out).
      await page.emulateMedia({ media: 'print' })
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1)
    } finally { await context.close() }
  })

  it('<details> show open with no working disclosure control', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      const doc = await createDoc({ markdown: '## D\n\n<details><summary>More</summary>\n\nInner body text.\n\n</details>\n', filename: 'det.md', sessionName: uniq('Details'), mode: 'publish' })
      await openSlides(page, doc)
      await eventually(async () => assert.equal(await current(page).locator('details').evaluate((d) => d.open), true))
      await current(page).locator('summary').click({ force: true })
      await stays(async () => assert.equal(await current(page).locator('details').evaluate((d) => d.open), true))
      assert.equal(await current(page).locator('[data-testid="heading-fold-toggle"]').count(), 0)
      assert.ok((await current(page).innerText()).includes('Inner body text.'))
    } finally { await context.close() }
  })

  it('a sideways swipe over a wide table scrolls it and does not change slide', T, async () => {
    const p = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      const cols = Array.from({ length: 20 }, (_, i) => `c${i}`)
      const md = `## Wide\n\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n| ${cols.map((c) => `${c}-value-long`).join(' | ')} |\n\n## Next\n\nn\n`
      const doc = await createDoc({ markdown: md, filename: 'wide.md', sessionName: uniq('Wide'), mode: 'publish' })
      await openSlides(p.page, doc)
      const box = await current(p.page).locator('table').boundingBox()
      const y = box.y + box.height / 2
      const cdp = await p.context.newCDPSession(p.page)
      const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
      await touch('touchStart', 300)
      for (const x of [260, 220, 180, 140]) await touch('touchMove', x)
      await touch('touchEnd', 0)
      await stays(async () => assert.equal(await counter(p.page), '1 / 2'))
    } finally { await p.context.close() }
  })

  it('a landscape phone: the canvas fills the height (the controls float over it)', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: { width: 844, height: 390 }, touch: true })
    try {
      await openSlides(page, docs.deck)
      await eventually(async () => {
        const b = await page.locator(tid('slides-canvas')).boundingBox()
        assert.ok(Math.abs(b.height - 390) <= 2, `canvas height ${b.height}`)
      })
      await page.locator(tid('slides-next')).click()
      await eventually(async () => assert.equal(await counter(page), '2 / 4'))
    } finally { await context.close() }
  })

  it('the zoom viewer opens inside the fullscreen deck', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openSlides(page, docs.rich, '&slide=3')
      const trig = current(page).locator(tid('zoom-trigger'))
      await trig.waitFor({ state: 'attached', timeout: 15_000 })
      await page.keyboard.press('f')
      await eventually(async () => assert.equal(await page.evaluate(() => document.fullscreenElement?.dataset.testid), 'slides-root'))
      await trig.click()
      await page.locator(tid('zoom-viewer')).waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => !!document.fullscreenElement.querySelector('[data-testid="zoom-viewer"]')), true)
      await page.keyboard.press('Escape')
      await page.locator(tid('zoom-viewer')).waitFor({ state: 'detached' })
      await page.evaluate(() => document.exitFullscreen())
    } finally { await context.close() }
  })

  it('leaving slides puts keyboard focus on Present; library → Back re-opens the doc and its deck', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${key(docs.deck)}`)
      await page.locator('.preview-pane', { hasText: 'Intro line for the deck.' }).waitFor()
      await page.locator(tid('nav-library')).click()
      await page.waitForURL(/\/library/)
      await page.goBack()
      await page.locator('.preview-pane', { hasText: 'Intro line for the deck.' }).waitFor()
      assert.deepEqual(page.__errors, [], 'no page errors after library → Back')
      await page.locator(tid('slides-enter-btn')).click()
      await page.locator(tid('slides-root')).waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      await page.locator('.preview-pane', { hasText: 'Intro line for the deck.' }).waitFor()
      await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'slides-enter-btn'))
    } finally { await context.close() }
  })
})
