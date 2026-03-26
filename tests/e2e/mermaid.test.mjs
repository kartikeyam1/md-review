import { chromium } from 'playwright'
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = resolve(__dirname, 'fixture.md')
const BASE = 'http://localhost:58747'
const FILE_URL = `${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`

let browser, context, page

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
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Scroll to the mermaid diagram area
    const mermaidContainer = page.locator('.preview-pane .mermaid')
    await mermaidContainer.scrollIntoViewIfNeeded()
    await page.waitForTimeout(1000)

    // Mermaid should have rendered an SVG inside the container
    const svg = mermaidContainer.locator('svg')
    const svgCount = await svg.count()
    assert.ok(svgCount > 0, 'Mermaid block should contain a rendered SVG')
  })

  it('mermaid block has line data attributes for commenting', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    const mermaidContainer = page.locator('.preview-pane .mermaid').first()
    const hasLineStart = await mermaidContainer.evaluate(
      (el) => el.closest('[data-line-start]')?.hasAttribute('data-line-start') ?? false
    )
    assert.ok(hasLineStart, 'Mermaid container or parent should have data-line-start')
  })

  it('does not render non-mermaid code blocks as diagrams', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Python code block should NOT have mermaid class
    const pythonPre = page.locator('.preview-pane pre code.language-python')
    const count = await pythonPre.count()
    assert.ok(count > 0, 'Python code block should exist')

    // It should not contain an SVG
    const pythonSvg = page.locator('.preview-pane pre code.language-python svg')
    assert.equal(await pythonSvg.count(), 0, 'Python block should not have SVG')
  })
})
