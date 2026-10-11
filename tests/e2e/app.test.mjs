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

/** Click the action bar's Comment button to open the full popover */
async function clickCommentAction(p = page) {
  const bar = p.locator('.selection-action-bar .action-btn')
  await bar.waitFor({ state: 'visible', timeout: 3000 })
  await bar.click()
  const popover = p.locator('.popover')
  await popover.waitFor({ state: 'visible' })
  // The popover measures itself after mounting and then clamps into the
  // viewport: wait until its box holds still for a few frames (cap 2 s).
  await popover.evaluate((el) => new Promise((resolve) => {
    const key = () => { const r = el.getBoundingClientRect(); return `${r.x},${r.y},${r.width},${r.height}` }
    let last = key(), still = 0
    const t0 = performance.now()
    const tick = () => {
      const k = key()
      still = k === last ? still + 1 : 0
      last = k
      if (still >= 3 || performance.now() - t0 > 2000) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
}

/** Switch from default preview mode to edit mode */
async function switchToEdit(p = page) {
  await p.click('button:has-text("Edit")')
  // #6: the editor is lazy-loaded — wait for it to mount before typing.
  await p.locator('.cm-editor:visible .cm-content').first().waitFor({ state: 'visible', timeout: 20000 })
  await p.locator('.cm-editor:visible .cm-line').first().waitFor({ state: 'visible' })
}

/** Wait until the ?filePath= fixture has loaded and rendered. */
async function waitForFixture(p = page) {
  await p.locator('[data-testid="doc-title"]', { hasText: 'Test Document' }).waitFor()
  await p.locator('.preview-pane [data-line-start]').first().waitFor()
}

/** Wait until the upload screen is up. */
async function waitForUpload(p = page) {
  await p.locator('.upload-area, .paste-area').first().waitFor()
}

/** Let CSS transitions in flight finish (capped at 1 s; animations are ignored). */
async function settleTransitions(p = page) {
  await p.evaluate(async () => {
    const done = document.getAnimations()
      .filter((a) => a instanceof CSSTransition)
      .map((a) => a.finished.then(() => {}, () => {}))
    await Promise.race([Promise.all(done), new Promise((r) => setTimeout(r, 1000))])
  })
}

/** Click the theme toggle; wait for <html>'s classes to change and the restyle to settle. */
async function cycleTheme(p = page) {
  const before = await p.evaluate(() => document.documentElement.className)
  await p.click('.btn-icon')
  await p.waitForFunction((b) => document.documentElement.className !== b, before)
  await settleTransitions(p)
}

/** Poll an in-page condition; the assertion that follows still decides. */
async function until(p, cond, arg) {
  await p.waitForFunction(cond, arg, { timeout: 5000 }).catch(() => {})
}

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
  it('auto-loads file into preview mode', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    const hasPreview = await page.locator('.preview-pane').count()
    assert.ok(hasPreview > 0, 'Preview pane should be visible')
    const filename = await page.locator('[data-testid="doc-title"]').textContent()
    // #5 docTitle (00 §5): the H1 of fixture.md, not the filename
    assert.ok(filename.includes('Test Document'))
  })

  it('shows upload screen without filePath param', async () => {
    await page.goto(BASE)
    await waitForUpload(page)
    const uploadArea = await page.locator('.upload-area').count()
    assert.ok(uploadArea > 0 || (await page.locator('.paste-area').count()) > 0, 'Upload screen should show')
  })
})

// ── Dark mode ─────────────────────────────────────────────────

describe('dark mode', () => {
  it('toggles dark class on html element', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await cycleTheme(page)
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    assert.ok(isDark, 'Should have dark class after toggle')

    // Second click: back to light (#1: the toggle flips dark within the style, no cycling into GitHub)
    await cycleTheme(page)
    const isLight = await page.evaluate(() =>
      !document.documentElement.classList.contains('dark') &&
      !document.documentElement.classList.contains('github-theme')
    )
    assert.ok(isLight, 'Second click should return to light (no dark, no github-theme)')
  })

  it('editor selection uses themed color in dark mode', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()
    // Switch to dark
    await cycleTheme(page)

    // Select first line
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await page.locator('.cm-selectionBackground').first().waitFor({ state: 'attached' })
    await settleTransitions()

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
    await waitForFixture(page)
    await switchToEdit()
    // Light mode gutter
    const lightGutter = await page.evaluate(() => {
      const g = document.querySelector('.cm-gutters')
      return g ? window.getComputedStyle(g).color : null
    })
    // Switch to dark
    await cycleTheme(page)
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
    await waitForFixture(page)
    // Switch to preview
    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    // Find the <pre> element
    const pre = page.locator('.preview-pane pre').first()
    await pre.scrollIntoViewIfNeeded()

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
    await waitForFixture(page)
    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const pre = page.locator('.preview-pane pre').first()
    await pre.scrollIntoViewIfNeeded()

    // Use triple-click to reliably select a line inside the code block
    const codeEl = page.locator('.preview-pane pre code').first()
    await codeEl.click({ clickCount: 3 })
    await clickCommentAction()

    const popover = page.locator('.popover')
    const popoverVisible = await popover.isVisible().catch(() => false)
    assert.ok(popoverVisible, 'Popover should appear when selecting text in code block')
  })
})

// ── Empty popover dismissal ───────────────────────────────────

describe('popover dismissal', () => {
  it('dismisses empty popover when clicking outside', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Select text to trigger popover
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    const popoverBefore = await page.locator('.popover').isVisible().catch(() => false)
    assert.ok(popoverBefore, 'Popover should be visible after selection')

    // Click outside the popover (on the sidebar)
    await page.locator('.sidebar').click({ position: { x: 50, y: 200 } })
    await page.locator('.popover').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})

    const popoverAfter = await page.locator('.popover').isVisible().catch(() => false)
    assert.ok(!popoverAfter, 'Empty popover should dismiss when clicking outside')
  })

  it('keeps popover open when clicking outside if body has text', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Select text to trigger popover
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    // Type something in the popover textarea
    await page.locator('.popover textarea').fill('work in progress')

    // Click outside
    await page.locator('.sidebar').click({ position: { x: 50, y: 200 } })
    // Negative assertion (the popover must NOT close): keep a bounded wait so a
    // deferred dismissal would still be caught.
    await page.waitForTimeout(500)

    const popoverAfter = await page.locator('.popover').isVisible().catch(() => false)
    assert.ok(popoverAfter, 'Popover with text should stay open when clicking outside')
  })
})

// ── Comment categories ────────────────────────────────────────

describe('comment categories', () => {
  it('shows category buttons in popover and includes tag in sidebar', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Select text
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    // Verify category buttons exist
    const categoryBtns = await page.locator('.popover .category-btn').count()
    assert.ok(categoryBtns >= 4, `Should have at least 4 category buttons, got ${categoryBtns}`)

    // Pick "Must Fix"
    await page.click('.popover .category-btn:has-text("Must Fix")')

    // Add comment
    await page.locator('.popover textarea').fill('This needs fixing')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    // Verify category tag appears in sidebar
    const tag = await page.locator('.category-tag').first().textContent()
    assert.ok(tag.trim() === 'Must Fix', `Category tag should say "Must Fix", got "${tag.trim()}"`)
  })

  it('includes category in generated prompt', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Add a comment with category
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()
    await page.click('.popover .category-btn:has-text("Nit")')
    await page.locator('.popover textarea').fill('Minor issue')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    // Open prompt modal
    await page.click('[data-testid="header-overflow-btn"]')
    await page.click('[data-testid="menu-generate-prompt"]')
    await page.locator('.prompt-text').waitFor()

    const promptText = await page.locator('.prompt-text').textContent()
    assert.ok(promptText.includes('[nit]'), `Prompt should contain [nit] tag, got: ${promptText.substring(0, 200)}`)

    await page.click('.modal .btn-ghost') // close
  })
})

// ── Comment editing ───────────────────────────────────────────

describe('comment editing', () => {
  it('can edit a comment body via Edit button', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Add a comment
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()
    await page.locator('.popover textarea').fill('Original text')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    // Hover and click Edit
    const card = page.locator('.comment-card').first()
    await card.hover()
    await card.locator('.comment-action-btn:has-text("Edit")').click()
    await page.locator('.edit-input').waitFor({ timeout: 5000 }).catch(() => {})

    // Verify edit textarea appears
    const editInput = page.locator('.edit-input')
    assert.ok(await editInput.isVisible(), 'Edit textarea should appear')

    // Change text and save
    await editInput.fill('Updated text')
    await page.click('.edit-actions .btn-primary')
    await until(page, () => document.querySelector('.comment-body')?.textContent.includes('Updated text'))

    const body = await page.locator('.comment-body').first().textContent()
    assert.ok(body.includes('Updated text'), `Comment should be updated, got: "${body}"`)
  })
})

// ── Category filter ───────────────────────────────────────────

describe('category filter', () => {
  it('filters comments by category', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Add two comments with different categories
    const lines = page.locator('.cm-line')

    await lines.nth(0).click({ clickCount: 3 })
    await clickCommentAction()
    await page.click('.popover .category-btn:has-text("Nit")')
    await page.locator('.popover textarea').fill('A nit')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    await lines.nth(4).click({ clickCount: 3 })
    await clickCommentAction()
    await page.click('.popover .category-btn:has-text("Must Fix")')
    await page.locator('.popover textarea').fill('A must fix')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    // Both should be visible
    const allCount = await page.locator('.comment-card').count()
    assert.ok(allCount >= 2, `Should have at least 2 comments, got ${allCount}`)

    // Filter to "Nit" only
    await page.click('.filter-btn:has-text("Nit")')
    await until(page, () => document.querySelectorAll('.comment-card').length === 1)
    const nitCount = await page.locator('.comment-card').count()
    assert.equal(nitCount, 1, 'Should show only 1 nit comment')

    // Clear filter
    await page.click('.filter-btn:has-text("Nit")')
    await until(page, () => document.querySelectorAll('.comment-card').length >= 2)
    const allAgain = await page.locator('.comment-card').count()
    assert.ok(allAgain >= 2, 'Should show all comments again after clearing filter')
  })
})

// ── New document resets URL ───────────────────────────────────

describe('new document', () => {
  it('clears filePath query param from URL', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    // Verify URL has filePath
    let url = page.url()
    assert.ok(url.includes('filePath'), 'URL should have filePath param initially')

    // Click New
    await page.click('[data-testid="header-overflow-btn"]')
    await page.click('[data-testid="menu-new-doc"]')
    await page.waitForURL((u) => !u.href.includes('filePath'), { timeout: 5000 }).catch(() => {})

    url = page.url()
    assert.ok(!url.includes('filePath'), `URL should not have filePath after New, got: ${url}`)
  })

  it('returns to upload screen', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="header-overflow-btn"]')
    await page.click('[data-testid="menu-new-doc"]')
    await page.locator('.upload-area').waitFor({ timeout: 5000 }).catch(() => {})

    const uploadVisible = await page.locator('.upload-area').isVisible().catch(() => false)
    assert.ok(uploadVisible, 'Should show upload screen after New')
  })
})

// ── Paste / blank document ────────────────────────────────────

describe('paste and blank document', () => {
  it('can start with a blank document', async () => {
    await page.goto(BASE)
    await waitForUpload(page)

    await page.click('button:has-text("Start blank")')
    await page.locator('[data-testid="doc-title"]').waitFor({ timeout: 5000 }).catch(() => {})

    const hasPreview = await page.locator('.preview-pane').count()
    assert.ok(hasPreview > 0, 'Preview pane should appear after starting blank')
    const filename = await page.locator('[data-testid="doc-title"]').textContent()
    // #5 docTitle (00 §5): an empty doc falls back to the filename without its extension
    assert.ok(filename.includes('untitled'))
  })

  it('can paste markdown and review it', async () => {
    await page.goto(BASE)
    await waitForUpload(page)

    await page.click('button:has-text("Paste markdown")')
    await page.locator('.paste-input').waitFor({ timeout: 5000 }).catch(() => {})

    const pasteArea = page.locator('.paste-input')
    assert.ok(await pasteArea.isVisible(), 'Paste textarea should appear')

    await pasteArea.fill('# Pasted Title\n\nSome pasted content')
    await page.click('button:has-text("Open document")')
    await page.locator('[data-testid="doc-title"]').waitFor({ timeout: 5000 }).catch(() => {})

    const hasPreview = await page.locator('.preview-pane').count()
    assert.ok(hasPreview > 0, 'Preview pane should appear after pasting')
    const filename = await page.locator('[data-testid="doc-title"]').textContent()
    // #5 docTitle (00 §5): the pasted doc's H1
    assert.ok(filename.includes('Pasted Title'))
  })
})

// ── Table rendering in preview ────────────────────────────────

describe('table rendering', () => {
  it('renders tables with proper styling', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const table = page.locator('.preview-pane table').first()
    await table.scrollIntoViewIfNeeded()

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
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

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
    await waitForFixture(page)

    await cycleTheme(page) // dark mode
    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

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
    await waitForFixture(narrowPage)

    // Switch to edit mode, then select text
    await switchToEdit(narrowPage)
    await narrowPage.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction(narrowPage)

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
    await waitForFixture(shortPage)

    // Switch to edit mode, select a line further down
    await switchToEdit(shortPage)
    const lines = shortPage.locator('.cm-line')
    const lineCount = await lines.count()
    // Pick one of the later lines
    const targetIdx = Math.min(lineCount - 1, 6)
    await lines.nth(targetIdx).scrollIntoViewIfNeeded()
    await lines.nth(targetIdx).click({ clickCount: 3 })
    await clickCommentAction(shortPage)

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
    await waitForFixture(narrowPage)

    await narrowPage.click('[data-testid="view-toggle-read"]')
    await narrowPage.locator('.preview-pane').waitFor()

    // Select text in the first paragraph
    const paragraph = narrowPage.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await clickCommentAction(narrowPage)

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
    await waitForFixture(page)
    await switchToEdit()

    // Import button should always be visible
    const importBtn = page.locator('.sidebar-action-btn[title*="Import"]')
    assert.ok(await importBtn.isVisible(), 'Import button should be visible')

    // Export button should not be visible with no comments
    const exportBtn = page.locator('.sidebar-action-btn[title*="Export"]')
    const exportVisible = await exportBtn.isVisible().catch(() => false)
    assert.ok(!exportVisible, 'Export button should be hidden with no comments')

    // Add a comment
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()
    await page.locator('.popover textarea').fill('Test comment for export')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    // Export button should now be visible
    const exportVisibleNow = await exportBtn.isVisible().catch(() => false)
    assert.ok(exportVisibleNow, 'Export button should appear after adding a comment')
  })

  it('exports comments as JSON and re-imports them', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Add two comments
    const lines = page.locator('.cm-line')
    await lines.nth(0).click({ clickCount: 3 })
    await clickCommentAction()
    await page.click('.popover .category-btn:has-text("Must Fix")')
    await page.locator('.popover textarea').fill('First comment')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    await lines.nth(4).click({ clickCount: 3 })
    await clickCommentAction()
    await page.locator('.popover textarea').fill('Second comment')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

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
    await page.click('[data-testid="header-overflow-btn"]')
    await page.click('[data-testid="menu-new-doc"]')
    await page.locator('.upload-area').waitFor()

    // Navigate back to the fixture
    await page.goto(FILE_URL)
    await waitForFixture(page)
    assert.equal(await page.locator('.comment-card').count(), 0, 'Should start with 0 comments')

    // Import the downloaded file
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.click('.sidebar-action-btn[title*="Import"]')
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(downloadPath)
    await until(page, () => document.querySelectorAll('.comment-card').length === 2)

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
    await waitForFixture(page)
    await switchToEdit()

    // Add one comment
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()
    await page.locator('.popover textarea').fill('Will be replaced')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })
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
    await until(page, () => document.querySelectorAll('.comment-card').length === 3)

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
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    // The fixture has ```python with "print" which hljs should highlight
    const hljsSpans = await page.locator('.preview-pane pre code span[class*="hljs-"]').count()
    assert.ok(hljsSpans > 0, `Should have hljs-highlighted spans in code block, got ${hljsSpans}`)
  })

  it('hljs tokens have non-default colors', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    // Find a highlighted span and check it has a color set
    const span = page.locator('.preview-pane pre code span[class*="hljs-"]').first()
    const color = await span.evaluate((el) => window.getComputedStyle(el).color)
    assert.ok(color, 'hljs span should have a computed color')
  })

  it('hljs works in dark mode too', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await cycleTheme(page) // dark mode
    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const hljsSpans = await page.locator('.preview-pane pre code span[class*="hljs-"]').count()
    assert.ok(hljsSpans > 0, 'hljs spans should exist in dark mode too')
  })
})

// ── Task list checkboxes ─────────────────────────────────────

describe('task list checkboxes', () => {
  it('renders task list items with checkboxes in preview', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    // The fixture has - [x] and - [ ] items
    const checkboxes = await page.locator('.preview-pane input[type="checkbox"]').count()
    assert.ok(checkboxes >= 2, `Should have at least 2 checkboxes, got ${checkboxes}`)
  })

  it('checked items are visually distinct', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const checked = page.locator('.preview-pane input[type="checkbox"][checked]').first()
    const isChecked = await checked.count()
    assert.ok(isChecked > 0, 'Should have at least one checked checkbox')
  })

  it('task list items have no bullet markers', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

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
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const h4 = page.locator('.preview-pane h4').first()
    const fontFamily = await h4.evaluate((el) => window.getComputedStyle(el).fontFamily)
    assert.ok(fontFamily.includes('Crimson'), `h4 should use Crimson Pro, got: ${fontFamily}`)
  })

  it('h6 renders as uppercase', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const h6 = page.locator('.preview-pane h6').first()
    const transform = await h6.evaluate((el) => window.getComputedStyle(el).textTransform)
    assert.equal(transform, 'uppercase', `h6 should be uppercase, got: ${transform}`)
  })

  it('heading sizes decrease from h4 to h6', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

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
    await waitForFixture(page)
    // Counts live in the editor header (#2 rule 5): switch to the edit view.
    await switchToEdit()

    const stats = page.locator('.doc-stats')
    assert.ok(await stats.isVisible(), 'Doc stats should be visible')

    const text = await stats.textContent()
    assert.ok(text.includes('words'), `Stats should contain "words", got: ${text}`)
    assert.ok(text.includes('chars'), `Stats should contain "chars", got: ${text}`)
  })

  it('word count is non-zero for loaded document', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    const text = await page.locator('.doc-stats').textContent()
    // Extract the number before "words"
    const match = text.match(/(\d[\d,]*)\s*words/)
    assert.ok(match, `Should find word count in stats, got: ${text}`)
    const count = parseInt(match[1].replace(/,/g, ''), 10)
    assert.ok(count > 0, `Word count should be > 0, got ${count}`)
  })

  it('does not show stats on upload screen', async () => {
    await page.goto(BASE)
    await waitForUpload(page)

    const stats = await page.locator('.doc-stats').count()
    assert.equal(stats, 0, 'Doc stats should not be visible on upload screen')
  })

  it('updates count when document is edited', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    const before = await page.locator('.doc-stats').textContent()
    const beforeMatch = before.match(/(\d[\d,]*)\s*words/)
    const beforeCount = parseInt(beforeMatch[1].replace(/,/g, ''), 10)

    // Type additional text in the editor
    await page.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type('\n\nExtra words added here for testing the count')
    await until(page, (b) => document.querySelector('.doc-stats')?.textContent !== b, before)

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
    await waitForFixture(page)
    await switchToEdit()

    // Triple-click to select a line in the editor
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    // Popover should be visible
    const popover = page.locator('.popover')
    assert.ok(await popover.isVisible(), 'Popover should appear after selection')

    // The popover quote should contain the selected text (not be empty)
    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Popover quote should not be empty, got: "${quote}"`)
  })

  it('popover shows selected text in preview mode', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    // Triple-click on the first paragraph to select it
    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    await clickCommentAction()

    const popover = page.locator('.popover')
    assert.ok(await popover.isVisible(), 'Popover should appear in preview mode')

    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Popover quote should not be empty, got: "${quote}"`)
  })

  it('can submit comment after selection (selection data not lost)', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Select text in editor
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    // Type a comment and submit
    await page.locator('.popover textarea').fill('Test comment')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    // Verify comment was added to the sidebar
    const commentBody = await page.locator('.comment-body').first().textContent()
    assert.ok(commentBody.includes('Test comment'), `Comment should be added, got: "${commentBody}"`)

    // Verify the comment has a non-empty selected text quote
    const quote = await page.locator('.comment-quote').first().textContent()
    assert.ok(quote && quote.trim().length > 2, `Comment quote should have selected text, got: "${quote}"`)
  })

  it('selected text survives popover textarea focus', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Select text
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    // Click inside the popover textarea (triggers focus)
    await page.locator('.popover textarea').click()
    // Negative assertion (the quote must NOT clear): selectionchange fires
    // asynchronously, so keep a bounded wait for a late clear to land.
    await page.waitForTimeout(300)

    // The popover quote should still show the selected text
    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Selected text should survive textarea focus, got: "${quote}"`)

    // Should still be able to submit a comment
    await page.locator('.popover textarea').fill('After focus test')
    await page.click('.popover .btn-primary')
    await page.locator('.popover').waitFor({ state: 'hidden' })

    const commentCount = await page.locator('.comment-card').count()
    assert.ok(commentCount >= 1, 'Comment should be added even after textarea focus')
  })

  it('editor keeps CM selection highlight visible after popover textarea focus', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // Select a line in the editor
    await page.locator('.cm-line').first().click({ clickCount: 3 })
    await clickCommentAction()

    // Popover should be visible (its textarea has auto-focus)
    assert.ok(await page.locator('.popover').isVisible(), 'Popover should be open')

    // Check that .cm-selectionBackground elements still exist (visual highlight)
    const selBgCount = await page.locator('.cm-selectionBackground').count()
    assert.ok(selBgCount > 0, 'cm-selectionBackground should still be rendered when popover is open')
  })

  it('preview mode: native browser selection persists when popover opens', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()

    const paragraph = page.locator('.preview-pane p').first()
    await paragraph.click({ clickCount: 3 })
    // The action bar appearing is what could collapse the selection: wait for
    // it, then a couple of frames for any reaction to it to land.
    await page.locator('.selection-action-bar .action-btn').waitFor()
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

    // The native selection must still be active (not collapsed by action bar appearing)
    const sel = await page.evaluate(() => {
      const s = window.getSelection()
      return { text: (s?.toString() || '').trim(), collapsed: s?.isCollapsed }
    })
    assert.ok(!sel.collapsed, 'Native selection should NOT be collapsed after action bar shows')
    assert.ok(sel.text.length > 0, `Native selection text should be non-empty, got: "${sel.text}"`)

    // Now click Comment in the action bar to open the popover
    await clickCommentAction()

    // Popover quote must match
    const quote = await page.locator('.popover-quote').textContent()
    assert.ok(quote && quote.trim().length > 0, `Popover must retain selected text, got: "${quote}"`)

    // Clicking the textarea to type will clear native selection — that's fine
    // because the user explicitly decided to start typing
    await page.locator('.popover textarea').click()
    // Negative assertion (the quote must NOT change): bounded wait, as above.
    await page.waitForTimeout(300)
    const quoteAfter = await page.locator('.popover-quote').textContent()
    assert.equal(quoteAfter, quote, 'Popover quote must not change after textarea click')
  })

  it('second selection replaces first and popover updates', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)
    await switchToEdit()

    // First selection
    const lines = page.locator('.cm-line')
    await lines.nth(0).click({ clickCount: 3 })
    await clickCommentAction()

    const firstQuote = await page.locator('.popover-quote').textContent()
    assert.ok(firstQuote && firstQuote.trim().length > 0, 'First selection should show in popover')

    // Click away to dismiss the empty popover
    await page.locator('.sidebar').click({ position: { x: 50, y: 200 } })
    await page.locator('.popover').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})

    // Second selection on a different line
    await lines.nth(4).click({ clickCount: 3 })
    await clickCommentAction()

    const secondQuote = await page.locator('.popover-quote').textContent()
    assert.ok(secondQuote && secondQuote.trim().length > 0, 'Second selection should show in popover')
  })
})

// ── Theme toggle + Style menu (#1) ───────────────────────────

/** #1: pick a style from the header Style menu (Default / GitHub / Locus). */
async function chooseThemeStyle(style) {
  await page.click('[data-testid="theme-style-menu"]')
  await page.click(`[data-testid="theme-style-option"][data-style="${style}"]`)
  // useTheme sets github-theme / locus-theme on <html> per style.
  await until(page, (st) => {
    const c = document.documentElement.classList
    return st === 'github' ? c.contains('github-theme')
      : st === 'locus' ? c.contains('locus-theme')
      : !c.contains('github-theme') && !c.contains('locus-theme')
  }, style)
  await settleTransitions(page)
}

const htmlThemeState = () => page.evaluate(() => ({
  dark: document.documentElement.classList.contains('dark'),
  github: document.documentElement.classList.contains('github-theme'),
}))

describe('theme toggle and style menu', () => {
  it('toggle flips light/dark within a style; the Style menu switches style and keeps the dark flag', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    let html = await htmlThemeState()
    assert.ok(!html.dark && !html.github, 'Should start in light mode')

    await cycleTheme(page)
    html = await htmlThemeState()
    assert.ok(html.dark && !html.github, 'After 1 toggle: dark mode')

    await cycleTheme(page)
    html = await htmlThemeState()
    assert.ok(!html.dark && !html.github, 'After 2 toggles: back to light (no cycling into GitHub)')

    await chooseThemeStyle('github')
    html = await htmlThemeState()
    assert.ok(!html.dark && html.github, 'Style GitHub from light: github-light')
    const markdownBody = await page.locator('.preview-pane.markdown-body').count()
    assert.ok(markdownBody > 0, 'github-light: preview-pane should have markdown-body class')

    await cycleTheme(page)
    html = await htmlThemeState()
    assert.ok(html.dark && html.github, 'Toggle in GitHub: github-dark')

    await chooseThemeStyle('default')
    html = await htmlThemeState()
    assert.ok(html.dark && !html.github, 'Style Default from github-dark keeps dark')
  })

  it('markdown-body class absent in non-github themes', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    // light
    let count = await page.locator('.preview-pane.markdown-body').count()
    assert.equal(count, 0, 'light: no markdown-body class')

    // dark
    await cycleTheme(page)
    count = await page.locator('.preview-pane.markdown-body').count()
    assert.equal(count, 0, 'dark: no markdown-body class')
  })

  it('github theme persists across page reload', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    // github-light via the Style menu
    await chooseThemeStyle('github')

    const githubClass = await page.evaluate(() =>
      document.documentElement.classList.contains('github-theme')
    )
    assert.ok(githubClass, 'Should be in github-theme before reload')

    // Reload
    await page.reload()
    await waitForFixture(page)

    const afterReload = await page.evaluate(() =>
      document.documentElement.classList.contains('github-theme')
    )
    assert.ok(afterReload, 'github-theme class should persist after reload')
  })

  it('mermaid renders in github-dark theme', async () => {
    await page.goto(FILE_URL)
    await waitForFixture(page)

    const mermaidEl = page.locator('.preview-pane .mermaid')
    const hasMermaid = await mermaidEl.count()
    if (hasMermaid === 0) return // fixture has no mermaid block

    await mermaidEl.first().scrollIntoViewIfNeeded()
    await mermaidEl.first().locator('svg').waitFor()

    const lightSvg = await mermaidEl.first().locator('svg').evaluate(el => el.innerHTML)

    // github-dark: Style menu → GitHub, then the toggle
    await chooseThemeStyle('github') // → github-light
    await cycleTheme(page) // → github-dark
    await until(page, (light) => document.querySelector('.preview-pane .mermaid svg')?.innerHTML !== light, lightSvg)

    const darkSvg = await mermaidEl.first().locator('svg').evaluate(el => el.innerHTML)
    assert.notEqual(lightSvg, darkSvg, 'Mermaid SVG should differ in github-dark mode')
  })
})
