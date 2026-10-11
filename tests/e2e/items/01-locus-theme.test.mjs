// #1 Locus brand theme + theme switcher — frozen acceptance tests
// (docs/build/specs/01-locus-theme.md, 00-cross-cutting §2.1/§2.2/§3.2/§10).
//
// Docs are opened as shared sessions through the legacy `/#shared=<id>` entry,
// which works before and after #4 (#4 rewrites it to `/d/<id>`), and are read
// in the read view's `.preview-pane`. Themes are seeded through
// localStorage['md-review-theme'] (rule 4) unless the AC is about the UI.
//
// The last test writes screenshots for the visual verifier to
// .verify/screens/01/<target>/<theme>-<viewport>.png (+ index.json).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from '../helpers.mjs'
import { createDoc, uniq, waitForDoc } from '../lib/docs.mjs'
import { expectComputedStyle, getComputedStyles } from '../lib/brand.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const FIXTURE = readFileSync(join(HERE, '../fixture.md'), 'utf-8')
const SCREENS = join(ROOT, '.verify/screens/01')

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }
const SLOW = { timeout: 240_000 }

const KEY = 'md-review-theme'
const THEMES = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']
const STYLE = { 'light': 'default', 'dark': 'default', 'github-light': 'github', 'github-dark': 'github', 'locus-light': 'locus', 'locus-dark': 'locus' }
const DARK = { 'light': false, 'dark': true, 'github-light': false, 'github-dark': true, 'locus-light': false, 'locus-dark': true }
const LABEL = { default: 'Default', github: 'GitHub', locus: 'Locus' }
const VIEWPORTS = {
  desktop: { width: 1400, height: 900 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
}
const DESKTOP = VIEWPORTS.desktop
const SERIES = ['#B066FF', '#3264FF', '#14B4EF', '#00D273', '#FF9F00', '#FF6429']

// Rule 9 tokens and the rule 10/11 colours they feed.
const LOCUS = {
  'locus-light': {
    bgPage: '#F3F0EB', bgSurface: '#FFFFFF', bgCode: '#F3F0EB', textPrimary: '#280A38', textSecondary: '#533B60',
    textMuted: '#9B8FA8', accent: '#B066FF', border: '#E6E1DA', thBg: '#F3F0EB', thText: '#280A38', keyword: '#280A38',
    node: '#F3F0EB', line: '#533B60', nodeText: '#280A38',
  },
  'locus-dark': {
    bgPage: '#280A38', bgSurface: '#280A38', bgCode: 'rgba(255, 255, 255, 0.06)', textPrimary: '#FFFFFF', textSecondary: '#FFFFFF',
    textMuted: '#9B8FA8', accent: '#B066FF', border: '#533B60', thBg: '#533B60', thText: '#FFFFFF', keyword: '#B066FF',
    node: '#533B60', line: '#E6E1DA', nodeText: '#FFFFFF',
  },
}
const MONTSERRAT = /^["']?Montserrat["']?(\s*,|$)/
const JETBRAINS = /^["']?JetBrains Mono["']?(\s*,|$)/
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

// The e2e fixture plus what it lacks for rule 11/12: a link, a blockquote, a
// highlighted JS block, a 6-slice pie (strictly descending, source order) and
// an xy chart.
const DOC_MARK = 'This is a paragraph for testing inline comments.'
const LINK_HREF = 'https://example.com/brand'
const LOCUS_DOC = `${FIXTURE.trimEnd()}

## Locus probes

Read the [brand guide](${LINK_HREF}) before styling anything.

> A quoted note that should read as a cream card, not a striped quote.

\`\`\`js
// a comment line
const answer = 42
const label = "forty-two"
\`\`\`

\`\`\`mermaid
pie title Series
    "One" : 60
    "Two" : 50
    "Three" : 40
    "Four" : 30
    "Five" : 20
    "Six" : 10
\`\`\`

\`\`\`mermaid
xychart-beta
    x-axis [a, b, c]
    bar [3, 2, 1]
    line [1, 2, 3]
\`\`\`
`

const HTML_MARK = 'HTML bridge doc'
const HTML_DOC = `<!doctype html>
<html><head><meta charset="utf-8"><title>Brand bridge</title>
<style>body { font-family: Georgia, serif; } h1 { font-size: 28px; }</style>
</head>
<body>
<h1 id="hb">${HTML_MARK}</h1>
<p>Plain body text; the app must not restyle it.</p>
</body></html>`
const HTML_SOURCE_COUNTS = { style: 1, link: 0 }
const HTML_NOBODY = '<h1 id="nb">No body tag here</h1><p>Fragment document.</p>'

let browser
const docs = {}
before(async () => {
  browser = await chromium.launch({ headless: true })
  docs.md = await createDoc({ markdown: LOCUS_DOC, filename: 'locus-fixture.md', sessionName: uniq('Locus fixture'), mode: 'publish' })
  docs.html = await createDoc({ markdown: HTML_DOC, filename: 'bridge.html', contentType: 'html', sessionName: uniq('Bridge'), mode: 'publish' })
  docs.nobody = await createDoc({ markdown: HTML_NOBODY, filename: 'nobody.html', contentType: 'html', sessionName: uniq('No body'), mode: 'publish' })
})
after(async () => { await browser?.close() })

const docUrl = (doc) => `${BASE}/#shared=${doc.id}`

// ── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Retry an assertion until it passes (100 ms polls) or the timeout ends. */
async function eventually(fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    try { return await fn() } catch (e) {
      if (Date.now() > end) throw e
    }
    await sleep(interval)
  }
}

/**
 * Fresh context. `theme` seeds localStorage once per tab (a reload keeps what
 * the app stored since). `storage: 'throws'` makes every localStorage call throw.
 */
async function open({ theme, colorScheme = 'light', viewport = DESKTOP, storage = 'ok', url, waitText = DOC_MARK, firstPaint = false, requests } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' })
  if (requests) context.on('request', (r) => requests.push(r.url()))
  if (theme) {
    await context.addInitScript(([k, v]) => {
      if (window.top !== window) return
      try {
        if (!sessionStorage.getItem('__t01_seeded')) {
          localStorage.setItem(k, v)
          sessionStorage.setItem('__t01_seeded', '1')
        }
      } catch { /* storage unavailable */ }
    }, [KEY, theme])
  }
  if (storage === 'throws') {
    await context.addInitScript(() => {
      if (window.top !== window) return
      let ls
      try { ls = window.localStorage } catch { return }
      for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
        const orig = Storage.prototype[name]
        Storage.prototype[name] = function (...args) {
          if (this === ls) throw new DOMException('The operation is insecure.', 'SecurityError')
          return orig.apply(this, args)
        }
      }
    })
  }
  if (firstPaint) {
    // Records the <html> theme state the first time the doc text exists in the
    // DOM. MutationObserver callbacks run before the next paint.
    await context.addInitScript((marker) => {
      if (window.top !== window) return
      const rec = { first: null }
      Object.defineProperty(window, '__t01', { value: rec, configurable: true })
      const check = () => {
        if (rec.first) return true
        if (document.body && document.body.textContent.includes(marker)) {
          const h = document.documentElement
          rec.first = {
            dark: h.classList.contains('dark'),
            github: h.classList.contains('github-theme'),
            locus: h.classList.contains('locus-theme'),
            style: h.getAttribute('data-theme-style'),
          }
          return true
        }
        return false
      }
      new MutationObserver((_, obs) => { if (check()) obs.disconnect() })
        .observe(document, { childList: true, subtree: true, characterData: true })
    }, DOC_MARK)
  }
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  await page.goto(url ?? docUrl(docs.md))
  if (waitText) await waitForDoc(page, waitText)
  return { context, page, errors }
}

const want = (t) => ({ dark: DARK[t], github: STYLE[t] === 'github', locus: STYLE[t] === 'locus', style: STYLE[t] })
const htmlState = (page) => page.evaluate(() => {
  const h = document.documentElement
  return {
    dark: h.classList.contains('dark'),
    github: h.classList.contains('github-theme'),
    locus: h.classList.contains('locus-theme'),
    style: h.getAttribute('data-theme-style'),
  }
})
async function expectTheme(page, t, msg = '') {
  await eventually(async () => assert.deepEqual(await htmlState(page), want(t), `<html> theme state should be ${t} ${msg}`), { timeout: 4000 })
}
const stored = (page) => page.evaluate((k) => { try { return localStorage.getItem(k) } catch { return '<threw>' } }, KEY)

const toggle = (page) => page.locator('[data-testid="theme-toggle"]')
const trigger = (page) => page.locator('[data-testid="theme-style-menu"]')
const menu = (page) => page.locator('[data-testid="theme-style-menu-list"]')
const options = (page) => page.locator('[data-testid="theme-style-menu-list"] [data-testid="theme-style-option"]')
const option = (page, style) => page.locator(`[data-testid="theme-style-menu-list"] [data-testid="theme-style-option"][data-style="${style}"]`)

async function openMenu(page) {
  await trigger(page).click()
  await menu(page).waitFor({ state: 'visible', timeout: 3000 })
}
async function chooseStyle(page, style) {
  await openMenu(page)
  await option(page, style).click()
  await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
}
/** Reach theme `t` through the UI: Style menu, then the toggle if the dark flag differs. */
async function setThemeViaUi(page, t) {
  await chooseStyle(page, STYLE[t])
  if ((await htmlState(page)).dark !== DARK[t]) await toggle(page).click()
  await expectTheme(page, t, '(set via UI)')
}

/** Focused element summary. */
const active = (page) => page.evaluate(() => {
  const a = document.activeElement
  return a ? { testid: a.getAttribute('data-testid'), style: a.getAttribute('data-style'), tabindex: a.getAttribute('tabindex') } : null
})
async function expectFocusOnOption(page, style, msg) {
  const a = await active(page)
  assert.equal(a?.testid, 'theme-style-option', `${msg}: focus should be on a style option, got ${JSON.stringify(a)}`)
  assert.equal(a.style, style, `${msg}: focused option`)
  // Roving tabindex: focused item 0, the others -1.
  const tabs = await options(page).evaluateAll((els) => els.map((e) => [e.getAttribute('data-style'), e.getAttribute('tabindex')]))
  for (const [s, ti] of tabs) assert.equal(ti, s === style ? '0' : '-1', `${msg}: roving tabindex on ${s}`)
}
async function expectFocusOnTrigger(page, msg) {
  assert.equal((await active(page))?.testid, 'theme-style-menu', `${msg}: focus should return to the Style trigger`)
}

const mermaidNth = (page, i) => page.locator('.preview-pane .mermaid').nth(i)
async function waitMermaid(page) {
  for (let i = 0; i < 3; i++) {
    const m = mermaidNth(page, i)
    await m.scrollIntoViewIfNeeded()
    await m.locator('svg').first().waitFor({ state: 'attached', timeout: 15000 })
  }
}
const svgCounts = (page) => page.$$eval('.preview-pane .mermaid', (ns) => ns.map((n) => n.querySelectorAll('svg').length))

const isRingVisible = (loc) => loc.evaluate((el) => {
  const cs = getComputedStyle(el)
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1
  const shadow = cs.boxShadow && cs.boxShadow !== 'none'
  return { ok: !!(outline || shadow), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, shadow: cs.boxShadow }
})

async function headerLocator(page) {
  const h = page.locator('[data-testid="doc-header"]')
  return (await h.count()) ? h.first() : page.locator('header').first()
}

/** Appends `.btn .btn-primary` / `.btn .btn-ghost` probes so the global button rules are checked even when none is on screen. */
async function addButtonProbes(page) {
  await page.evaluate(() => {
    for (const kind of ['primary', 'ghost']) {
      const b = document.createElement('button')
      b.className = `btn btn-${kind}`
      b.id = `t01-probe-${kind}`
      b.textContent = `Probe ${kind}`
      b.style.position = 'fixed'
      b.style.left = '8px'
      b.style.bottom = kind === 'primary' ? '8px' : '48px'
      b.style.zIndex = '9999'
      document.body.appendChild(b)
    }
  })
}

// ── AC-01.1 – 01.4: state, switching, persistence ───────────────────────────

describe('#1 theme state, switching and persistence', () => {
  it('AC-01.1 a fresh browser (OS light) loads Default light: no dark / github-theme / locus-theme, data-theme-style="default"', T, async () => {
    const { context, page } = await open()
    try {
      await expectTheme(page, 'light')
    } finally { await context.close() }
  })

  it('AC-01.2 theme-toggle twice from Default light: dark, then back to light — never cycles into GitHub', T, async () => {
    const { context, page } = await open()
    try {
      await expectTheme(page, 'light')
      await toggle(page).click()
      await expectTheme(page, 'dark', 'after toggle click 1')
      await toggle(page).click()
      await expectTheme(page, 'light', 'after toggle click 2')
    } finally { await context.close() }
  })

  it('AC-01.3 Style menu → Locus / GitHub keeps the dark flag; toggle flips it within the style; choice is stored', T, async () => {
    const { context, page } = await open()
    try {
      await chooseStyle(page, 'locus')
      await expectTheme(page, 'locus-light', 'after choosing Locus from light')
      assert.equal(await stored(page), 'locus-light')

      await toggle(page).click()
      await expectTheme(page, 'locus-dark', 'after toggling in Locus')
      assert.equal(await stored(page), 'locus-dark')

      await chooseStyle(page, 'github')
      await expectTheme(page, 'github-dark', 'choosing GitHub from locus-dark keeps dark')
      assert.equal(await stored(page), 'github-dark')

      await toggle(page).click()
      await expectTheme(page, 'github-light', 'after toggling in GitHub')
      assert.equal(await stored(page), 'github-light')

      await chooseStyle(page, 'locus')
      await expectTheme(page, 'locus-light', 'choosing Locus from github-light keeps light')

      await chooseStyle(page, 'default')
      await expectTheme(page, 'light', 'choosing Default from locus-light')
      assert.equal(await stored(page), 'light')

      await toggle(page).click()
      await chooseStyle(page, 'locus')
      await expectTheme(page, 'locus-dark', 'choosing Locus from Default dark keeps dark')
      assert.equal(await stored(page), 'locus-dark')
    } finally { await context.close() }
  })

  for (const t of THEMES) {
    it(`AC-01.4 stored "${t}" is applied before the doc first renders, on load and on reload`, T, async () => {
      const { context, page } = await open({ theme: t, firstPaint: true, colorScheme: DARK[t] ? 'light' : 'dark' })
      try {
        assert.deepEqual(await page.evaluate(() => window.__t01?.first), want(t), 'theme state when the doc text first appeared')
        await expectTheme(page, t)
        await page.reload()
        await waitForDoc(page, DOC_MARK)
        assert.deepEqual(await page.evaluate(() => window.__t01?.first), want(t), 'theme state at first render after reload')
        assert.equal(await stored(page), t, 'stored value kept')
      } finally { await context.close() }
    })
  }

  for (const scheme of ['light', 'dark']) {
    it(`AC-01.4 stored "bogus" falls back to the Default style by OS preference (${scheme})`, T, async () => {
      const { context, page } = await open({ theme: 'bogus', colorScheme: scheme, firstPaint: true })
      try {
        const t = scheme === 'dark' ? 'dark' : 'light'
        assert.deepEqual(await page.evaluate(() => window.__t01?.first), want(t), 'theme state at first render')
        await expectTheme(page, t)
      } finally { await context.close() }
    })
  }

  it('AC-01.4 localStorage that throws on get/set: the app renders, themes by OS preference, and switching still works', T, async () => {
    const { context, page, errors } = await open({ storage: 'throws', colorScheme: 'light' })
    try {
      assert.equal(await stored(page), '<threw>', 'harness: localStorage really throws')
      await expectTheme(page, 'light', `(page errors: ${JSON.stringify(errors)})`)
      await toggle(page).click()
      await expectTheme(page, 'dark', 'toggle works without storage')
      await chooseStyle(page, 'locus')
      await expectTheme(page, 'locus-dark', 'Style menu works without storage')
      await toggle(page).click()
      await expectTheme(page, 'locus-light')
    } finally { await context.close() }
  })
})

// ── AC-01.5 – 01.7, rules 8–11: Locus computed styles ───────────────────────

describe('#1 Locus look — computed styles', () => {
  it('AC-01.5 locus-light: page, surface, headings, body text, link, table header, code font, blockquote', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      await expectTheme(page, 'locus-light')
      await expectComputedStyle(page, 'body', { backgroundColor: 'rgb(243, 240, 235)' })
      await expectComputedStyle(page, '.preview-pane', { backgroundColor: 'rgb(255, 255, 255)' })
      await expectComputedStyle(page, '.preview-pane h1', {
        color: 'rgb(40, 10, 56)', fontWeight: '600', fontSize: '30px', borderBottomWidth: '0px', fontFamily: MONTSERRAT,
      })
      await expectComputedStyle(page, '.preview-pane h2', { color: 'rgb(40, 10, 56)' })
      await expectComputedStyle(page, '.preview-pane h3', { color: 'rgb(176, 102, 255)' })
      await expectComputedStyle(page, '.preview-pane p', { color: 'rgb(83, 59, 96)', fontSize: '15px', lineHeight: '22.5px' })
      await expectComputedStyle(page, `.preview-pane a[href="${LINK_HREF}"]`, { color: 'rgb(176, 102, 255)' })
      await expectComputedStyle(page, '.preview-pane th', { backgroundColor: 'rgb(243, 240, 235)', color: 'rgb(40, 10, 56)' })
      await expectComputedStyle(page, '.preview-pane pre code', { fontFamily: JETBRAINS })
      await expectComputedStyle(page, '.preview-pane blockquote', { borderLeftWidth: '0px' })
    } finally { await context.close() }
  })

  it('AC-01.6 locus-dark: deep purple page and surface, white text, purple h3, purple-grey table header, tinted code', T, async () => {
    const { context, page } = await open({ theme: 'locus-dark', colorScheme: 'dark' })
    try {
      await expectTheme(page, 'locus-dark')
      await expectComputedStyle(page, 'body', { backgroundColor: 'rgb(40, 10, 56)' })
      await expectComputedStyle(page, '.preview-pane', { backgroundColor: 'rgb(40, 10, 56)' })
      await expectComputedStyle(page, '.preview-pane h1', { color: 'rgb(255, 255, 255)' })
      await expectComputedStyle(page, '.preview-pane h2', { color: 'rgb(255, 255, 255)' })
      await expectComputedStyle(page, '.preview-pane p', { color: 'rgb(255, 255, 255)' })
      await expectComputedStyle(page, '.preview-pane h3', { color: 'rgb(176, 102, 255)' })
      await expectComputedStyle(page, '.preview-pane th', { backgroundColor: 'rgb(83, 59, 96)', color: 'rgb(255, 255, 255)' })
      await expectComputedStyle(page, '.preview-pane pre', { backgroundColor: 'rgba(255, 255, 255, 0.06)' })
    } finally { await context.close() }
  })

  for (const t of ['locus-light', 'locus-dark']) {
    const c = LOCUS[t]

    it(`rule 9 ${t}: tokens on <html> and body`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await expectComputedStyle(page, 'html', {
          '--bg-page': c.bgPage, '--bg-surface': c.bgSurface, '--bg-code': c.bgCode,
          '--text-primary': c.textPrimary, '--text-secondary': c.textSecondary, '--text-muted': c.textMuted,
          '--accent': c.accent, '--border': c.border,
          '--font-heading': MONTSERRAT, '--font-body': MONTSERRAT,
          '--comment-bg': 'rgba(176, 102, 255, 0.10)', '--selection-bg': 'rgba(176, 102, 255, 0.22)',
        })
        await expectComputedStyle(page, 'body', { backgroundColor: c.bgPage, fontFamily: MONTSERRAT })
      } finally { await context.close() }
    })

    it(`rule 11 ${t}: heading scale — sizes, weight 600, colours, no bottom border or left bar`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        const spec = {
          h1: ['30px', c.textPrimary], h2: ['22px', c.textPrimary], h3: ['16px', '#B066FF'],
          h4: ['15px', '#B066FF'], h5: ['14px', '#B066FF'], h6: ['13px', '#B066FF'],
        }
        for (const [tag, [size, color]] of Object.entries(spec)) {
          // Every heading of the level shares the colour (check first and last).
          const all = page.locator(`.preview-pane ${tag}`)
          const n = await all.count()
          assert.ok(n > 0, `fixture has a ${tag}`)
          for (const loc of new Set([all.first(), all.nth(n - 1)])) {
            await expectComputedStyle(page, loc, {
              fontFamily: MONTSERRAT, fontWeight: '600', fontSize: size, color,
              borderBottomWidth: '0px', borderLeftWidth: '0px', textDecorationLine: 'none',
            })
          }
        }
      } finally { await context.close() }
    })

    it(`rule 11 ${t}: paragraphs and list items — Montserrat 400, 15px / 22.5px, --text-secondary`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        for (const sel of ['.preview-pane p', '.preview-pane li']) {
          await expectComputedStyle(page, sel, {
            fontFamily: MONTSERRAT, fontWeight: '400', fontSize: '15px', lineHeight: '22.5px', color: c.textSecondary,
          })
        }
      } finally { await context.close() }
    })

    it(`rule 11 ${t}: links are #B066FF without underline; underlined on focus and on hover`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        const sel = `.preview-pane a[href="${LINK_HREF}"]`
        const link = page.locator(sel)
        await link.scrollIntoViewIfNeeded()
        await page.mouse.move(1, 1)
        await expectComputedStyle(page, sel, { color: '#B066FF', textDecorationLine: 'none' })
        // Keyboard modality first, so :focus-visible matches as well as :focus.
        await page.keyboard.press('Shift')
        await link.focus()
        await expectComputedStyle(page, sel, { textDecorationLine: /underline/ })
        await link.evaluate((el) => el.blur())
        await link.hover()
        await expectComputedStyle(page, sel, { textDecorationLine: /underline/ })
      } finally { await context.close() }
    })

    it(`rule 11 ${t}: tables — header fill, 1px --border cells, transparent body rows (no zebra)`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await expectComputedStyle(page, '.preview-pane th', {
          backgroundColor: c.thBg, color: c.thText, fontWeight: '600',
          borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: c.border,
        })
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          await expectComputedStyle(page, '.preview-pane td', {
            [`border${side}Width`]: '1px', [`border${side}Style`]: 'solid', [`border${side}Color`]: c.border,
          })
        }
        const rows = page.locator('.preview-pane tbody tr')
        assert.ok(await rows.count() >= 2, 'fixture table has two body rows')
        for (const i of [0, 1]) await expectComputedStyle(page, rows.nth(i), { backgroundColor: TRANSPARENT })
        const [a, b] = await page.locator('.preview-pane tbody tr').evaluateAll((trs) =>
          trs.slice(0, 2).map((tr) => getComputedStyle(tr.querySelector('td')).backgroundColor))
        assert.equal(a, b, 'body cells share one background (no zebra)')
      } finally { await context.close() }
    })

    it(`rule 11 ${t}: code — JetBrains Mono on --bg-code; pre 1px --border radius 8px; hljs colours`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await expectComputedStyle(page, '.preview-pane p code', { fontFamily: JETBRAINS, backgroundColor: c.bgCode })
        await expectComputedStyle(page, '.preview-pane pre', {
          backgroundColor: c.bgCode, borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: c.border,
          borderTopLeftRadius: '8px', borderBottomRightRadius: '8px',
        })
        await expectComputedStyle(page, '.preview-pane pre code', { fontFamily: JETBRAINS })
        const js = '.preview-pane code.language-js'
        const kw = { color: c.keyword }
        if (t === 'locus-light') kw.fontWeight = '600'
        await expectComputedStyle(page, `${js} .hljs-keyword`, kw)
        await expectComputedStyle(page, `${js} .hljs-comment`, { color: '#9B8FA8', fontStyle: 'italic' })
        await expectComputedStyle(page, `${js} .hljs-number`, { color: c.textSecondary })
        await expectComputedStyle(page, `${js} .hljs-string`, { color: c.textSecondary })
      } finally { await context.close() }
    })

    it(`rule 11 ${t}: blockquote is a card — no stripe, --bg-code, radius 8px, padding 12px 16px`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await expectComputedStyle(page, '.preview-pane blockquote', {
          borderLeftWidth: '0px', backgroundColor: c.bgCode, borderTopLeftRadius: '8px', borderBottomLeftRadius: '8px',
          paddingTop: '12px', paddingBottom: '12px', paddingLeft: '16px', paddingRight: '16px',
        })
      } finally { await context.close() }
    })

    it(`AC-01.7 ${t}: .btn-primary is #B066FF on #280A38; header, buttons, preview pane and Style menu are flat`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await addButtonProbes(page)
        const primary = { backgroundColor: 'rgb(176, 102, 255)', color: 'rgb(40, 10, 56)', backgroundImage: 'none', boxShadow: 'none' }
        await expectComputedStyle(page, '#t01-probe-primary', primary)
        // Every primary button the app itself shows right now.
        const real = page.locator('.btn-primary:visible:not(:disabled):not([id^="t01-probe"])')
        for (let i = 0, n = Math.min(await real.count(), 6); i < n; i++) await expectComputedStyle(page, real.nth(i), primary)

        const flat = { backgroundImage: 'none', boxShadow: 'none' }
        await expectComputedStyle(page, await headerLocator(page), flat)
        await expectComputedStyle(page, '.preview-pane', flat)
        await expectComputedStyle(page, toggle(page), flat)
        await expectComputedStyle(page, trigger(page), flat)
        const btns = page.locator('.btn:visible')
        for (let i = 0, n = Math.min(await btns.count(), 12); i < n; i++) await expectComputedStyle(page, btns.nth(i), flat)
        await openMenu(page)
        await expectComputedStyle(page, menu(page), flat)
      } finally { await context.close() }
    })

    it(`rule 10 ${t}: header on --bg-surface with a --border bottom rule; .btn-ghost uses --text-secondary / --border`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await expectComputedStyle(page, await headerLocator(page), {
          backgroundColor: c.bgSurface, borderBottomStyle: 'solid', borderBottomColor: c.border, fontFamily: MONTSERRAT,
        })
        await addButtonProbes(page)
        await expectComputedStyle(page, '#t01-probe-ghost', {
          color: c.textSecondary, borderTopColor: c.border, backgroundImage: 'none', boxShadow: 'none',
        })
      } finally { await context.close() }
    })

    it(`rule 7 ${t}: Style menu is opaque --bg-surface, 1px --border, radius 8px, right-aligned under the trigger`, T, async () => {
      const { context, page } = await open({ theme: t })
      try {
        await openMenu(page)
        await expectComputedStyle(page, menu(page), {
          backgroundColor: c.bgSurface, borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: c.border,
          borderTopLeftRadius: '8px', borderBottomRightRadius: '8px',
        })
        const tb = await trigger(page).boundingBox()
        const mb = await menu(page).boundingBox()
        assert.ok(mb.y >= tb.y + tb.height - 1, `menu opens below the trigger (menu top ${mb.y}, trigger bottom ${tb.y + tb.height})`)
        assert.ok(Math.abs((mb.x + mb.width) - (tb.x + tb.width)) <= 2, `menu right edge ${mb.x + mb.width} aligns with trigger right edge ${tb.x + tb.width}`)
        const z = await menu(page).evaluate((el) => {
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const zi = getComputedStyle(n).zIndex
            if (zi !== 'auto') return Number(zi)
          }
          return 0
        })
        const hz = await (await headerLocator(page)).evaluate((el) => Number(getComputedStyle(el).zIndex) || 0)
        assert.ok(z >= hz, `menu stacks above header content (menu z ${z}, header z ${hz})`)
      } finally { await context.close() }
    })
  }

  // Owner decision 2026-10-11 (DECISIONS.md): fonts are self-hosted, so rule 8's
  // "Google Fonts link with display=swap" is checked as the same faces bundled
  // with the app, font-display: swap, and no request to a Google font host.
  it('rule 8: Montserrat is self-hosted with the spec weights and actually loaded; code stays JetBrains Mono', T, async () => {
    const requests = []
    const { context, page } = await open({ theme: 'locus-light', requests })
    try {
      const faces = await page.evaluate(() => [...document.fonts].map((f) => ({
        family: f.family.replace(/["']/g, ''), weight: String(f.weight), style: f.style, display: f.display,
      })))
      const montserrat = faces.filter((f) => f.family === 'Montserrat')
      const have = new Set(montserrat.map((f) => `${f.weight}/${f.style}`))
      for (const w of ['300', '400', '500', '600', '800']) assert.ok(have.has(`${w}/normal`), `Montserrat ${w} face available (faces: ${[...have].join(', ') || 'none'})`)
      assert.ok(have.has('400/italic'), `Montserrat italic 400 face available (faces: ${[...have].join(', ')})`)
      assert.ok(montserrat.every((f) => f.display === 'swap'), `every Montserrat face is font-display: swap (${[...new Set(montserrat.map((f) => f.display))].join(', ')})`)
      assert.ok(faces.some((f) => f.family === 'JetBrains Mono'), 'JetBrains Mono face still available')
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('link[href]')].map((l) => l.getAttribute('href') || ''))
      assert.deepEqual(hrefs.filter((h) => /fonts\.(googleapis|gstatic)\.com/.test(h)), [], 'no Google Fonts <link> or preconnect')

      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => {
        const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Montserrat' && f.status === 'loaded')
        return faces.some((f) => String(f.weight) === '600') && faces.some((f) => String(f.weight) === '400')
      }, null, { timeout: 15000 }).catch(() => {})
      const fonts = await page.evaluate(() => ({
        loaded: [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Montserrat' && f.status === 'loaded').map((f) => `${f.weight}/${f.style}`),
        check: document.fonts.check('600 30px Montserrat') && document.fonts.check('400 15px Montserrat'),
      }))
      assert.ok(fonts.loaded.includes('600/normal'), `Montserrat 600 loaded and used (loaded faces: ${fonts.loaded.join(', ') || 'none'})`)
      assert.ok(fonts.loaded.includes('400/normal'), `Montserrat 400 loaded and used (loaded faces: ${fonts.loaded.join(', ') || 'none'})`)
      assert.ok(fonts.check, 'document.fonts.check() for Montserrat 600 and 400')
      const google = requests.filter((u) => /^https?:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u))
      assert.deepEqual(google, [], 'no request to a Google font host')
      assert.ok(requests.some((u) => /montserrat-latin-(400|600)-normal[^/]*\.woff2/.test(u)), 'Montserrat woff2 served by the app itself')
    } finally { await context.close() }
  })

  it('rule 8: the editor stays JetBrains Mono in Locus', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      const edit = page.locator('[data-testid="view-toggle-edit"]')
      if (await edit.count()) await edit.first().click()
      else await page.locator('button:has-text("Edit")').first().click()
      await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 15000 })
      await expectComputedStyle(page, '.cm-content', { fontFamily: JETBRAINS })
    } finally { await context.close() }
  })

  for (const t of ['locus-light', 'locus-dark']) {
    it(`edge: the landing page (no doc) is themed in ${t}`, T, async () => {
      const { context, page } = await open({ theme: t, url: `${BASE}/`, waitText: null, colorScheme: DARK[t] ? 'dark' : 'light' })
      try {
        await page.locator('#app *').first().waitFor({ state: 'attached' })
        await expectTheme(page, t)
        await expectComputedStyle(page, 'body', { backgroundColor: LOCUS[t].bgPage })
      } finally { await context.close() }
    })
  }
})

// ── AC-01.8: Default and GitHub unchanged ───────────────────────────────────

describe('#1 Default and GitHub looks unchanged', () => {
  const githubLinks = (page) => page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .filter((l) => /github-markdown/.test(l.getAttribute('href') || '') || /^github-css-/.test(l.id))
      .map((l) => ({ which: /dark/.test(l.id || l.getAttribute('href')) ? 'dark' : 'light', enabled: !l.disabled && !(l.sheet && l.sheet.disabled) })))
  // Today's token values (src/style.css) for the two untouched styles.
  const BG_PAGE = { 'light': '#F7F3EB', 'dark': '#1A1A1E', 'github-light': '#F6F8FA', 'github-dark': '#010409' }

  it('AC-01.8 Default/GitHub: h1 not Montserrat, .markdown-body only in GitHub, github CSS enabled only for its own theme', SLOW, async () => {
    const { context, page } = await open()
    try {
      for (const t of THEMES) {
        await setThemeViaUi(page, t)
        const links = await githubLinks(page)
        assert.equal(links.length, 2, `${t}: both github-markdown-css links exist`)
        const enabled = links.filter((l) => l.enabled).map((l) => l.which)
        assert.deepEqual(enabled, STYLE[t] === 'github' ? [DARK[t] ? 'dark' : 'light'] : [], `${t}: enabled github CSS`)
        const mdBody = await page.locator('.preview-pane.markdown-body').count()
        assert.equal(mdBody > 0, STYLE[t] === 'github', `${t}: .preview-pane.markdown-body present only for GitHub`)
        if (STYLE[t] !== 'locus') {
          const { 'font-family': ff } = await getComputedStyles(page, '.preview-pane h1', ['font-family'])
          assert.ok(!/Montserrat/.test(ff), `${t}: h1 font-family must not be Montserrat (got ${ff})`)
          const { 'font-family': bf } = await getComputedStyles(page, 'body', ['font-family'])
          assert.ok(!/Montserrat/.test(bf), `${t}: body font-family must not be Montserrat (got ${bf})`)
          await expectComputedStyle(page, 'html', { '--bg-page': BG_PAGE[t] })
        }
        if (t === 'light' || t === 'dark') {
          await expectComputedStyle(page, '.preview-pane h1', { fontFamily: /Crimson Pro/ })
        }
      }
    } finally { await context.close() }
  })

  it('edge: Locus → GitHub → Locus leaves no Montserrat in GitHub and disables github CSS again in Locus', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      await expectTheme(page, 'locus-light')
      await chooseStyle(page, 'github')
      await expectTheme(page, 'github-light')
      const { 'font-family': ff } = await getComputedStyles(page, '.preview-pane h1', ['font-family'])
      assert.ok(!/Montserrat/.test(ff), `github-light h1 after Locus: ${ff}`)
      assert.deepEqual((await githubLinks(page)).filter((l) => l.enabled).map((l) => l.which), ['light'])
      await chooseStyle(page, 'locus')
      await expectTheme(page, 'locus-light')
      assert.deepEqual((await githubLinks(page)).filter((l) => l.enabled), [], 'no github CSS enabled in Locus')
      assert.equal(await page.locator('.preview-pane.markdown-body').count(), 0)
      await expectComputedStyle(page, '.preview-pane h1', { fontFamily: MONTSERRAT })
    } finally { await context.close() }
  })

  it('AC-01.8 / rule 12: Default and GitHub keep mermaid "neutral" (light) — flowchart node fill unchanged', T, async () => {
    const { context, page } = await open()
    try {
      await waitMermaid(page)
      const node = () => mermaidNth(page, 0).locator('svg .node rect')
      await eventually(() => expectComputedStyle(page, node(), { fill: '#EEEEEE' }), { timeout: 8000 })
      await chooseStyle(page, 'github')
      await eventually(() => expectComputedStyle(page, node(), { fill: '#EEEEEE' }), { timeout: 8000 })
    } finally { await context.close() }
  })
})

// ── AC-01.9, rule 12: mermaid ───────────────────────────────────────────────

describe('#1 mermaid in Locus', () => {
  it('AC-01.9 locus-light flowchart nodes and pie legend use the brand; locus-dark re-renders the SVG', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      await waitMermaid(page)
      const node = () => mermaidNth(page, 0).locator('svg .node rect')
      await eventually(() => expectComputedStyle(page, node(), { fill: 'rgb(243, 240, 235)', stroke: 'rgb(176, 102, 255)' }), { timeout: 8000 })

      const legend = mermaidNth(page, 1).locator('svg .legend rect')
      assert.equal(await legend.count(), 6, 'pie legend has 6 swatches')
      for (let i = 0; i < 6; i++) await expectComputedStyle(page, legend.nth(i), { fill: SERIES[i] })

      const before = await mermaidNth(page, 0).locator('svg').first().evaluate((el) => el.outerHTML)
      await toggle(page).click()
      await expectTheme(page, 'locus-dark')
      await eventually(() => expectComputedStyle(page, node(), { fill: 'rgb(83, 59, 96)' }), { timeout: 8000 })
      const afterSvg = await mermaidNth(page, 0).locator('svg').first().evaluate((el) => el.outerHTML)
      assert.notEqual(afterSvg, before, 'flowchart SVG was re-rendered')
      assert.deepEqual(await svgCounts(page), [1, 1, 1], 'exactly one SVG per diagram')
      for (let i = 0; i < 6; i++) await expectComputedStyle(page, mermaidNth(page, 1).locator('svg .legend rect').nth(i), { fill: SERIES[i] })
    } finally { await context.close() }
  })

  for (const t of ['locus-light', 'locus-dark']) {
    it(`rule 12 ${t}: Montserrat diagrams, brand node text / border / lines, pie slices and xy plots in series order`, T, async () => {
      const c = LOCUS[t]
      const { context, page } = await open({ theme: t })
      try {
        await waitMermaid(page)
        const flow = mermaidNth(page, 0)
        await eventually(() => expectComputedStyle(page, flow.locator('svg .node rect'), { fill: c.node, stroke: '#B066FF' }), { timeout: 8000 })
        await expectComputedStyle(page, flow.locator('svg').first(), { fontFamily: /Montserrat/ })
        await expectComputedStyle(page, flow.locator('svg .flowchart-link'), { stroke: c.line })
        await expectComputedStyle(page, flow.locator('svg .nodeLabel'), { color: c.nodeText })
        const slices = mermaidNth(page, 1).locator('svg path.pieCircle')
        assert.equal(await slices.count(), 6)
        for (let i = 0; i < 6; i++) await expectComputedStyle(page, slices.nth(i), { fill: SERIES[i] })
        const xy = mermaidNth(page, 2)
        await expectComputedStyle(page, xy.locator('svg g.bar-plot-0 rect'), { fill: SERIES[0] })
        await expectComputedStyle(page, xy.locator('svg g.line-plot-1 path'), { stroke: SERIES[1] })
      } finally { await context.close() }
    })
  }

  it('edge: rapid toggling with diagrams on the page leaves exactly one SVG per diagram, in the final theme', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      await waitMermaid(page)
      for (let i = 0; i < 5; i++) await toggle(page).click()
      await expectTheme(page, 'locus-dark')
      const node = () => mermaidNth(page, 0).locator('svg .node rect')
      await eventually(() => expectComputedStyle(page, node(), { fill: '#533B60' }), { timeout: 10000 })
      await eventually(async () => assert.deepEqual(await svgCounts(page), [1, 1, 1]), { timeout: 5000 })
      await sleep(400) // let any straggling render land before the final check
      assert.deepEqual(await svgCounts(page), [1, 1, 1], 'exactly one SVG per diagram after settling')
      await expectComputedStyle(page, node(), { fill: '#533B60' })
    } finally { await context.close() }
  })
})

// ── AC-01.10, rule 13: HTML iframe brand signal ─────────────────────────────

async function docFrame(page, readySelector) {
  const handle = await page.locator('iframe').first().elementHandle({ timeout: 15000 })
  let frame = await handle.contentFrame()
  for (let i = 0; i < 50 && !frame; i++) { await sleep(100); frame = await handle.contentFrame() }
  assert.ok(frame, 'HTML doc iframe has a frame')
  await frame.waitForSelector(readySelector, { state: 'attached', timeout: 15000 })
  return frame
}
const frameAttrs = (frame) => frame.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  style: document.documentElement.getAttribute('data-theme-style'),
}))
async function expectFrame(frame, theme, style, msg) {
  await eventually(async () => assert.deepEqual(await frameAttrs(frame), { theme, style }, msg), { timeout: 5000 })
}

describe('#1 HTML documents — iframe theme signal', () => {
  it('AC-01.10 Locus dark stamps data-theme="dark" + data-theme-style="locus" on the frame <html>; Default light updates both; nothing but the bridge script is injected', T, async () => {
    const { context, page } = await open({ url: docUrl(docs.html), waitText: null })
    try {
      const frame = await docFrame(page, '#hb')
      await expectFrame(frame, 'light', 'default', 'initial Default light')

      await chooseStyle(page, 'locus')
      await toggle(page).click()
      await expectTheme(page, 'locus-dark')
      await expectFrame(frame, 'dark', 'locus', 'after Locus dark')

      const injected = await frame.evaluate(() => ({
        style: document.querySelectorAll('style').length,
        link: document.querySelectorAll('link').length,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyFont: getComputedStyle(document.body).fontFamily,
      }))
      assert.equal(injected.style, HTML_SOURCE_COUNTS.style, 'no <style> added to the user document')
      assert.equal(injected.link, HTML_SOURCE_COUNTS.link, 'no <link> added to the user document')
      assert.equal(injected.bodyBg, TRANSPARENT, 'user document background untouched')
      assert.ok(!/Montserrat/.test(injected.bodyFont), `no Montserrat in the user document (${injected.bodyFont})`)
      await expectComputedStyle(page, 'iframe', { backgroundColor: '#FFFFFF' })

      await chooseStyle(page, 'default')
      await toggle(page).click()
      await expectTheme(page, 'light')
      await expectFrame(frame, 'light', 'default', 'after Default light')
    } finally { await context.close() }
  })

  it('rule 13: GitHub style reaches the frame too', T, async () => {
    const { context, page } = await open({ url: docUrl(docs.html), waitText: null })
    try {
      const frame = await docFrame(page, '#hb')
      await chooseStyle(page, 'github')
      await expectFrame(frame, 'light', 'github', 'after GitHub light')
    } finally { await context.close() }
  })

  it('edge: a document without </body> still gets both attributes', T, async () => {
    const { context, page } = await open({ theme: 'locus-light', url: docUrl(docs.nobody), waitText: null })
    try {
      const frame = await docFrame(page, '#nb')
      await expectFrame(frame, 'light', 'locus', 'no-</body> doc in locus-light')
      await toggle(page).click()
      await expectFrame(frame, 'dark', 'locus', 'no-</body> doc in locus-dark')
    } finally { await context.close() }
  })

  it('rule 13: a theme message without __mdreview_style still sets data-theme', T, async () => {
    const { context, page } = await open({ url: docUrl(docs.html), waitText: null })
    try {
      const frame = await docFrame(page, '#hb')
      await expectFrame(frame, 'light', 'default', 'initial')
      await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ __mdreview_theme: 'dark' }, '*'))
      await eventually(async () => assert.equal((await frameAttrs(frame)).theme, 'dark'), { timeout: 3000 })
    } finally { await context.close() }
  })
})

// ── AC-01.11, 01.12, rules 5–6: switcher structure, keyboard, ARIA ──────────

describe('#1 switcher — structure, ARIA and keyboard', () => {
  it('rule 5 / 00 §2.1: toggle is the first .btn-icon <button>; Style trigger follows it and is not a .btn-icon', T, async () => {
    const { context, page } = await open()
    try {
      const r = await page.evaluate(() => {
        const tg = document.querySelector('[data-testid="theme-toggle"]')
        const tr = document.querySelector('[data-testid="theme-style-menu"]')
        return {
          toggleTag: tg?.tagName, toggleBtnIcon: tg?.classList.contains('btn-icon'),
          firstBtnIcon: document.querySelector('.btn-icon') === tg && !!tg,
          triggerTag: tr?.tagName, triggerBtnIcon: tr?.classList.contains('btn-icon'),
          order: tg && tr ? !!(tg.compareDocumentPosition(tr) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
          popup: tr?.getAttribute('aria-haspopup'), expanded: tr?.getAttribute('aria-expanded'),
          triggerSvg: tr ? tr.querySelectorAll('svg').length : 0,
        }
      })
      assert.equal(r.toggleTag, 'BUTTON', 'theme-toggle is a <button>')
      assert.equal(r.toggleBtnIcon, true, 'theme-toggle has class btn-icon')
      assert.equal(r.firstBtnIcon, true, 'theme-toggle is the first .btn-icon in the document')
      assert.equal(r.triggerTag, 'BUTTON', 'theme-style-menu is a <button>')
      assert.equal(r.triggerBtnIcon, false, 'theme-style-menu must not carry btn-icon')
      assert.equal(r.order, true, 'DOM order: toggle, then Style trigger')
      assert.equal(r.popup, 'menu')
      assert.equal(r.expanded, 'false')
      assert.ok(r.triggerSvg >= 1, 'Style trigger shows an icon')
      assert.ok(await toggle(page).isVisible() && await trigger(page).isVisible(), 'both controls visible')
      assert.equal(await menu(page).count(), 0, 'menu list is not rendered while closed')
    } finally { await context.close() }
  })

  it('AC-01.12 toggle aria-label / title name the mode it switches to, in every style', T, async () => {
    const { context, page } = await open()
    try {
      for (const t of THEMES) {
        await setThemeViaUi(page, t)
        const label = DARK[t] ? 'Switch to light mode' : 'Switch to dark mode'
        assert.equal(await toggle(page).getAttribute('aria-label'), label, `${t}: aria-label`)
        assert.equal(await toggle(page).getAttribute('title'), label, `${t}: title`)
      }
    } finally { await context.close() }
  })

  it('AC-01.12 open menu: role=menu "Theme style", 3 menuitemradio options, one aria-checked matching <html data-theme-style>; trigger named "Style: …"', T, async () => {
    const { context, page } = await open()
    try {
      for (const style of ['default', 'github', 'locus']) {
        if (style !== 'default') await chooseStyle(page, style)
        const named = page.getByRole('button', { name: `Style: ${LABEL[style]}`, exact: true })
        assert.equal(await named.count(), 1, `exactly one button named "Style: ${LABEL[style]}"`)
        assert.equal(await named.getAttribute('data-testid'), 'theme-style-menu')
        assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false', 'collapsed while closed')

        await openMenu(page)
        assert.equal(await trigger(page).getAttribute('aria-expanded'), 'true', 'expanded while open')
        assert.equal(await menu(page).getAttribute('role'), 'menu')
        assert.equal(await menu(page).getAttribute('aria-label'), 'Theme style')
        assert.equal(await menu(page).locator('[role="menuitemradio"]').count(), 3, '3 menuitemradio')
        const items = await options(page).evaluateAll((els) => els.map((e) => ({
          role: e.getAttribute('role'), style: e.getAttribute('data-style'), text: e.textContent.trim(), checked: e.getAttribute('aria-checked'),
        })))
        assert.deepEqual(items.map((i) => i.role), ['menuitemradio', 'menuitemradio', 'menuitemradio'])
        assert.deepEqual(items.map((i) => i.style), ['default', 'github', 'locus'])
        assert.deepEqual(items.map((i) => i.text), ['Default', 'GitHub', 'Locus'])
        const checked = items.filter((i) => i.checked === 'true').map((i) => i.style)
        const htmlStyle = await page.evaluate(() => document.documentElement.getAttribute('data-theme-style'))
        assert.deepEqual(checked, [htmlStyle], `exactly one aria-checked="true", matching data-theme-style (${htmlStyle})`)
        assert.equal(htmlStyle, style)
        await page.keyboard.press('Escape')
        await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
        assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false')
      }
    } finally { await context.close() }
  })

  it('AC-01.11 Enter opens on the checked item; ArrowDown ×3 wraps; End + Enter selects Locus; Escape and Tab close without change', T, async () => {
    const { context, page } = await open()
    try {
      await trigger(page).focus()
      await page.keyboard.press('Enter')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await trigger(page).getAttribute('aria-expanded'), 'true')
      await expectFocusOnOption(page, 'default', 'Enter opens')
      await page.keyboard.press('ArrowDown')
      await expectFocusOnOption(page, 'github', 'ArrowDown 1')
      await page.keyboard.press('ArrowDown')
      await expectFocusOnOption(page, 'locus', 'ArrowDown 2')
      await page.keyboard.press('ArrowDown')
      await expectFocusOnOption(page, 'default', 'ArrowDown 3 wraps')
      await page.keyboard.press('End')
      await expectFocusOnOption(page, 'locus', 'End')
      await page.keyboard.press('Enter')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      await expectTheme(page, 'locus-light', 'Enter selected Locus')
      await expectFocusOnTrigger(page, 'after select')
      assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false')

      await page.keyboard.press('Enter')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      await expectFocusOnOption(page, 'locus', 'reopen focuses the checked item')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Escape')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      await expectTheme(page, 'locus-light', 'Escape changes nothing')
      await expectFocusOnTrigger(page, 'after Escape')
      assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false')

      await page.keyboard.press('Enter')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Tab')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      await expectTheme(page, 'locus-light', 'Tab changes nothing')
      assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false')
    } finally { await context.close() }
  })

  it('rule 6 / 00 §3.2: Space and ArrowDown open on the checked item, ArrowUp opens on the last; Home, ArrowUp wrap, Space selects', T, async () => {
    const { context, page } = await open({ theme: 'github-light' })
    try {
      await trigger(page).focus()
      await page.keyboard.press('Space')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      await expectFocusOnOption(page, 'github', 'Space opens on checked')
      await page.keyboard.press('Escape')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })

      await page.keyboard.press('ArrowDown')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      await expectFocusOnOption(page, 'github', 'ArrowDown opens on checked')
      await page.keyboard.press('Escape')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })

      await page.keyboard.press('ArrowUp')
      await menu(page).waitFor({ state: 'visible', timeout: 3000 })
      await expectFocusOnOption(page, 'locus', 'ArrowUp opens on the last item')
      await page.keyboard.press('Home')
      await expectFocusOnOption(page, 'default', 'Home')
      await page.keyboard.press('ArrowUp')
      await expectFocusOnOption(page, 'locus', 'ArrowUp wraps to last')
      await page.keyboard.press('ArrowUp')
      await expectFocusOnOption(page, 'github', 'ArrowUp')
      await page.keyboard.press('ArrowUp')
      await expectFocusOnOption(page, 'default', 'ArrowUp')
      await page.keyboard.press('Space')
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      await expectTheme(page, 'light', 'Space selected Default, dark flag kept')
      await expectFocusOnTrigger(page, 'after Space select')
    } finally { await context.close() }
  })

  it('rule 6: an outside click closes the menu without change', T, async () => {
    const { context, page } = await open()
    try {
      await openMenu(page)
      await page.locator('.preview-pane p').first().click()
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      await expectTheme(page, 'light')
      assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false')
    } finally { await context.close() }
  })

  it('edge: pressing the toggle while the menu is open closes the menu, flips dark and keeps the style', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      await openMenu(page)
      await toggle(page).click()
      await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      await expectTheme(page, 'locus-dark')
    } finally { await context.close() }
  })

  it('rule 6: a visible focus ring on toggle, trigger and items in every theme', SLOW, async () => {
    const { context, page } = await open()
    try {
      for (const t of THEMES) {
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, t])
        await page.reload()
        await waitForDoc(page, DOC_MARK)
        await expectTheme(page, t)
        await page.keyboard.press('Shift') // keyboard modality → :focus-visible
        await toggle(page).focus()
        let ring = await isRingVisible(toggle(page))
        assert.ok(ring.ok, `${t}: toggle focus ring (${JSON.stringify(ring)})`)
        await page.keyboard.press('Tab')
        await expectFocusOnTrigger(page, `${t}: Tab from toggle`)
        ring = await isRingVisible(trigger(page))
        assert.ok(ring.ok, `${t}: trigger focus ring (${JSON.stringify(ring)})`)
        await page.keyboard.press('Enter')
        await menu(page).waitFor({ state: 'visible', timeout: 3000 })
        ring = await isRingVisible(option(page, STYLE[t]))
        assert.ok(ring.ok, `${t}: focused item ring (${JSON.stringify(ring)})`)
        await page.keyboard.press('Escape')
        await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
      }
    } finally { await context.close() }
  })
})

// ── AC-01.13: contrast ──────────────────────────────────────────────────────

describe('#1 accessibility — colour contrast', () => {
  const contrast = async (page, exclude) => {
    const v = await runAxe(page, { minImpact: 'minor', exclude })
    return v.filter((x) => x.id === 'color-contrast')
  }
  async function ready(page) {
    await waitMermaid(page)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => window.scrollTo(0, 0))
  }

  it('AC-01.13 locus-dark passes axe color-contrast (WCAG AA) with no exclusions', T, async () => {
    const { context, page } = await open({ theme: 'locus-dark', colorScheme: 'dark' })
    try {
      await expectTheme(page, 'locus-dark')
      await ready(page)
      const v = await contrast(page, [])
      assert.equal(v.length, 0, formatViolations(v))
    } finally { await context.close() }
  })

  it('AC-01.13 locus-light passes axe color-contrast excluding only links, h3–h6 and .hljs-comment', T, async () => {
    const { context, page } = await open({ theme: 'locus-light' })
    try {
      await expectTheme(page, 'locus-light')
      await ready(page)
      const v = await contrast(page, [
        '.preview-pane a', '.preview-pane h3', '.preview-pane h4', '.preview-pane h5', '.preview-pane h6', '.hljs-comment',
      ])
      assert.equal(v.length, 0, formatViolations(v))
    } finally { await context.close() }
  })
})

// ── AC-01.14: placement at the three viewports ──────────────────────────────

describe('#1 switcher placement at every viewport', () => {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    it(`AC-01.14 ${vpName} ${vp.width}×${vp.height}: toggle and trigger in view; open menu inside the viewport and uncovered — all 6 themes`, SLOW, async () => {
      const { context, page } = await open({ viewport: vp })
      try {
        for (const t of THEMES) {
          await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, t])
          await page.reload()
          await waitForDoc(page, DOC_MARK)
          await expectTheme(page, t)
          for (const [name, loc] of [['theme-toggle', toggle(page)], ['theme-style-menu', trigger(page)]]) {
            assert.ok(await loc.isVisible(), `${t}: ${name} visible`)
            const b = await loc.boundingBox()
            assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width && b.y + b.height <= vp.height,
              `${t}: ${name} inside the viewport (${JSON.stringify(b)})`)
          }
          await openMenu(page)
          const mb = await menu(page).boundingBox()
          assert.ok(mb && mb.x >= 0 && mb.y >= 0 && mb.x + mb.width <= vp.width && mb.y + mb.height <= vp.height,
            `${t}: open menu inside the viewport (${JSON.stringify(mb)})`)
          const covered = await menu(page).evaluate((m) => {
            const r = m.getBoundingClientRect()
            const pts = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]]
            for (const it of m.querySelectorAll('[data-testid="theme-style-option"]')) {
              const ir = it.getBoundingClientRect()
              pts.push([ir.left + ir.width / 2, ir.top + ir.height / 2])
            }
            return pts.filter(([x, y]) => !m.contains(document.elementFromPoint(x, y))).map((p) => p.map(Math.round))
          })
          assert.deepEqual(covered, [], `${t}: menu not covered at points`)
          await page.keyboard.press('Escape')
          await menu(page).waitFor({ state: 'hidden', timeout: 3000 })
        }
      } finally { await context.close() }
    })
  }
})

// ── AC-01.15: screenshots for the visual verifier ───────────────────────────

describe('#1 screenshots for visual verification', () => {
  it('AC-01.15 capture Locus light/dark (and Default light for reference) at 3 viewports into .verify/screens/01/', { timeout: 420_000 }, async () => {
    const shots = []
    const problems = []
    const themes = ['locus-light', 'locus-dark', 'light']
    for (const t of themes) {
      for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        const shot = async (page, target, file) => {
          const path = join(SCREENS, target, `${t}-${vpName}${file ? '-' + file : ''}.png`)
          mkdirSync(dirname(path), { recursive: true })
          await page.screenshot({ path })
          shots.push({ target, theme: t, viewport: vpName, ...vp, file: path.slice(SCREENS.length + 1) })
        }
        const check = async (page, where) => {
          const s = await htmlState(page)
          if (JSON.stringify(s) !== JSON.stringify(want(t))) problems.push(`${where} ${t}-${vpName}: html state ${JSON.stringify(s)}`)
        }

        // Markdown fixture: top, tables, diagrams, open Style menu.
        let { context, page } = await open({ theme: t, viewport: vp, colorScheme: DARK[t] ? 'dark' : 'light' })
        try {
          await page.evaluate(() => document.fonts.ready)
          await check(page, 'doc')
          await shot(page, 'doc', 'top')
          await page.locator('.preview-pane table').first().scrollIntoViewIfNeeded()
          await shot(page, 'doc', 'table')
          await page.locator('.preview-pane blockquote').first().scrollIntoViewIfNeeded().catch(() => {})
          await shot(page, 'doc', 'quote-code')
          try {
            await waitMermaid(page)
            await mermaidNth(page, 1).scrollIntoViewIfNeeded()
            await sleep(300)
          } catch (e) { problems.push(`diagrams ${t}-${vpName}: ${String(e.message).split('\n')[0]}`) }
          await shot(page, 'doc', 'diagrams')
          await page.evaluate(() => window.scrollTo(0, 0))
          try {
            await openMenu(page)
            await shot(page, 'doc', 'menu-open')
          } catch (e) { problems.push(`menu ${t}-${vpName}: ${String(e.message).split('\n')[0]}`) }
        } finally { await context.close() }

        // HTML doc (iframe) and the landing page.
        ;({ context, page } = await open({ theme: t, viewport: vp, colorScheme: DARK[t] ? 'dark' : 'light', url: docUrl(docs.html), waitText: null }))
        try {
          await docFrame(page, '#hb')
          await check(page, 'html-doc')
          await shot(page, 'html-doc')
          await page.goto(`${BASE}/`)
          await page.locator('#app *').first().waitFor({ state: 'attached' })
          await page.evaluate(() => document.fonts.ready)
          await check(page, 'landing')
          await shot(page, 'landing')
        } finally { await context.close() }
      }
    }
    mkdirSync(SCREENS, { recursive: true })
    writeFileSync(join(SCREENS, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, shots, problems }, null, 2) + '\n')
    assert.deepEqual(problems, [], 'every screenshot shows the requested theme')
    assert.ok(shots.length >= themes.length * 3 * 7, `captured ${shots.length} screenshots`)
  })
})
