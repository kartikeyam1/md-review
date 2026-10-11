// #18 Reader font size + content width control — acceptance tests in the browser
// (docs/build/specs/18-font-width-control.md AC-18.1 – 18.14, rules 4–12).
// Pure logic (AC-18.15) is unit-tested in tests/items/18-font-width-control.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, uniq } from '../lib/docs.mjs'
import { asLegacyDoc } from '../lib/legacy-docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'
import { pngDataUri } from './05-lib.mjs'
import { openCtx, openDoc, THEMES, VIEWPORTS, tid, sleep, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/18')
const T = { timeout: 90_000 }
const SLOW = { timeout: 240_000 }
const KEY = 'md-review-reader-prefs'

const MARK = 'Reader settings intro paragraph (AC-18)'
const LONG_URL = 'https://example.com/' + 'a'.repeat(260)
const LONG_CODE = 'const veryLongLine = "' + 'x'.repeat(320) + '"'
const WIDE_TABLE = [
  '| ' + Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`).join(' | ') + ' |',
  '|' + ' --- |'.repeat(12),
  '| ' + Array.from({ length: 12 }, (_, i) => `value-${i + 1}-longish`).join(' | ') + ' |',
].join('\n')
const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1} keeps the reading view long enough to scroll for AC-18.13 checks.`).join('\n\n')

const SRC = [
  '---', 'title: Reader prefs fixture', '---',
  '# Reader settings', '',
  `${MARK} with \`inline code\` and enough words that the line wraps across a wide reading column on every desktop viewport we verify against, which makes the measured paragraph fill its column.`, '',
  '## Second heading', '',
  '### Third heading', '',
  '| Col A | Col B |', '|---|---|', '| cell one | cell two |', '',
  `Long URL: ${LONG_URL}`, '',
  '```js', LONG_CODE, '```', '',
  WIDE_TABLE, '',
  '```mermaid', 'graph LR', '  A[Start] --> B[Middle] --> C[End]', '```', '',
  `![wide image](${pngDataUri(2000, 40)})`, '',
  '- [ ] a task item', '',
  filler, '',
  'End of reader fixture.',
].join('\n')

const HTML_DOC = '<!doctype html><html><head><title>Html doc</title></head><body><h1>HTML doc for AC-18.9</h1><p>Plain html body.</p></body></html>'

let browser
const docs = {}

async function postDoc(payload) {
  const res = await fetch(`${API}/paste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharedAt: new Date().toISOString(), comments: [], ...payload }),
  })
  assert.ok(res.ok, `POST /paste ${res.status}`)
  const { id } = await res.json()
  await asLegacyDoc(id)
  return { id }
}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.main = await createDoc({ markdown: SRC, filename: 'reader.md', sessionName: uniq('Reader prefs'), mode: 'publish' })
  docs.html = await createDoc({ markdown: HTML_DOC, filename: 'page.html', contentType: 'html', sessionName: uniq('Reader html'), mode: 'publish' })
  const lines = SRC.split('\n')
  const fillerLine = lines.findIndex((l) => l.startsWith('Filler paragraph 30 '))
  docs.review = await postDoc({
    markdown: SRC, filename: 'reader-review.md', sessionName: uniq('Reader review'), mode: 'review',
    comments: [{ id: 'c-18-13', startLine: fillerLine, endLine: fillerLine + 1, selectedText: 'Filler paragraph 30', body: 'Comment for AC-18.13', category: 'suggestion', createdAt: Date.now(), replies: [] }],
  })
})
after(async () => { await browser?.close() })

/** Seed localStorage[KEY] once per context (a reload keeps what the app wrote). */
const seedPrefs = (value) => ([k, v]) => {
  if (window.top !== window) return
  try {
    if (!sessionStorage.getItem('__18_seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__18_seeded', '1') }
  } catch { /* storage unavailable */ }
}
async function ctxWithPrefs(opts, raw) {
  const r = await openCtx(browser, opts)
  if (raw !== undefined) await r.context.addInitScript(seedPrefs(), [KEY, raw])
  return r
}

const pane = (page) => page.locator(tid('preview-pane'))
const fs = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  return el ? parseFloat(getComputedStyle(el).fontSize) : NaN
}, sel)
const near = (actual, expected, msg, tol = 0.5) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`)

async function openPanel(page) {
  const panel = page.locator(tid('reader-settings-panel'))
  if (await panel.isVisible().catch(() => false)) return panel
  const btn = page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`)
  // 00 §2.2: in the bar from 641px (a lazy chunk, so wait for it), in the overflow menu on a phone.
  if (page.viewportSize().width >= 641) {
    await btn.click()
  } else {
    await page.locator(tid('header-overflow-btn')).click()
    await page.locator(`${tid('header-overflow-menu')} ${tid('reader-settings-btn')}`).click()
  }
  await panel.waitFor({ state: 'visible' })
  return panel
}
const value = (page) => page.locator(tid('font-size-value')).innerText()
const scaleAttr = (page) => pane(page).getAttribute('data-reader-font-scale')
const widthAttr = (page) => pane(page).getAttribute('data-reader-width')

/** First intro paragraph's box vs the pane's client box and the main pane. */
const geometry = (page) => page.evaluate((mark) => {
  const pn = document.querySelector('[data-testid="preview-pane"]')
  const p = [...pn.querySelectorAll('p')].find((e) => e.textContent.includes(mark))
  const pr = p.getBoundingClientRect()
  const nr = pn.getBoundingClientRect()
  const main = document.querySelector('.main-pane').getBoundingClientRect()
  const clientLeft = nr.left + pn.clientLeft
  return {
    pWidth: pr.width,
    leftGap: pr.left - clientLeft,
    rightGap: clientLeft + pn.clientWidth - pr.right,
    mainLeftGap: pr.left - main.left,
    mainRightGap: main.right - pr.right,
    clientWidth: pn.clientWidth,
    paneFont: parseFloat(getComputedStyle(pn).fontSize),
    scrollWidth: pn.scrollWidth,
  }
}, MARK)

describe('#18 reader font size + width', () => {
  it('AC-18.1 defaults: scale 100, narrow, Default p 15px and h1 24px; rule 7 placement after the Style trigger, no .btn-icon', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      assert.equal(await scaleAttr(page), '100')
      assert.equal(await widthAttr(page), 'narrow')
      near(await fs(page, '.preview-pane > p'), 15, 'p')
      near(await fs(page, '.preview-pane h1'), 24, 'h1')
      near(await fs(page, '.preview-pane h2'), 20, 'h2')
      near(await fs(page, '.preview-pane h3'), 16, 'h3')
      near(await fs(page, '.preview-pane > p code'), 13, 'inline code')
      near(await fs(page, '.preview-pane table:not(.frontmatter)'), 14, 'table')
      const btn = page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`)
      await btn.waitFor({ state: 'visible' })
      assert.equal(await btn.innerText(), 'Aa')
      assert.equal(await btn.getAttribute('aria-label'), 'Reading settings')
      assert.equal(await btn.getAttribute('aria-haspopup'), 'dialog')
      assert.equal(await btn.getAttribute('aria-expanded'), 'false')
      const order = await page.evaluate(() => {
        const style = document.querySelector('[data-testid="theme-style-menu"]')
        const rs = document.querySelector('[data-testid="doc-header"] [data-testid="reader-settings-btn"]')
        return { after: !!(style.compareDocumentPosition(rs) & Node.DOCUMENT_POSITION_FOLLOWING), btnIcon: rs.classList.contains('btn-icon'), firstBtnIcon: document.querySelector('.btn-icon')?.dataset.testid }
      })
      assert.ok(order.after, 'reader-settings-btn comes after theme-style-menu')
      assert.equal(order.btnIcon, false, 'no btn-icon class')
      assert.equal(order.firstBtnIcon, 'theme-toggle')
    } finally { await context.close() }
  })

  it('AC-18.2 A+ six times: 110,120,135,150 then stays 150 (disabled); p 22.5, h1 36, inline code 19.5', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await openPanel(page)
      assert.equal(await value(page), '100%')
      const seen = []
      for (let i = 0; i < 6; i++) {
        if (await page.locator(tid('font-increase')).isEnabled()) await page.locator(tid('font-increase')).click()
        seen.push(await value(page))
      }
      assert.deepEqual(seen, ['110%', '120%', '135%', '150%', '150%', '150%'])
      assert.ok(await page.locator(tid('font-increase')).isDisabled(), 'font-increase disabled at 150')
      assert.ok(await page.locator(tid('reader-settings-panel')).isVisible(), 'panel stays open')
      assert.equal(await scaleAttr(page), '150')
      near(await fs(page, '.preview-pane > p'), 22.5, 'p')
      near(await fs(page, '.preview-pane h1'), 36, 'h1')
      near(await fs(page, '.preview-pane > p code'), 19.5, 'inline code')
      near(await fs(page, '.preview-pane h2'), 30, 'h2')
      near(await fs(page, '.preview-pane table:not(.frontmatter)'), 21, 'table')
      // Line-height stays proportional (unitless 1.7).
      const lh = await page.evaluate(() => { const p = document.querySelector('.preview-pane > p'); const s = getComputedStyle(p); return parseFloat(s.lineHeight) / parseFloat(s.fontSize) })
      near(lh, 1.7, 'line-height ratio', 0.02)
      assert.deepEqual(page.__errors, [])
    } finally { await context.close() }
  })

  it('AC-18.3 A− twice: 80% (disabled), p 12, h1 19.2; Reset returns to 100% and disables itself', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await openPanel(page)
      assert.ok(await page.locator(tid('font-reset')).isDisabled(), 'reset disabled at 100')
      await page.locator(tid('font-decrease')).click()
      assert.equal(await value(page), '90%')
      await page.locator(tid('font-decrease')).click()
      assert.equal(await value(page), '80%')
      assert.ok(await page.locator(tid('font-decrease')).isDisabled())
      near(await fs(page, '.preview-pane > p'), 12, 'p')
      near(await fs(page, '.preview-pane h1'), 19.2, 'h1')
      await page.locator(tid('font-reset')).click()
      assert.equal(await value(page), '100%')
      assert.ok(await page.locator(tid('font-reset')).isDisabled())
      near(await fs(page, '.preview-pane > p'), 15, 'p back')
    } finally { await context.close() }
  })

  it('AC-18.4 desktop narrow: p ≤ 751px wide and centred; Wide fills the pane and swaps aria-pressed', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.desktop })
    try {
      await openDoc(page, docs.main, MARK)
      let g = await geometry(page)
      assert.ok(g.pWidth <= 751, `narrow p width ${g.pWidth}`)
      assert.ok(Math.abs(g.leftGap - g.rightGap) <= 2, `gaps ${g.leftGap} / ${g.rightGap}`)
      assert.ok(Math.abs(g.mainLeftGap - g.mainRightGap) <= 2, `centred in the main pane: ${g.mainLeftGap} / ${g.mainRightGap}`)
      await openPanel(page)
      assert.equal(await page.locator(tid('width-narrow')).getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator(tid('width-wide')).getAttribute('aria-pressed'), 'false')
      await page.locator(tid('width-wide')).click()
      assert.equal(await widthAttr(page), 'wide')
      assert.equal(await page.locator(tid('width-narrow')).getAttribute('aria-pressed'), 'false')
      assert.equal(await page.locator(tid('width-wide')).getAttribute('aria-pressed'), 'true')
      g = await geometry(page)
      const mainW = await page.evaluate(() => document.querySelector('.main-pane').clientWidth)
      assert.ok(g.pWidth >= g.clientWidth - 66, `wide p width ${g.pWidth} vs pane ${g.clientWidth}`)
      assert.ok(g.clientWidth >= mainW - 1, `wide pane fills the main pane: ${g.clientWidth} vs ${mainW}`)
      assert.ok(g.pWidth > 760, 'wider than the narrow cap')
    } finally { await context.close() }
  })

  it('AC-18.5 narrow at 150%: the cap is 1125px (p ≤ min(1126, pane clientWidth − 64))', T, async () => {
    for (const viewport of [VIEWPORTS.desktop, { width: 2000, height: 900 }]) {
      const { context, page } = await ctxWithPrefs({ viewport }, JSON.stringify({ fontScale: 150, width: 'narrow' }))
      try {
        await openDoc(page, docs.main, MARK)
        const g = await geometry(page)
        near(g.paneFont, 22.5, 'pane font')
        assert.ok(g.pWidth <= Math.min(1126, g.clientWidth - 64) + 0.5, `p ${g.pWidth} vs ${g.clientWidth} @${viewport.width}`)
        if (viewport.width === 2000) assert.ok(g.pWidth >= 1120, `cap reached at 2000px: ${g.pWidth}`)
      } finally { await context.close() }
    }
  })

  it('AC-18.6 persisted: 135 + wide survives a reload; corrupt or invalid values fall back to defaults; throwing storage still works', T, async () => {
    {
      const { context, page } = await openCtx(browser)
      try {
        await openDoc(page, docs.main, MARK)
        await openPanel(page)
        for (let i = 0; i < 4; i++) await page.locator(tid('font-increase')).click()
        await page.locator(tid('font-decrease')).click()
        await page.locator(tid('width-wide')).click()
        await page.reload()
        await page.locator('.preview-pane').filter({ hasText: MARK }).waitFor()
        const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY)
        assert.deepEqual(stored, { fontScale: 135, width: 'wide' })
        assert.equal(await scaleAttr(page), '135')
        assert.equal(await widthAttr(page), 'wide')
        near(await fs(page, '.preview-pane > p'), 20.25, 'p at 135')
      } finally { await context.close() }
    }
    for (const raw of ['{"fontScale":999,"width":"huge"}', '{', '5', '[1,2]']) {
      const { context, page } = await ctxWithPrefs({}, raw)
      try {
        await openDoc(page, docs.main, MARK)
        assert.equal(await scaleAttr(page), '100', raw)
        assert.equal(await widthAttr(page), 'narrow', raw)
        await openPanel(page)
        assert.equal(await value(page), '100%')
        assert.deepEqual(page.__errors, [], raw)
      } finally { await context.close() }
    }
    {
      const { context, page } = await openCtx(browser, { storage: 'throw' })
      try {
        await openDoc(page, docs.main, MARK)
        await openPanel(page)
        await page.locator(tid('font-increase')).click()
        await page.locator(tid('width-wide')).click()
        assert.equal(await scaleAttr(page), '110')
        assert.equal(await widthAttr(page), 'wide')
        near(await fs(page, '.preview-pane > p'), 16.5, 'p at 110')
      } finally { await context.close() }
    }
  })

  it('AC-18.7 edit mode: the editor stays 14px at 120%; back in Read the preview shows 120%', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await openPanel(page)
      await page.locator(tid('font-increase')).click()
      await page.locator(tid('font-increase')).click()
      await page.keyboard.press('Escape')
      await page.locator(tid('view-toggle-edit')).click()
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
      near(await fs(page, '.cm-content'), 14, '.cm-content')
      // The control stays available in edit mode (rule 10).
      await openPanel(page)
      assert.equal(await value(page), '120%')
      await page.keyboard.press('Escape')
      await page.locator(tid('view-toggle-read')).click()
      await page.locator('.preview-pane').filter({ hasText: MARK }).waitFor()
      assert.equal(await scaleAttr(page), '120')
      near(await fs(page, '.preview-pane > p'), 18, 'p at 120')
    } finally { await context.close() }
  })

  it('AC-18.8 all 6 themes at 120%: p = base × 1.2 and the narrow 50em cap stays centred; theme switches keep the prefs', SLOW, async () => {
    const BASE_PX = { light: 15, dark: 15, 'locus-light': 15, 'locus-dark': 15, 'github-light': 16, 'github-dark': 16 }
    for (const theme of THEMES) {
      const { context, page } = await ctxWithPrefs({ theme, viewport: { width: 2000, height: 900 } }, JSON.stringify({ fontScale: 120, width: 'narrow' }))
      try {
        await openDoc(page, docs.main, MARK)
        const want = BASE_PX[theme] * 1.2
        near(await fs(page, '.preview-pane > p'), want, `${theme} p`)
        const g = await geometry(page)
        near(g.paneFont, want, `${theme} pane font`)
        assert.ok(g.pWidth <= 50 * g.paneFont + 1, `${theme} cap: ${g.pWidth} vs ${50 * g.paneFont}`)
        assert.ok(g.pWidth >= 50 * g.paneFont - 2, `${theme} cap reached: ${g.pWidth}`)
        assert.ok(Math.abs(g.mainLeftGap - g.mainRightGap) <= 2, `${theme} centred: ${g.mainLeftGap}/${g.mainRightGap}`)
        await page.screenshot({ path: join(SCREENS, `ac18-8-${theme}.png`) })
      } finally { await context.close() }
    }
    // Rule 12 + edge: open the panel, switch theme from the header; the values survive.
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await openPanel(page)
      await page.locator(tid('font-increase')).click()
      await page.locator(tid('width-wide')).click()
      await page.locator(tid('theme-toggle')).click()
      assert.ok(await page.locator(tid('reader-settings-panel')).isVisible(), 'the light/dark toggle restyles the open panel in place')
      assert.equal(await value(page), '110%')
      await page.locator(tid('theme-style-menu')).click()
      await page.locator(`${tid('theme-style-option')}[data-style="github"]`).click()
      assert.equal(await scaleAttr(page), '110')
      assert.equal(await widthAttr(page), 'wide')
      near(await fs(page, '.preview-pane > p'), 17.6, 'github-dark p at 110')
      await openPanel(page)
      assert.equal(await value(page), '110%')
    } finally { await context.close() }
  })

  it('AC-18.9 HTML doc: the five controls are disabled, the note shows, the iframe box equals the main pane', T, async () => {
    const frameBox = (page) => page.evaluate(() => [document.querySelector('iframe.html-frame'), document.querySelector('.main-pane')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) }))
    let baseline
    {
      const { context, page } = await openCtx(browser)
      try {
        await page.goto(`${BASE}/d/${docs.html.slug || docs.html.id}`)
        await page.locator('iframe.html-frame').waitFor({ state: 'visible' })
        baseline = await frameBox(page)
      } finally { await context.close() }
    }
    const { context, page } = await ctxWithPrefs({}, JSON.stringify({ fontScale: 150, width: 'wide' }))
    try {
      await page.goto(`${BASE}/d/${docs.html.slug || docs.html.id}`)
      const frame = page.locator('iframe.html-frame')
      await frame.waitFor({ state: 'visible' })
      await openPanel(page)
      for (const id of ['font-decrease', 'font-increase', 'font-reset', 'width-narrow', 'width-wide']) {
        assert.ok(await page.locator(tid(id)).isDisabled(), `${id} disabled`)
      }
      const note = page.locator(tid('reader-settings-note'))
      assert.ok(await note.isVisible())
      assert.equal((await note.innerText()).trim(), 'Text size and width apply to Markdown documents.')
      const [fb, mb] = await frameBox(page)
      // The iframe spans the main pane's width (under it only #24's reaction bar, if any) and no stored pref moves it.
      assert.deepEqual(fb, baseline[0], 'iframe box unchanged by the stored prefs')
      assert.deepEqual([fb[0], fb[1], fb[2]], [mb[0], mb[1], mb[2]], 'iframe spans the main pane')
      assert.equal(await page.locator('iframe.html-frame').getAttribute('style'), null, 'no style injected on the iframe')
      const stored = await page.evaluate((k) => localStorage.getItem(k), KEY)
      assert.deepEqual(JSON.parse(stored), { fontScale: 150, width: 'wide' }, 'stored prefs untouched')
    } finally { await context.close() }
  })

  it('AC-18.10 keyboard: Tab to the button, Enter opens on font-decrease, Space raises and keeps it open, Esc closes to the button; outside click closes', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`).waitFor({ state: 'visible' })
      await page.locator('body').click({ position: { x: 5, y: 300 } })
      await page.evaluate(() => document.activeElement?.blur())
      let found = false
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        if (await page.evaluate(() => document.activeElement?.dataset?.testid === 'reader-settings-btn')) { found = true; break }
      }
      assert.ok(found, 'reached reader-settings-btn with Tab')
      await page.keyboard.press('Enter')
      await page.locator(tid('reader-settings-panel')).waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'font-decrease')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'font-increase')
      await page.keyboard.press('Space')
      assert.equal(await value(page), '110%')
      await page.keyboard.press('Space')
      assert.equal(await value(page), '120%')
      assert.ok(await page.locator(tid('reader-settings-panel')).isVisible(), 'panel stays open')
      await page.keyboard.press('Escape')
      await page.locator(tid('reader-settings-panel')).waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'reader-settings-btn')
      assert.equal(await page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`).getAttribute('aria-expanded'), 'false')
      // At 80% the first enabled control is font-increase.
      await page.keyboard.press('Enter')
      await page.locator(tid('reader-settings-panel')).waitFor({ state: 'visible' })
      for (let i = 0; i < 4; i++) await page.locator(tid('font-decrease')).click()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Enter')
      await page.locator(tid('reader-settings-panel')).waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'font-increase')
      // Tabbing out of the panel closes it.
      for (let i = 0; i < 8 && await page.locator(tid('reader-settings-panel')).isVisible().catch(() => false); i++) await page.keyboard.press('Tab')
      await page.locator(tid('reader-settings-panel')).waitFor({ state: 'detached' })
      // Esc on the closed button is not swallowed (lower layers still get it).
      await page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`).focus()
      const swallowed = await page.evaluate(() => new Promise((res) => {
        window.addEventListener('keydown', (e) => res(e.defaultPrevented), { once: true })
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      }))
      assert.equal(swallowed, false, 'Esc passes through when the panel is closed')
      // Outside click.
      await openPanel(page)
      await page.mouse.click(20, 500)
      await page.locator(tid('reader-settings-panel')).waitFor({ state: 'detached' })
      assert.equal(await page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`).getAttribute('aria-expanded'), 'false')
    } finally { await context.close() }
  })

  it('AC-18.11 ARIA: dialog named "Reading settings", aria-live value, one aria-pressed; axe clean in light and locus-dark', T, async () => {
    for (const theme of ['light', 'locus-dark']) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await openDoc(page, docs.main, MARK)
        const panel = await openPanel(page)
        assert.equal(await panel.getAttribute('role'), 'dialog')
        assert.equal(await panel.getAttribute('aria-label'), 'Reading settings')
        assert.equal(await page.getByRole('dialog', { name: 'Reading settings' }).count(), 1)
        assert.equal(await page.locator(tid('font-size-value')).getAttribute('aria-live'), 'polite')
        const pressed = await page.evaluate(() => ['width-narrow', 'width-wide'].map((id) => document.querySelector(`[data-testid="${id}"]`).getAttribute('aria-pressed')))
        assert.equal(pressed.filter((v) => v === 'true').length, 1, String(pressed))
        for (const [id, label] of [['font-decrease', 'Decrease text size'], ['font-increase', 'Increase text size'], ['font-reset', 'Reset text size']]) {
          assert.equal(await page.locator(tid(id)).getAttribute('aria-label'), label)
        }
        const v = await runAxe(page, { include: tid('reader-settings-panel'), minImpact: 'minor' })
        assert.equal(v.length, 0, `${theme}: ${formatViolations(v)}`)
        // Visible focus ring (rule 9).
        await page.locator(tid('font-increase')).focus()
        await page.keyboard.press('Shift+Tab')
        const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1 || s.boxShadow !== 'none' })
        assert.ok(ring, `${theme}: focus ring`)
      } finally { await context.close() }
    }
  })

  it('AC-18.12 at 150% in both widths at all three viewports the pane never scrolls sideways', SLOW, async () => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      for (const width of ['narrow', 'wide']) {
        const { context, page } = await ctxWithPrefs({ viewport }, JSON.stringify({ fontScale: 150, width }))
        try {
          await openDoc(page, docs.main, MARK)
          await page.locator('.preview-pane .mermaid svg').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {})
          const r = await page.evaluate(() => {
            const pn = document.querySelector('[data-testid="preview-pane"]')
            const se = document.scrollingElement
            return { sw: pn.scrollWidth, cw: pn.clientWidth, dsw: se.scrollWidth, dcw: se.clientWidth }
          })
          assert.ok(r.sw <= r.cw + 1, `${name}/${width}: pane ${r.sw} > ${r.cw}`)
          assert.ok(r.dsw <= r.dcw + 1, `${name}/${width}: page ${r.dsw} > ${r.dcw}`)
          if (name !== 'desktop') {
            // Narrower than the cap: narrow and wide render identically (rule 5).
            const g = await geometry(page)
            assert.ok(g.pWidth >= g.clientWidth - 2 * 32 - 2, `${name}/${width}: p fills the pane (${g.pWidth} vs ${g.clientWidth})`)
          }
        } finally { await context.close() }
      }
    }
  })

  it('AC-18.13 changing scale/width keeps comment highlights and the reading position (read view and split view)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${docs.review.id}`)
      await page.locator('.preview-pane').filter({ hasText: MARK }).waitFor()
      await page.locator('.preview-pane .comment-highlight').first().waitFor({ state: 'attached' })
      const hl = await page.locator('.preview-pane .comment-highlight').count()
      await page.evaluate(() => window.scrollTo(0, 1200))
      await sleep(150)
      assert.ok(await page.evaluate(() => window.scrollY) > 0)
      await openPanel(page)
      await page.locator(tid('font-increase')).click()
      await page.locator(tid('width-wide')).click()
      await sleep(150)
      assert.ok(await page.evaluate(() => window.scrollY) > 0, 'read view kept a scroll position')
      assert.equal(await page.locator('.preview-pane .comment-highlight').count(), hl, 'highlights kept')
      await page.keyboard.press('Escape')
      // Split view: the preview pane is its own scroller.
      await page.goto(`${BASE}/d/${docs.review.id}?view=split`)
      const previewSel = '[data-pane="preview"] .preview-pane'
      await page.locator(previewSel).filter({ hasText: MARK }).waitFor()
      await page.locator(`${previewSel} .comment-highlight`).first().waitFor({ state: 'attached' })
      // The editor half mounts lazily and split view syncs scrolling: scroll once the layout has settled.
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
      await eventually(async () => {
        await page.evaluate((s) => { document.querySelector(s).scrollTop = 900 }, previewSel)
        await sleep(250)
        assert.ok(await page.evaluate((s) => document.querySelector(s).scrollTop, previewSel) > 0)
      }, { timeout: 8000 })
      await openPanel(page)
      await page.locator(tid('font-increase')).click()
      await page.locator(tid('width-narrow')).click()
      await sleep(300)
      assert.ok(await page.evaluate((s) => document.querySelector(s).scrollTop, previewSel) > 0, 'split preview kept a scroll position')
      assert.ok(await page.locator(`${previewSel} .comment-highlight`).count() >= 1, 'split highlights kept')
    } finally { await context.close() }
  })

  it('AC-18.14 visual: centred narrow column, wide fills the pane, the panel is fully on screen and not clipped (3 viewports)', SLOW, async () => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const { context, page } = await openCtx(browser, { viewport })
      try {
        await openDoc(page, docs.main, MARK)
        await page.screenshot({ path: join(SCREENS, `ac18-14-${name}-narrow.png`) })
        const panel = await openPanel(page)
        const box = await panel.boundingBox()
        assert.ok(box.x >= -0.5 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5, `${name}: panel on screen ${JSON.stringify(box)}`)
        const header = await page.locator(tid('doc-header')).boundingBox()
        // Hangs from the header (like the AppMenus) and extends well below it: never clipped by it.
        assert.ok(box.y >= header.y && box.y + box.height > header.y + header.height + 60, `${name}: panel under the header bar (${JSON.stringify(box)} vs ${JSON.stringify(header)})`)
        // Not clipped: the panel's own controls are the hit targets at their centres.
        for (const id of ['font-decrease', 'font-increase', 'width-narrow', 'width-wide']) {
          const hit = await page.locator(tid(id)).evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && el.contains(top) })
          assert.ok(hit, `${name}: ${id} is hittable`)
        }
        const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor)
        assert.ok(!/rgba\(.*,\s*0\)$/.test(bg) && bg !== 'transparent', `${name}: opaque panel (${bg})`)
        if (name === 'phone') {
          assert.ok(box.width >= viewport.width - 2, `phone: full-width sheet (${box.width})`)
          assert.equal(await page.locator(`${tid('doc-header')} > ${tid('reader-settings-btn')}`).count(), 0, 'phone: not in the bar')
        } else {
          assert.equal(await page.locator(`${tid('doc-header')} ${tid('reader-settings-btn')}`).count(), 1, `${name}: in the bar`)
        }
        await page.screenshot({ path: join(SCREENS, `ac18-14-${name}-panel.png`) })
        await page.locator(tid('width-wide')).click()
        await page.keyboard.press('Escape')
        await page.screenshot({ path: join(SCREENS, `ac18-14-${name}-wide.png`) })
        const g = await geometry(page)
        assert.ok(g.pWidth >= g.clientWidth - 66, `${name}: wide fills the pane`)
      } finally { await context.close() }
    }
  })

  it('#13 focus mode keeps the reader width in split view (rule 4 / #13 flag)', T, async () => {
    const doc = await postDoc({ markdown: SRC, filename: 'focus.md', sessionName: uniq('Reader focus'), mode: 'publish' })
    for (const width of ['narrow', 'wide']) {
      const { context, page } = await ctxWithPrefs({ viewport: { width: 2600, height: 1000 } }, JSON.stringify({ fontScale: 100, width }))
      try {
        await page.goto(`${BASE}/d/${doc.id}?view=split`)
        const previewSel = '[data-pane="preview"] .preview-pane'
        await page.locator(previewSel).filter({ hasText: MARK }).waitFor()
        await page.locator(tid('focus-mode-btn')).click()
        await page.locator('.app[data-focus-mode="true"]').waitFor()
        assert.equal(await page.locator(previewSel).getAttribute('data-reader-width'), width)
        const w = await page.evaluate(([s, mark]) => {
          const pn = document.querySelector(s)
          const p = [...pn.querySelectorAll('p')].find((e) => e.textContent.includes(mark))
          return { p: p.getBoundingClientRect().width, cap: 50 * parseFloat(getComputedStyle(pn).fontSize), cw: pn.clientWidth }
        }, [previewSel, MARK])
        if (width === 'narrow') assert.ok(w.p <= w.cap + 1, `narrow in focus mode: ${w.p} vs ${w.cap}`)
        else assert.ok(w.p > w.cap + 20, `wide in focus mode: ${w.p} vs ${w.cap} (pane ${w.cw})`)
      } finally { await context.close() }
    }
  })

  it('edge: rapid A+/A− never leaves 80–150 or shows an off-list step; prefs carry over to another doc', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await openPanel(page)
      const allowed = new Set(['80%', '90%', '100%', '110%', '120%', '135%', '150%'])
      for (let i = 0; i < 12; i++) {
        const id = i % 3 === 2 ? 'font-decrease' : 'font-increase'
        const b = page.locator(tid(id))
        if (await b.isEnabled()) await b.click({ delay: 0 })
        assert.ok(allowed.has(await value(page)))
      }
      for (let i = 0; i < 10; i++) { const b = page.locator(tid('font-decrease')); if (await b.isEnabled()) await b.click() }
      assert.equal(await value(page), '80%')
      for (let i = 0; i < 3; i++) await page.locator(tid('font-increase')).click()
      assert.equal(await value(page), '110%')
      await page.keyboard.press('Escape')
      const other = await createDoc({ markdown: '# Other doc\n\nSecond document body (AC-18 carry over).', filename: 'other.md', sessionName: uniq('Reader other') })
      await page.goto(`${BASE}/d/${other.slug || other.id}`)
      await page.locator('.preview-pane').filter({ hasText: 'Second document body' }).waitFor()
      assert.equal(await scaleAttr(page), '110')
      near(await fs(page, '.preview-pane > p'), 16.5, 'p carried over')
      await eventually(async () => assert.deepEqual(page.__errors, []))
    } finally { await context.close() }
  })
})
