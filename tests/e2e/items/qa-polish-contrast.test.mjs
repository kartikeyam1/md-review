// Final-pass polish: colour contrast across the main screens in all 6 themes
// (docs/build/POLISH.md "Pre-existing issues to fix in the final pass").
//
//  - the doc header's text reads at >= 4.5:1 in every theme (the dark themes
//    shipped muted header text at about 3.2:1);
//  - axe `color-contrast` (WCAG AA) passes on the read, edit and split views,
//    the library, the landing route, the share and history dialogs and slides,
//    in every theme. The only exclusions are the documented Locus-light brand
//    exemptions of AC-01.13 (preview links, h3–h6 and .hljs-comment).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(HERE, '../fixture.md'), 'utf-8')

const T = { timeout: 240_000 }
const tid = (id) => `[data-testid="${id}"]`
const KEY = 'md-review-theme'
const THEMES = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']
const DARK = new Set(['dark', 'github-dark', 'locus-dark'])
// AC-01.13: the brand-mandated #B066FF / #9B8FA8 text in the Locus-light preview.
const LOCUS_LIGHT_EXEMPT = ['.preview-pane a', '.preview-pane h3', '.preview-pane h4', '.preview-pane h5', '.preview-pane h6', '.hljs-comment']

const MARK = 'Polish contrast probe paragraph.'
const DOC_MD = `${FIXTURE.trimEnd()}

## Contrast probes

${MARK} Read the [guide](https://example.com/guide) first.

> A quoted note.

> [!NOTE]
> A note callout.

> [!WARNING]
> A warning callout.

\`\`\`js
// a comment line
const answer = 42
\`\`\`

- [x] done item
- [ ] open item
`

let browser
let doc
before(async () => {
  browser = await chromium.launch({ headless: true })
  doc = await createDoc({ markdown: DOC_MD, filename: 'contrast.md', sessionName: uniq('Contrast'), protected: true })
  // A second revision, so the history dialog lists more than one entry.
  await putMarkdown(doc.slug || doc.id, `${DOC_MD}\nOne more line.\n`, { editToken: doc.editToken })
})
after(async () => { await browser?.close() })

const key = () => doc.slug || doc.id

async function open(theme) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    reducedMotion: 'reduce',
    colorScheme: DARK.has(theme) ? 'dark' : 'light',
  })
  await context.addInitScript(([k, v]) => { try { localStorage.setItem(k, v) } catch {} }, [KEY, theme])
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page }
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** formatViolations plus each node's colours and ratio, so a failure says what to fix. */
function describe_(v) {
  const nodes = v.flatMap((x) => x.nodes).slice(0, 25).map((n) => {
    const d = n.any?.[0]?.data ?? {}
    return `    ${[].concat(n.target).join(' ')}  fg ${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 (needs ${d.expectedContrastRatio})`
  })
  return `${formatViolations(v)}\n${nodes.join('\n')}`
}

async function contrast(page, theme, { include } = {}) {
  const exclude = theme === 'locus-light' ? LOCUS_LIGHT_EXEMPT : []
  return runAxe(page, { minImpact: 'minor', rules: ['color-contrast'], include, exclude })
}

/** Every visible text element in the header: its colour against the nearest opaque background. */
async function headerRatios(page) {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return { r, g, b, a }
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const mix = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 })
    const bgOf = (el) => {
      const layers = []
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break }
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 }
      for (const c of layers.reverse()) bg = mix(c, bg)
      return bg
    }
    const header = document.querySelector('.header')
    if (!header) return null
    const out = []
    for (const el of header.querySelectorAll('*')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (!own || !el.getClientRects().length) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      if (el.closest('[disabled], [aria-disabled="true"]')) continue
      const bg = bgOf(el)
      const fg = mix(parse(cs.color), bg)
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
      out.push({ text: el.textContent.trim().slice(0, 40), cls: el.className?.baseVal ?? el.className, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 })
    }
    return out
  })
}

const SCREENS = [
  ['read', async (page) => {
    await page.goto(`${BASE}/d/${key()}?edit=${doc.editToken}`)
    await page.locator('.preview-pane', { hasText: MARK }).first().waitFor({ timeout: 15_000 })
  }],
  ['share dialog', async (page) => {
    await page.goto(`${BASE}/d/${key()}?edit=${doc.editToken}`)
    await page.locator('.preview-pane', { hasText: MARK }).first().waitFor({ timeout: 15_000 })
    await page.locator(tid('share-btn')).click()
    await page.locator(tid('share-dialog')).waitFor({ state: 'visible', timeout: 5000 })
    return { include: tid('share-dialog') }
  }],
  ['history dialog', async (page) => {
    await page.goto(`${BASE}/d/${key()}?edit=${doc.editToken}`)
    await page.locator('.preview-pane', { hasText: MARK }).first().waitFor({ timeout: 15_000 })
    await page.locator(tid('header-overflow-btn')).click()
    await page.locator(tid('menu-history')).click()
    const modal = page.locator(tid('revisions-modal'))
    await modal.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForFunction((sel) => document.querySelector(sel)?.querySelectorAll('li, [role="option"], button').length > 1, tid('revisions-modal'), { timeout: 10_000 })
    return { include: tid('revisions-modal') }
  }],
  ['edit', async (page) => {
    await page.goto(`${BASE}/d/${key()}?edit=${doc.editToken}&view=edit`)
    await page.locator('.cm-editor:visible .cm-content').first().waitFor({ timeout: 20_000 })
  }],
  ['split', async (page) => {
    await page.goto(`${BASE}/d/${key()}?edit=${doc.editToken}&view=split`)
    await page.locator(tid('split-view')).waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator(`${tid('split-pane-preview')} .preview-pane`, { hasText: MARK }).first().waitFor({ timeout: 15_000 })
  }],
  ['slides', async (page) => {
    await page.goto(`${BASE}/d/${key()}?view=slides`)
    await page.locator(tid('slides-root')).waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator(tid('slides-counter')).waitFor({ state: 'visible' })
  }],
  ['library', async (page) => {
    await page.goto(`${BASE}/library`)
    await page.locator(tid('library-page')).waitFor({ timeout: 15_000 })
    await page.waitForLoadState('networkidle').catch(() => {})
  }],
  ['landing', async (page) => {
    await page.goto(`${BASE}/`)
    await page.waitForLoadState('networkidle').catch(() => {})
  }],
]

describe('final-pass polish — colour contrast', () => {
  it('header text reads at >= 4.5:1 in every theme', T, async () => {
    const bad = []
    for (const theme of THEMES) {
      const { context, page } = await open(theme)
      try {
        await page.goto(`${BASE}/d/${key()}?edit=${doc.editToken}`)
        await page.locator('.preview-pane', { hasText: MARK }).first().waitFor({ timeout: 15_000 })
        await settle(page)
        const ratios = await headerRatios(page)
        assert.ok(ratios?.length, `${theme}: header text found`)
        for (const r of ratios) if (r.ratio < 4.5) bad.push(`${theme}: "${r.text}" (.${r.cls}) ${r.ratio}:1`)
      } finally { await context.close() }
    }
    assert.deepEqual(bad, [], `header text below 4.5:1:\n${bad.join('\n')}`)
  })

  for (const theme of THEMES) {
    it(`${theme}: axe color-contrast passes on every main screen`, T, async () => {
      const failures = []
      const { context, page } = await open(theme)
      try {
        for (const [name, go] of SCREENS) {
          const scope = (await go(page)) || {}
          await settle(page)
          const v = await contrast(page, theme, scope)
          if (v.length) failures.push(`── ${name}\n${describe_(v)}`)
        }
      } finally { await context.close() }
      assert.equal(failures.length, 0, `${theme}:\n${failures.join('\n')}`)
    })
  }
})
