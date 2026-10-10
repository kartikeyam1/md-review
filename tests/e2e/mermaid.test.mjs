import { chromium } from 'playwright'
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from './helpers.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = resolve(__dirname, 'fixture.md')
const FILE_URL = `${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`

let browser, context, page

/** Open the fixture and wait until the document has rendered. */
async function openFixture() {
  await page.goto(FILE_URL)
  await page.locator('[data-testid="doc-title"]', { hasText: 'fixture.md' }).waitFor({ timeout: 10000 })
  await page.locator('.preview-pane .mermaid').first().waitFor({ state: 'attached', timeout: 10000 })
}

/** Wait for mermaid's async render to put an SVG in the block (quietly: callers assert). */
const waitForMermaidSvg = (timeout = 10000) =>
  page.locator('.preview-pane .mermaid svg').first().waitFor({ state: 'attached', timeout }).catch(() => {})

before(async () => {
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
})

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  page = await context.newPage()
})

describe('mermaid diagram rendering', () => {
  it('renders mermaid code block as SVG in preview', async () => {
    await openFixture()

    // Scroll to the mermaid diagram area
    const mermaidContainer = page.locator('.preview-pane .mermaid')
    await mermaidContainer.scrollIntoViewIfNeeded()
    await waitForMermaidSvg()

    // Mermaid should have rendered an SVG inside the container
    const svg = mermaidContainer.locator('svg')
    const svgCount = await svg.count()
    assert.ok(svgCount > 0, 'Mermaid block should contain a rendered SVG')
  })

  it('mermaid block has line data attributes for commenting', async () => {
    await openFixture()

    const mermaidContainer = page.locator('.preview-pane .mermaid').first()
    const hasLineStart = await mermaidContainer.evaluate(
      (el) => el.closest('[data-line-start]')?.hasAttribute('data-line-start') ?? false
    )
    assert.ok(hasLineStart, 'Mermaid container or parent should have data-line-start')
  })

  it('re-renders mermaid with dark theme when toggling dark mode', async () => {
    await openFixture()

    const mermaidContainer = page.locator('.preview-pane .mermaid')
    await mermaidContainer.scrollIntoViewIfNeeded()
    await waitForMermaidSvg()

    // Capture SVG markup in light mode
    const lightSvg = await mermaidContainer.locator('svg').first().evaluate(
      (el) => el.innerHTML
    )

    // Toggle dark mode
    await page.click('.btn-icon')
    // Wait for the dark re-render: an SVG whose markup differs from the light one.
    await page.waitForFunction((light) => {
      const svg = document.querySelector('.preview-pane .mermaid svg')
      return !!svg && svg.innerHTML !== light
    }, lightSvg, { timeout: 10000 }).catch(() => {})

    // SVG should have been re-rendered (mermaid dark theme)
    const svgAfter = mermaidContainer.locator('svg')
    assert.ok(await svgAfter.count() > 0, 'SVG should still exist after theme toggle')

    const darkSvg = await svgAfter.first().evaluate(
      (el) => el.innerHTML
    )
    // Mermaid dark theme generates different fill colors / styles
    assert.notEqual(lightSvg, darkSvg, 'Mermaid SVG content should change in dark mode')
  })

  it('does not render non-mermaid code blocks as diagrams', async () => {
    await openFixture()
    // Let mermaid finish rendering first, so a wrongly-rendered python block would have its SVG by now.
    await waitForMermaidSvg()

    // Python code block should NOT have mermaid class
    const pythonPre = page.locator('.preview-pane pre code.language-python')
    const count = await pythonPre.count()
    assert.ok(count > 0, 'Python code block should exist')

    // It should not contain an SVG
    const pythonSvg = page.locator('.preview-pane pre code.language-python svg')
    assert.equal(await pythonSvg.count(), 0, 'Python block should not have SVG')
  })
})
