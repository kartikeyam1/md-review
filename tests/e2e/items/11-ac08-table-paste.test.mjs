// #8's deferred AC-08.5 table-paste half, run now that #11 has landed (tests/e2e/items/08-undo-redo.test.mjs
// keeps it as `todo: 'needs #11'`; that frozen file is not edited). Same steps and assertions as there (the doc is
// opened through the dev `?filePath=` loader directly instead of that file's openLocal helper):
// a pasted TSV is two undo steps — undo 1 → the raw pasted text, undo 2 → the pre-paste text (00 §3.6).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE } from '../helpers.mjs'

const T = { timeout: 60_000 }
const MOD = 'ControlOrMeta'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac08-11-'))
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()

async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    if (!ed) return null
    return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')
  })
}

async function waitEditorText(page, pred, message, timeout = 5000) {
  const deadline = Date.now() + timeout
  let seen
  for (;;) {
    seen = await editorText(page)
    if (seen !== null && pred(seen)) return seen
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${message}\n  editor text: ${JSON.stringify(seen)}` })
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function paste(page, text) {
  await editorContent(page).evaluate((el, t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

describe('#8 undo/redo — AC-08.5 table paste (needs #11)', () => {
  it('AC-08.5 (table paste) undo 1 → the raw pasted TSV, undo 2 → the pre-paste text', T, async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    try {
      const doc = '# Paste\n\n'
      const tsv = 'Name\tQty\nApple\t3\nPear\t12'
      const p = join(tmp, 'paste.md')
      writeFileSync(p, doc)
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(p)}`)
      await page.locator('.preview-pane, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
      if (!(await page.locator('.cm-editor:visible .cm-content').count())) {
        await page.locator('[data-testid="view-toggle-edit"]').first().click()
        await editorContent(page).waitFor({ state: 'visible', timeout: 20_000 })
      }
      await editorContent(page).click()
      await page.keyboard.press(`${MOD}+End`)
      await paste(page, tsv)
      await waitEditorText(page, (t) => t.includes('| Name'), 'the formatted table')

      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === doc + tsv, 'undo 1 → the raw TSV')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === doc, 'undo 2 → the pre-paste text')
    } finally { await context.close() }
  })
})
