// AC-08.11 (Split half) — deferred by #8 until split view (#7) existed
// (tests/e2e/items/08-undo-redo.test.mjs keeps it as `todo: 'needs #7'`; that
// file is frozen, so the real test lives here and is gated with #7).
//
// Given the user types KEEPME in Edit view and switches to Split (and, in the
// other direction, types in Split and switches to Edit or Read and back) When
// Ctrl/Cmd+Z is pressed Then KEEPME is removed — the editor's history survives
// every view switch (#8 rule 7, #7 decision "hidden tab pane stays mounted").
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE } from '../helpers.mjs'

const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const BASIC = '# Undo doc\n\nFirst paragraph.\n'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac08-split-'))
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

let seq = 0
function localDocUrl(text, query = '') {
  const p = join(tmp, `undo-split-${++seq}.md`)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}${query}`
}

async function open(viewport = { width: 1400, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page }
}

/** The visible editor's text, joined from its rendered lines (short docs: every line is rendered). */
const editorText = (page) => page.evaluate(() => {
  const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
  return ed ? [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n') : null
})

async function waitEditorText(page, pred, message) {
  const deadline = Date.now() + 5000
  for (;;) {
    const t = await editorText(page)
    if (t !== null && pred(t)) return t
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${message}; editor: ${JSON.stringify(t)}` })
    await new Promise((r) => setTimeout(r, 50))
  }
}

const visibleEditor = (page) => page.locator('.cm-editor:visible .cm-content').first()

async function typeAtEnd(page, text) {
  await visibleEditor(page).click()
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type(text)
}

describe('AC-08.11 (Split) undo survives switches into and out of Split view', () => {
  it('AC-08.11 (Split) typing in Edit view, switch to Split: Ctrl/Cmd+Z removes the typing', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl(BASIC, '&view=edit'))
      await visibleEditor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await typeAtEnd(page, 'KEEPME')
      await waitEditorText(page, (t) => t === BASIC + 'KEEPME', 'typed text')
      await page.locator(tid('view-toggle-split')).click({ timeout: 5000 })
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(`${tid('split-pane-editor')} .cm-content`).focus()
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC, 'KEEPME removed in Split view')
    } finally { await context.close() }
  })

  it('AC-08.11 (Split) typing in Split view, switch to Read and back to Split: Ctrl/Cmd+Z removes the typing', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl(BASIC, '&view=split'))
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
      await typeAtEnd(page, 'KEEPME')
      await waitEditorText(page, (t) => t === BASIC + 'KEEPME', 'typed text')
      await page.locator(tid('view-toggle-read')).click()
      await page.waitForFunction(() => ![...document.querySelectorAll('.cm-editor')].some((e) => e.getClientRects().length > 0), null, { timeout: 5000 })
      await page.locator(tid('view-toggle-split')).click()
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(`${tid('split-pane-editor')} .cm-content`).focus()
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC, 'KEEPME removed after Split → Read → Split')
    } finally { await context.close() }
  })

  it('AC-08.11 (Split) typing in Split view, switch to Edit: Ctrl/Cmd+Z removes the typing', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl(BASIC, '&view=split'))
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
      await typeAtEnd(page, 'KEEPME')
      await waitEditorText(page, (t) => t === BASIC + 'KEEPME', 'typed text')
      await page.locator(tid('view-toggle-edit')).click()
      await page.waitForFunction(() => !document.querySelector('[data-testid="split-view"]'), null, { timeout: 5000 })
      await visibleEditor(page).focus()
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC, 'KEEPME removed after Split → Edit')
    } finally { await context.close() }
  })
})
