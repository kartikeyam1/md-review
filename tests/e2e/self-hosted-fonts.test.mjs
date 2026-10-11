// Regression: web fonts are self-hosted (owner decision 2026-10-11, DECISIONS.md).
// The doc, library and landing pages, in a Default and a Locus theme (between
// them every bundled family is used), make no request to a Google font host,
// and the faces they render with are served by the app itself.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE } from './helpers.mjs'
import { createDoc, uniq } from './lib/docs.mjs'

const T = { timeout: 60_000 }
const GOOGLE_FONTS = /^https?:\/\/fonts\.(googleapis|gstatic)\.com\//
const DOC_MARK = 'Self-hosted fonts probe paragraph.'
const MARKDOWN = `# Fonts probe\n\n${DOC_MARK} *Italic text.* **Bold text.**\n\n\`\`\`js\nconst mono = true\n\`\`\`\n`

let browser
let docId
before(async () => {
  browser = await chromium.launch({ headless: true })
  ;({ id: docId } = await createDoc({ markdown: MARKDOWN, sessionName: uniq('fonts') }))
})
after(async () => { await browser?.close() })

async function visit(theme, path, ready) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const requests = []
  context.on('request', (r) => requests.push(r.url()))
  await context.addInitScript((t) => { try { localStorage.setItem('md-review-theme', t) } catch { /* storage unavailable */ } }, theme)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}${path}`)
    await ready(page)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))
    return { requests, loaded }
  } finally { await context.close() }
}

const PAGES = {
  doc: { path: () => `/d/${docId}`, ready: (page) => page.getByText(DOC_MARK).first().waitFor({ timeout: 15_000 }) },
  library: { path: () => '/library', ready: (page) => page.locator('[data-testid="library-page"]').waitFor({ timeout: 15_000 }) },
  landing: { path: () => '/', ready: (page) => page.locator('#app *').first().waitFor({ state: 'attached', timeout: 15_000 }) },
}
const FAMILY = { light: 'DM Sans', 'locus-light': 'Montserrat' }

describe('self-hosted web fonts', () => {
  for (const [name, p] of Object.entries(PAGES)) {
    for (const theme of ['light', 'locus-light']) {
      it(`${name} page (${theme}): no request to a Google font host; fonts come from the app`, T, async () => {
        const { requests, loaded } = await visit(theme, p.path(), p.ready)
        assert.deepEqual(requests.filter((u) => GOOGLE_FONTS.test(u)), [], 'requests to Google font hosts')
        const origin = new URL(BASE).origin
        const fonts = requests.filter((u) => /\.woff2(\?|$)/.test(u))
        assert.ok(fonts.length > 0, `at least one woff2 requested (requests: ${requests.length})`)
        assert.ok(fonts.every((u) => u.startsWith(origin)), `every woff2 is same-origin: ${fonts.join(', ')}`)
        assert.ok(loaded.includes(FAMILY[theme]), `${FAMILY[theme]} loaded (loaded: ${[...new Set(loaded)].join(', ') || 'none'})`)
      })
    }
  }
})
