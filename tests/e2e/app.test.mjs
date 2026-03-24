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

// ── File loading via URL param ────────────────────────────────

describe('file loading via ?filePath=', () => {
  it('auto-loads file into edit mode', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    const hasEditor = await page.locator('.cm-editor').count()
    assert.ok(hasEditor > 0, 'Editor should be visible')
    const filename = await page.locator('.filename').textContent()
    assert.ok(filename.includes('fixture.md'))
  })

  it('shows upload screen without filePath param', async () => {
    await page.goto(BASE)
    await page.waitForTimeout(1000)
    const uploadArea = await page.locator('.upload-area').count()
    assert.ok(uploadArea > 0 || (await page.locator('.paste-area').count()) > 0, 'Upload screen should show')
  })
})

// ── Dark mode ─────────────────────────────────────────────────

describe('dark mode', () => {
  it('toggles dark class on html element', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    await page.click('.btn-icon')
    await page.waitForTimeout(300)
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    assert.ok(isDark, 'Should have dark class after toggle')

    await page.click('.btn-icon')
    await page.waitForTimeout(300)
    const isLight = await page.evaluate(() => !document.documentElement.classList.contains('dark'))
    assert.ok(isLight, 'Should remove dark class after second toggle')
  })

  it('editor selection uses themed color in dark mode', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    // Switch to dark
    await page.click('.btn-icon')
    await page.waitForTimeout(300)

    // Select first line
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)

    const selBg = await page.evaluate(() => {
      const sel = document.querySelector('.cm-selectionBackground')
      return sel ? window.getComputedStyle(sel).backgroundColor : null
    })
    assert.ok(selBg, 'Selection background should exist')
    // Must NOT be the default lavender rgb(215, 212, 240)
    assert.ok(!selBg.includes('215'), `Selection should not be default lavender, got: ${selBg}`)
  })

  it('editor gutter uses CSS variable, not hardcoded color', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    // Light mode gutter
    const lightGutter = await page.evaluate(() => {
      const g = document.querySelector('.cm-gutters')
      return g ? window.getComputedStyle(g).color : null
    })
    // Switch to dark
    await page.click('.btn-icon')
    await page.waitForTimeout(300)
    const darkGutter = await page.evaluate(() => {
      const g = document.querySelector('.cm-gutters')
      return g ? window.getComputedStyle(g).color : null
    })
    assert.notEqual(lightGutter, darkGutter, 'Gutter color should differ between light and dark')
  })
})

// ── Code block commenting in preview ──────────────────────────

describe('code block commenting in preview', () => {
  it('code blocks have line data attributes for commenting', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    // Switch to preview
    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // Find the <pre> element
    const pre = page.locator('.preview-pane pre').first()
    await pre.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)

    // Verify the pre has data-line-start/data-line-end attributes
    const hasLineStart = await pre.evaluate((el) => el.hasAttribute('data-line-start'))
    assert.ok(hasLineStart, 'Code block <pre> should have data-line-start attribute')

    const hasLineEnd = await pre.evaluate((el) => el.hasAttribute('data-line-end'))
    assert.ok(hasLineEnd, 'Code block <pre> should have data-line-end attribute')

    // Verify line numbers are reasonable
    const lineStart = await pre.evaluate((el) => parseInt(el.getAttribute('data-line-start')))
    const lineEnd = await pre.evaluate((el) => parseInt(el.getAttribute('data-line-end')))
    assert.ok(lineStart >= 0, `data-line-start should be >= 0, got ${lineStart}`)
    assert.ok(lineEnd > lineStart, `data-line-end (${lineEnd}) should be > data-line-start (${lineStart})`)
  })

  it('shows popover when selecting text inside a code block', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const pre = page.locator('.preview-pane pre').first()
    await pre.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)

    // Use triple-click to reliably select a line inside the code block
    const codeEl = page.locator('.preview-pane pre code').first()
    await codeEl.click({ clickCount: 3 })
    await page.waitForTimeout(800)

    const popover = page.locator('.popover')
    const popoverVisible = await popover.isVisible().catch(() => false)
    assert.ok(popoverVisible, 'Popover should appear when selecting text in code block')
  })
})

// ── Empty popover dismissal ───────────────────────────────────

describe('popover dismissal', () => {
  it('dismisses empty popover when clicking outside', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Select text to trigger popover
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)

    const popoverBefore = await page.locator('.popover').isVisible().catch(() => false)
    assert.ok(popoverBefore, 'Popover should be visible after selection')

    // Click outside the popover (on the sidebar)
    await page.locator('.sidebar').click({ position: { x: 50, y: 200 } })
    await page.waitForTimeout(500)

    const popoverAfter = await page.locator('.popover').isVisible().catch(() => false)
    assert.ok(!popoverAfter, 'Empty popover should dismiss when clicking outside')
  })

  it('keeps popover open when clicking outside if body has text', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Select text to trigger popover
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)

    // Type something in the popover textarea
    await page.locator('.popover textarea').fill('work in progress')
    await page.waitForTimeout(200)

    // Click outside
    await page.locator('.sidebar').click({ position: { x: 50, y: 200 } })
    await page.waitForTimeout(500)

    const popoverAfter = await page.locator('.popover').isVisible().catch(() => false)
    assert.ok(popoverAfter, 'Popover with text should stay open when clicking outside')
  })
})

// ── Comment categories ────────────────────────────────────────

describe('comment categories', () => {
  it('shows category buttons in popover and includes tag in sidebar', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Select text
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)

    // Verify category buttons exist
    const categoryBtns = await page.locator('.popover .category-btn').count()
    assert.ok(categoryBtns >= 4, `Should have at least 4 category buttons, got ${categoryBtns}`)

    // Pick "Must Fix"
    await page.click('.popover .category-btn:has-text("Must Fix")')
    await page.waitForTimeout(100)

    // Add comment
    await page.locator('.popover textarea').fill('This needs fixing')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    // Verify category tag appears in sidebar
    const tag = await page.locator('.category-tag').first().textContent()
    assert.ok(tag.trim() === 'Must Fix', `Category tag should say "Must Fix", got "${tag.trim()}"`)
  })

  it('includes category in generated prompt', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Add a comment with category
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.click('.popover .category-btn:has-text("Nit")')
    await page.locator('.popover textarea').fill('Minor issue')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    // Open prompt modal
    await page.click('button:has-text("Generate Prompt")')
    await page.waitForTimeout(500)

    const promptText = await page.locator('.prompt-text').textContent()
    assert.ok(promptText.includes('[nit]'), `Prompt should contain [nit] tag, got: ${promptText.substring(0, 200)}`)

    await page.click('.modal .btn-ghost') // close
  })
})

// ── Comment editing ───────────────────────────────────────────

describe('comment editing', () => {
  it('can edit a comment body via Edit button', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Add a comment
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.locator('.popover textarea').fill('Original text')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    // Hover and click Edit
    const card = page.locator('.comment-card').first()
    await card.hover()
    await page.waitForTimeout(200)
    await card.locator('.comment-action-btn:has-text("Edit")').click()
    await page.waitForTimeout(300)

    // Verify edit textarea appears
    const editInput = page.locator('.edit-input')
    assert.ok(await editInput.isVisible(), 'Edit textarea should appear')

    // Change text and save
    await editInput.fill('Updated text')
    await page.click('.edit-actions .btn-primary')
    await page.waitForTimeout(300)

    const body = await page.locator('.comment-body').first().textContent()
    assert.ok(body.includes('Updated text'), `Comment should be updated, got: "${body}"`)
  })
})

// ── Category filter ───────────────────────────────────────────

describe('category filter', () => {
  it('filters comments by category', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Add two comments with different categories
    const lines = page.locator('.cm-line')

    await lines.nth(0).click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.click('.popover .category-btn:has-text("Nit")')
    await page.locator('.popover textarea').fill('A nit')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    await lines.nth(4).click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.click('.popover .category-btn:has-text("Must Fix")')
    await page.locator('.popover textarea').fill('A must fix')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    // Both should be visible
    const allCount = await page.locator('.comment-card').count()
    assert.ok(allCount >= 2, `Should have at least 2 comments, got ${allCount}`)

    // Filter to "Nit" only
    await page.click('.filter-btn:has-text("Nit")')
    await page.waitForTimeout(300)
    const nitCount = await page.locator('.comment-card').count()
    assert.equal(nitCount, 1, 'Should show only 1 nit comment')

    // Clear filter
    await page.click('.filter-btn:has-text("Nit")')
    await page.waitForTimeout(300)
    const allAgain = await page.locator('.comment-card').count()
    assert.ok(allAgain >= 2, 'Should show all comments again after clearing filter')
  })
})

// ── New document resets URL ───────────────────────────────────

describe('new document', () => {
  it('clears filePath query param from URL', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Verify URL has filePath
    let url = page.url()
    assert.ok(url.includes('filePath'), 'URL should have filePath param initially')

    // Click New
    await page.click('button:has-text("New")')
    await page.waitForTimeout(500)

    url = page.url()
    assert.ok(!url.includes('filePath'), `URL should not have filePath after New, got: ${url}`)
  })

  it('returns to upload screen', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("New")')
    await page.waitForTimeout(500)

    const uploadVisible = await page.locator('.upload-area').isVisible().catch(() => false)
    assert.ok(uploadVisible, 'Should show upload screen after New')
  })
})

// ── Paste / blank document ────────────────────────────────────

describe('paste and blank document', () => {
  it('can start with a blank document', async () => {
    await page.goto(BASE)
    await page.waitForTimeout(1000)

    await page.click('button:has-text("Start blank")')
    await page.waitForTimeout(1000)

    const hasEditor = await page.locator('.cm-editor').count()
    assert.ok(hasEditor > 0, 'Editor should appear after starting blank')
    const filename = await page.locator('.filename').textContent()
    assert.ok(filename.includes('untitled.md'))
  })

  it('can paste markdown and review it', async () => {
    await page.goto(BASE)
    await page.waitForTimeout(1000)

    await page.click('button:has-text("Paste markdown")')
    await page.waitForTimeout(300)

    const pasteArea = page.locator('.paste-input')
    assert.ok(await pasteArea.isVisible(), 'Paste textarea should appear')

    await pasteArea.fill('# Pasted Title\n\nSome pasted content')
    await page.click('button:has-text("Start Review")')
    await page.waitForTimeout(1000)

    const hasEditor = await page.locator('.cm-editor').count()
    assert.ok(hasEditor > 0, 'Editor should appear after pasting')
    const filename = await page.locator('.filename').textContent()
    assert.ok(filename.includes('pasted.md'))
  })
})

// ── Table rendering in preview ────────────────────────────────

describe('table rendering', () => {
  it('renders tables with proper styling', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const table = page.locator('.preview-pane table').first()
    await table.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)

    const display = await table.evaluate((el) => window.getComputedStyle(el).display)
    assert.ok(display === 'table', `Table should have display:table, got: ${display}`)

    const hasLineData = await table.evaluate((el) => el.hasAttribute('data-line-start'))
    assert.ok(hasLineData, 'Table should have data-line-start for commenting')
  })
})

// ── Code block contrast ───────────────────────────────────────

describe('code block contrast', () => {
  it('code blocks are visually distinct from preview background', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const previewBg = await page.evaluate(() => {
      const p = document.querySelector('.preview-pane')
      return p ? window.getComputedStyle(p).backgroundColor : null
    })
    const codeBg = await page.evaluate(() => {
      const pre = document.querySelector('.preview-pane pre')
      return pre ? window.getComputedStyle(pre).backgroundColor : null
    })
    assert.ok(previewBg && codeBg, 'Both backgrounds should exist')
    assert.notEqual(previewBg, codeBg, `Code bg (${codeBg}) should differ from preview bg (${previewBg})`)
  })

  it('code blocks have contrast in dark mode too', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('.btn-icon') // dark mode
    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const previewBg = await page.evaluate(() => {
      const p = document.querySelector('.preview-pane')
      return p ? window.getComputedStyle(p).backgroundColor : null
    })
    const codeBg = await page.evaluate(() => {
      const pre = document.querySelector('.preview-pane pre')
      return pre ? window.getComputedStyle(pre).backgroundColor : null
    })
    assert.notEqual(previewBg, codeBg, `Dark mode: code bg (${codeBg}) should differ from preview bg (${previewBg})`)
  })
})

// ── Popover viewport clamping ────────────────────────────────

describe('popover viewport clamping', () => {
  it('clamps popover when selection is near the right edge', async () => {
    // Use a narrow viewport to force right-edge overflow
    const narrowContext = await browser.newContext({ viewport: { width: 800, height: 900 } })
    const narrowPage = await narrowContext.newPage()
    await narrowPage.goto(FILE_URL)
    await narrowPage.waitForTimeout(2000)

    // Select text in the editor
    await narrowPage.locator('.cm-line').first().click({ clickCount: 3 })
    await narrowPage.waitForTimeout(500)

    const popover = narrowPage.locator('.popover')
    const isVisible = await popover.isVisible().catch(() => false)
    assert.ok(isVisible, 'Popover should appear')

    // Verify the popover right edge does not exceed viewport
    const box = await popover.boundingBox()
    assert.ok(box, 'Popover should have a bounding box')
    assert.ok(
      box.x + box.width <= 800,
      `Popover right edge (${box.x + box.width}) should not exceed viewport width (800)`
    )
    assert.ok(box.x >= 0, `Popover left edge (${box.x}) should not be negative`)

    await narrowContext.close()
  })

  it('clamps popover when selection is near the bottom edge', async () => {
    // Use a short viewport so the popover would overflow the bottom
    const shortContext = await browser.newContext({ viewport: { width: 1400, height: 400 } })
    const shortPage = await shortContext.newPage()
    await shortPage.goto(FILE_URL)
    await shortPage.waitForTimeout(2000)

    // Select a line further down to push coords near the bottom
    const lines = shortPage.locator('.cm-line')
    const lineCount = await lines.count()
    // Pick one of the later lines
    const targetIdx = Math.min(lineCount - 1, 6)
    await lines.nth(targetIdx).scrollIntoViewIfNeeded()
    await shortPage.waitForTimeout(200)
    await lines.nth(targetIdx).click({ clickCount: 3 })
    await shortPage.waitForTimeout(500)

    const popover = shortPage.locator('.popover')
    const isVisible = await popover.isVisible().catch(() => false)
    if (isVisible) {
      const box = await popover.boundingBox()
      assert.ok(box, 'Popover should have a bounding box')
      assert.ok(
        box.y + box.height <= 400,
        `Popover bottom (${box.y + box.height}) should not exceed viewport height (400)`
      )
      assert.ok(box.y >= 0, `Popover top (${box.y}) should not be negative`)
    }

    await shortContext.close()
  })

  it('popover stays within bounds in preview mode too', async () => {
    const narrowContext = await browser.newContext({ viewport: { width: 700, height: 900 } })
    const narrowPage = await narrowContext.newPage()
    await narrowPage.goto(FILE_URL)
    await narrowPage.waitForTimeout(2000)

    await narrowPage.click('button:has-text("Preview")')
    await narrowPage.waitForTimeout(500)

    // Select text in the first paragraph
    const paragraph = narrowPage.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await narrowPage.waitForTimeout(500)

    const popover = narrowPage.locator('.popover')
    const isVisible = await popover.isVisible().catch(() => false)
    if (isVisible) {
      const box = await popover.boundingBox()
      assert.ok(box, 'Popover should have a bounding box')
      assert.ok(
        box.x + box.width <= 700,
        `Preview popover right edge (${box.x + box.width}) should not exceed 700`
      )
    }

    await narrowContext.close()
  })
})

// ── Export/Import comments (JSON sidecar) ────────────────────

describe('export/import comments', () => {
  it('shows import button in sidebar and export button when comments exist', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Import button should always be visible
    const importBtn = page.locator('.sidebar-action-btn[title*="Import"]')
    assert.ok(await importBtn.isVisible(), 'Import button should be visible')

    // Export button should not be visible with no comments
    const exportBtn = page.locator('.sidebar-action-btn[title*="Export"]')
    const exportVisible = await exportBtn.isVisible().catch(() => false)
    assert.ok(!exportVisible, 'Export button should be hidden with no comments')

    // Add a comment
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.locator('.popover textarea').fill('Test comment for export')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    // Export button should now be visible
    const exportVisibleNow = await exportBtn.isVisible().catch(() => false)
    assert.ok(exportVisibleNow, 'Export button should appear after adding a comment')
  })

  it('exports comments as JSON and re-imports them', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Add two comments
    const lines = page.locator('.cm-line')
    await lines.nth(0).click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.click('.popover .category-btn:has-text("Must Fix")')
    await page.locator('.popover textarea').fill('First comment')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    await lines.nth(4).click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.locator('.popover textarea').fill('Second comment')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    assert.equal(await page.locator('.comment-card').count(), 2, 'Should have 2 comments')

    // Intercept the download triggered by export
    const downloadPromise = page.waitForEvent('download')
    await page.click('.sidebar-action-btn[title*="Export"]')
    const download = await downloadPromise

    // Verify filename
    const suggestedName = download.suggestedFilename()
    assert.ok(
      suggestedName.endsWith('.comments.json'),
      `Download name should end with .comments.json, got: ${suggestedName}`
    )

    // Read the downloaded content
    const downloadPath = await download.path()
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(downloadPath, 'utf-8')
    const data = JSON.parse(content)

    // Validate structure
    assert.ok(data.version === 1, 'Export should have version: 1')
    assert.ok(data.filename.includes('fixture'), `Export filename should include fixture, got: ${data.filename}`)
    assert.ok(data.exportedAt, 'Export should have exportedAt timestamp')
    assert.ok(Array.isArray(data.comments), 'Export should have comments array')
    assert.equal(data.comments.length, 2, 'Export should have 2 comments')
    assert.ok(data.comments[0].body, 'Each comment should have a body')
    assert.ok(typeof data.comments[0].startLine === 'number', 'Each comment should have startLine')
    assert.ok(data.comments[0].category, 'Each comment should have a category')

    // Now clear and import — click "New" to reset, then re-open the file
    await page.click('button:has-text("New")')
    await page.waitForTimeout(500)

    // Navigate back to the fixture
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)
    assert.equal(await page.locator('.comment-card').count(), 0, 'Should start with 0 comments')

    // Import the downloaded file
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.click('.sidebar-action-btn[title*="Import"]')
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(downloadPath)
    await page.waitForTimeout(500)

    // Verify comments were imported
    const importedCount = await page.locator('.comment-card').count()
    assert.equal(importedCount, 2, `Should have 2 imported comments, got ${importedCount}`)

    // Verify comment content survived round-trip
    const firstBody = await page.locator('.comment-body').first().textContent()
    const allBodies = await page.locator('.comment-body').allTextContents()
    const hasFirst = allBodies.some(b => b.includes('First comment'))
    const hasSecond = allBodies.some(b => b.includes('Second comment'))
    assert.ok(hasFirst, 'Imported comments should include "First comment"')
    assert.ok(hasSecond, 'Imported comments should include "Second comment"')

    // Verify category survived round-trip
    const tags = await page.locator('.category-tag').allTextContents()
    const hasMustFix = tags.some(t => t.trim() === 'Must Fix')
    assert.ok(hasMustFix, 'Must Fix category should survive export/import round-trip')
  })

  it('import replaces existing comments', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Add one comment
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(500)
    await page.locator('.popover textarea').fill('Will be replaced')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.comment-card').count(), 1)

    // Create a JSON file with different comments to import
    const importData = JSON.stringify({
      version: 1,
      filename: 'test.md',
      comments: [
        { id: 'imp-1', startLine: 0, endLine: 1, selectedText: 'Test', body: 'Imported A', category: 'nit', createdAt: 1 },
        { id: 'imp-2', startLine: 2, endLine: 3, selectedText: 'Doc', body: 'Imported B', category: 'question', createdAt: 2 },
        { id: 'imp-3', startLine: 4, endLine: 5, selectedText: 'More', body: 'Imported C', category: 'suggestion', createdAt: 3 },
      ]
    })

    // Write temp file for import
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const tmpFile = path.join(os.tmpdir(), 'test-import.json')
    await fs.writeFile(tmpFile, importData)

    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.click('.sidebar-action-btn[title*="Import"]')
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(tmpFile)
    await page.waitForTimeout(500)

    // Should have 3 comments (replaced the 1 that existed)
    const count = await page.locator('.comment-card').count()
    assert.equal(count, 3, `Should have 3 imported comments replacing the original, got ${count}`)

    const bodies = await page.locator('.comment-body').allTextContents()
    assert.ok(!bodies.some(b => b.includes('Will be replaced')), 'Original comment should be gone')
    assert.ok(bodies.some(b => b.includes('Imported A')), 'Imported A should exist')

    await fs.unlink(tmpFile).catch(() => {})
  })
})

// ── Syntax highlighting in code blocks ───────────────────────

describe('syntax highlighting', () => {
  it('applies hljs classes to fenced code blocks in preview', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // The fixture has ```python with "print" which hljs should highlight
    const hljsSpans = await page.locator('.preview-pane pre code span[class*="hljs-"]').count()
    assert.ok(hljsSpans > 0, `Should have hljs-highlighted spans in code block, got ${hljsSpans}`)
  })

  it('hljs tokens have non-default colors', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // Find a highlighted span and check it has a color set
    const span = page.locator('.preview-pane pre code span[class*="hljs-"]').first()
    const color = await span.evaluate((el) => window.getComputedStyle(el).color)
    assert.ok(color, 'hljs span should have a computed color')
  })

  it('hljs works in dark mode too', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('.btn-icon') // dark mode
    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const hljsSpans = await page.locator('.preview-pane pre code span[class*="hljs-"]').count()
    assert.ok(hljsSpans > 0, 'hljs spans should exist in dark mode too')
  })
})

// ── Task list checkboxes ─────────────────────────────────────

describe('task list checkboxes', () => {
  it('renders task list items with checkboxes in preview', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // The fixture has - [x] and - [ ] items
    const checkboxes = await page.locator('.preview-pane input[type="checkbox"]').count()
    assert.ok(checkboxes >= 2, `Should have at least 2 checkboxes, got ${checkboxes}`)
  })

  it('checked items are visually distinct', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const checked = page.locator('.preview-pane input[type="checkbox"][checked]').first()
    const isChecked = await checked.count()
    assert.ok(isChecked > 0, 'Should have at least one checked checkbox')
  })

  it('task list items have no bullet markers', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const listStyle = await page.locator('.preview-pane .contains-task-list').first().evaluate(
      (el) => window.getComputedStyle(el).listStyleType
    )
    assert.equal(listStyle, 'none', `Task list should have list-style: none, got: ${listStyle}`)
  })
})

// ── h4/h5/h6 styling ────────────────────────────────────────

describe('h4/h5/h6 styling', () => {
  it('h4 renders with heading font', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const h4 = page.locator('.preview-pane h4').first()
    const fontFamily = await h4.evaluate((el) => window.getComputedStyle(el).fontFamily)
    assert.ok(fontFamily.includes('Crimson'), `h4 should use Crimson Pro, got: ${fontFamily}`)
  })

  it('h6 renders as uppercase', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const h6 = page.locator('.preview-pane h6').first()
    const transform = await h6.evaluate((el) => window.getComputedStyle(el).textTransform)
    assert.equal(transform, 'uppercase', `h6 should be uppercase, got: ${transform}`)
  })

  it('heading sizes decrease from h4 to h6', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const h4Size = await page.locator('.preview-pane h4').first().evaluate(
      (el) => parseFloat(window.getComputedStyle(el).fontSize)
    )
    const h5Size = await page.locator('.preview-pane h5').first().evaluate(
      (el) => parseFloat(window.getComputedStyle(el).fontSize)
    )
    const h6Size = await page.locator('.preview-pane h6').first().evaluate(
      (el) => parseFloat(window.getComputedStyle(el).fontSize)
    )
    assert.ok(h4Size > h5Size, `h4 (${h4Size}) should be larger than h5 (${h5Size})`)
    assert.ok(h5Size > h6Size, `h5 (${h5Size}) should be larger than h6 (${h6Size})`)
  })
})

// ── Word count ───────────────────────────────────────────────

describe('word count', () => {
  it('shows word and character counts when document is loaded', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    const stats = page.locator('.doc-stats')
    assert.ok(await stats.isVisible(), 'Doc stats should be visible')

    const text = await stats.textContent()
    assert.ok(text.includes('words'), `Stats should contain "words", got: ${text}`)
    assert.ok(text.includes('chars'), `Stats should contain "chars", got: ${text}`)
  })

  it('word count is non-zero for loaded document', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    const text = await page.locator('.doc-stats').textContent()
    // Extract the number before "words"
    const match = text.match(/(\d[\d,]*)\s*words/)
    assert.ok(match, `Should find word count in stats, got: ${text}`)
    const count = parseInt(match[1].replace(/,/g, ''), 10)
    assert.ok(count > 0, `Word count should be > 0, got ${count}`)
  })

  it('does not show stats on upload screen', async () => {
    await page.goto(BASE)
    await page.waitForTimeout(1000)

    const stats = await page.locator('.doc-stats').count()
    assert.equal(stats, 0, 'Doc stats should not be visible on upload screen')
  })

  it('updates count when document is edited', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    const before = await page.locator('.doc-stats').textContent()
    const beforeMatch = before.match(/(\d[\d,]*)\s*words/)
    const beforeCount = parseInt(beforeMatch[1].replace(/,/g, ''), 10)

    // Type additional text in the editor
    await page.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type('\n\nExtra words added here for testing the count')
    await page.waitForTimeout(500)

    const after = await page.locator('.doc-stats').textContent()
    const afterMatch = after.match(/(\d[\d,]*)\s*words/)
    const afterCount = parseInt(afterMatch[1].replace(/,/g, ''), 10)

    assert.ok(afterCount > beforeCount, `Word count should increase: ${beforeCount} → ${afterCount}`)
  })
})

// ── Selection preserved when popover opens ───────────────────

describe('selection preserved when popover opens', () => {
  it('popover shows selected text in editor mode', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Triple-click to select a line in the editor
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(800)

    // Popover should be visible
    const popover = page.locator('.popover')
    assert.ok(await popover.isVisible(), 'Popover should appear after selection')

    // The popover quote should contain the selected text (not be empty)
    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Popover quote should not be empty, got: "${quote}"`)
  })

  it('popover shows selected text in preview mode', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    // Triple-click on the first paragraph to select it
    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(800)

    const popover = page.locator('.popover')
    assert.ok(await popover.isVisible(), 'Popover should appear in preview mode')

    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Popover quote should not be empty, got: "${quote}"`)
  })

  it('can submit comment after selection (selection data not lost)', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Select text in editor
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(800)

    // Type a comment and submit
    await page.locator('.popover textarea').fill('Test comment')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    // Verify comment was added to the sidebar
    const commentBody = await page.locator('.comment-body').first().textContent()
    assert.ok(commentBody.includes('Test comment'), `Comment should be added, got: "${commentBody}"`)

    // Verify the comment has a non-empty selected text quote
    const quote = await page.locator('.comment-quote').first().textContent()
    assert.ok(quote && quote.trim().length > 2, `Comment quote should have selected text, got: "${quote}"`)
  })

  it('selected text survives popover textarea focus', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Select text
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(800)

    // Click inside the popover textarea (triggers focus)
    await page.locator('.popover textarea').click()
    await page.waitForTimeout(300)

    // The popover quote should still show the selected text
    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Selected text should survive textarea focus, got: "${quote}"`)

    // Should still be able to submit a comment
    await page.locator('.popover textarea').fill('After focus test')
    await page.click('.popover .btn-primary')
    await page.waitForTimeout(500)

    const commentCount = await page.locator('.comment-card').count()
    assert.ok(commentCount >= 1, 'Comment should be added even after textarea focus')
  })

  it('editor keeps CM selection highlight visible after popover textarea focus', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // Select a line in the editor
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.waitForTimeout(800)

    // Popover should be visible (its textarea has auto-focus)
    assert.ok(await page.locator('.popover').isVisible(), 'Popover should be open')

    // Check that .cm-selectionBackground elements still exist (visual highlight)
    const selBgCount = await page.locator('.cm-selectionBackground').count()
    assert.ok(selBgCount > 0, 'cm-selectionBackground should still be rendered when popover is open')
  })

  it('preview mode: native browser selection persists when popover opens', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    await page.click('button:has-text("Preview")')
    await page.waitForTimeout(500)

    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await page.waitForTimeout(800)

    // The native selection must still be active (not collapsed by textarea focus)
    const sel = await page.evaluate(() => {
      const s = window.getSelection()
      return { text: (s?.toString() || '').trim(), collapsed: s?.isCollapsed }
    })
    assert.ok(!sel.collapsed, 'Native selection should NOT be collapsed after popover opens')
    assert.ok(sel.text.length > 0, `Native selection text should be non-empty, got: "${sel.text}"`)

    // Popover quote must match
    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Popover must retain selected text, got: "${quote}"`)

    // Clicking the textarea to type will clear native selection — that's fine
    // because the user explicitly decided to start typing
    await page.locator('.popover textarea').click()
    await page.waitForTimeout(300)
    const quoteAfter = await page.locator('.popover-quote').textContent()
    assert.equal(quoteAfter, quote, 'Popover quote must not change after textarea click')
  })

  it('second selection replaces first and popover updates', async () => {
    await page.goto(FILE_URL)
    await page.waitForTimeout(2000)

    // First selection
    const lines = page.locator('.cm-line')
    await lines.nth(0).click({ clickCount: 3 })
    await page.waitForTimeout(800)

    const firstQuote = await page.locator('.popover-quote').textContent()
    assert.ok(firstQuote && firstQuote.trim().length > 0, 'First selection should show in popover')

    // Click away to dismiss the empty popover
    await page.locator('.sidebar').click({ position: { x: 50, y: 200 } })
    await page.waitForTimeout(500)

    // Second selection on a different line
    await lines.nth(4).click({ clickCount: 3 })
    await page.waitForTimeout(800)

    const secondQuote = await page.locator('.popover-quote').textContent()
    assert.ok(secondQuote && secondQuote.trim().length > 0, 'Second selection should show in popover')
  })
})
