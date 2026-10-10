// Smoke test for the verification-harness helpers in tests/e2e/lib and
// scripts/screens.mjs. It checks that the helpers work, not app behaviour, so
// it asserts only facts that hold on the current app.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, API } from './helpers.mjs'
import { expectComputedStyle, toHex } from './lib/brand.mjs'
import { runAxe, formatViolations } from './lib/axe.mjs'
import { recordScripts } from './lib/network.mjs'
import { captureMatrix, FIXTURE, THEME_KEY } from '../../scripts/screens.mjs'

const FILE_URL = `${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`

let browser

async function openWithTheme(theme) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [THEME_KEY, theme])
  const page = await context.newPage()
  return { context, page }
}

before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

describe('harness helpers', () => {
  it('brand: expectComputedStyle normalises colours and reports mismatches', async () => {
    const { context, page } = await openWithTheme('light')
    try {
      await page.goto(FILE_URL)
      await page.locator('.app').waitFor()
      // style.css :root — --bg-page #f7f3eb, --text-primary #1a1612
      await expectComputedStyle(page, 'body', { backgroundColor: '#F7F3EB', color: '#1a1612' })
      await expectComputedStyle(page, 'body', { 'background-color': 'rgb(247, 243, 235)' })
      assert.deepEqual(await toHex(page, ['#280a38', 'rgba(40, 10, 56, 0.5)', 'not-a-colour']), ['#280A38', '#280A3880', null])
      await assert.rejects(
        expectComputedStyle(page, 'body', { color: '#280A38' }),
        /color: expected "#280A38", got #1A1612/,
      )
    } finally { await context.close() }
  })

  it('brand: theme from localStorage reaches the computed styles (dark)', async () => {
    const { context, page } = await openWithTheme('dark')
    try {
      await page.goto(FILE_URL)
      await page.locator('.app').waitFor()
      await expectComputedStyle(page, 'body', { backgroundColor: '#1a1a1e' })
    } finally { await context.close() }
  })

  it('axe: returns impact-filtered violations', async () => {
    const { context, page } = await openWithTheme('light')
    try {
      await page.goto(FILE_URL)
      await page.locator('.app').waitFor()
      const all = await runAxe(page, { minImpact: 'minor' })
      const critical = await runAxe(page, { impacts: ['critical'] })
      assert.ok(Array.isArray(all))
      assert.ok(critical.every((v) => v.impact === 'critical'), formatViolations(critical))
      assert.ok(critical.length <= all.length)
      assert.equal(typeof formatViolations(all), 'string')
    } finally { await context.close() }
  })

  it('network: records the scripts a page loads', async () => {
    const { context, page } = await openWithTheme('light')
    try {
      const rec = recordScripts(page)
      await page.goto(FILE_URL, { waitUntil: 'networkidle' })
      assert.ok(rec.urls().length > 0)
      assert.ok(rec.loaded('/src/main.ts') || rec.loaded(/\/assets\/index-/), rec.summary())
      // #6: the editor is lazy — the read view of a local doc loads no CodeMirror…
      assert.ok(!rec.loaded(/codemirror/i), rec.summary())
      // …and switching to Edit loads it.
      await page.locator('[data-testid="view-toggle-edit"]').click()
      await page.locator('.cm-editor:visible .cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
      rec.stop()
      assert.ok(rec.loaded(/codemirror/i), rec.summary())
      assert.ok(rec.chunks().every((c) => !c.includes('/')))
    } finally { await context.close() }
  })

  it('screens: captureMatrix writes PNGs and an index', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'md-review-screens-'))
    try {
      const index = await captureMatrix({
        browser, base: BASE, api: API, outDir,
        targets: [{ name: 'local', url: '/?filePath={FIXTURE}' }, { name: 'shared', url: '/#shared={SHARED_ID}' }],
        themes: ['github-dark'], viewports: ['phone'],
      })
      assert.equal(index.shots.length, 2)
      for (const s of index.shots) {
        assert.equal(s.error, undefined, s.error)
        const png = readFileSync(join(outDir, s.file))
        assert.equal(png.subarray(1, 4).toString(), 'PNG')
      }
      assert.ok(existsSync(join(outDir, 'local', 'github-dark-phone.png')))
      assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf-8')).themes, ['github-dark'])
    } finally { rmSync(outDir, { recursive: true, force: true }) }
  })
})
