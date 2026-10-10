// #11 Format a pasted table (+ "format table" command, plain-text paste) — acceptance tests
// (docs/build/specs/11-table-paste.md, 00 §3.1 toast, §3.5 keys, §3.6 undo: a pasted table is two
// undo steps — raw paste, then pre-paste).
//
// Pastes are synthetic: one ClipboardEvent('paste') with a DataTransfer carrying text/plain (and,
// for the Excel case, a PNG file) dispatched on the visible editor — what a real Ctrl/Cmd+V delivers.
// The plain-text chord is a real key press (Ctrl/Cmd+Shift+V reaches the editor's keydown) followed
// by that synthetic paste, since headless Chromium has no system clipboard to paste from.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE } from '../helpers.mjs'
import { createDoc, uniq } from '../lib/docs.mjs'

const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const TSV = 'Name\tQty\nApple\t3\nPear\t12'
const TABLE = '| Name  | Qty |\n| ----- | --: |\n| Apple |   3 |\n| Pear  |  12 |'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac11-'))
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function open({ viewport = { width: 1400, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  page.on('dialog', (d) => d.accept().catch(() => {}))
  const uploads = []
  page.on('request', (r) => { if (r.method() === 'POST' && /\/files$/.test(new URL(r.url()).pathname)) uploads.push(r.url()) })
  return { context, page, errors, uploads }
}

let seq = 0
async function openLocal(page, text, name = `tbl-${++seq}.md`) {
  const p = join(tmp, name)
  writeFileSync(p, text)
  await page.goto(`${BASE}/?filePath=${encodeURIComponent(p)}`)
  await page.locator('.preview-pane, .html-frame, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
  await toEdit(page)
}

const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()

async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await page.locator(tid('view-toggle-edit')).first().click()
  await editorContent(page).waitFor({ state: 'visible', timeout: 20_000 })
}

async function toRead(page) {
  await page.locator(tid('view-toggle-read')).first().click()
  await page.locator('.preview-pane').first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    if (!ed) return null
    return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')
  })
}

async function until(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${message}` })
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function waitEditorText(page, pred, message, timeout = 5000) {
  let seen
  try {
    await until(async () => { seen = await editorText(page); return seen !== null && pred(seen) }, { timeout, message })
  } catch (e) {
    throw new assert.AssertionError({ message: `${e.message}\n  editor text: ${JSON.stringify(seen)}` })
  }
  return seen
}

/** The text after things settle (two equal reads 250 ms apart). */
async function settled(page) {
  let prev = await editorText(page)
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const now = await editorText(page)
    if (now === prev) return now
    prev = now
  }
  return prev
}

async function caretToEnd(page) {
  await editorContent(page).click()
  await page.keyboard.press(`${MOD}+End`)
}

/** Put the caret right after the first occurrence of `needle` in the line containing it. */
async function caretAfter(page, needle) {
  await editorContent(page).evaluate((el, needle) => {
    for (const line of el.querySelectorAll('.cm-line')) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let acc = ''
      const nodes = []
      while (walker.nextNode()) { nodes.push([walker.currentNode, acc.length]); acc += walker.currentNode.data }
      const i = acc.indexOf(needle)
      if (i < 0) continue
      const end = i + needle.length
      for (const [node, start] of nodes) {
        if (end <= start + node.data.length) {
          const sel = getSelection()
          const r = document.createRange()
          r.setStart(node, end - start); r.collapse(true)
          sel.removeAllRanges(); sel.addRange(r)
          return
        }
      }
    }
    throw new Error(`not found: ${needle}`)
  }, needle)
  await new Promise((r) => setTimeout(r, 100))
}

async function paste(page, text, { files = [] } = {}) {
  await editorContent(page).evaluate((el, { text, files }) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }))
    if (text) dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, { text, files })
}

/** Ctrl/Cmd+Shift+V, then the paste it triggers. */
async function plainPaste(page, text) {
  await page.keyboard.press(`${MOD}+Shift+V`)
  await paste(page, text)
}

const tableToast = (page) => page.locator(`${tid('app-toast')}[data-kind="info"]`).filter({ hasText: 'Pasted as table' })

describe('#11 paste as table', () => {
  it('AC-11.1 TSV into an empty doc → the exact aligned table; preview has 2 th and 2 body rows; info toast', T, async () => {
    const { context, page, errors } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await paste(page, TSV)
      const text = await waitEditorText(page, (t) => t.startsWith('| Name'), 'the table')
      assert.ok(text === TABLE || text === TABLE + '\n', `exact table, got ${JSON.stringify(text)}`)
      await tableToast(page).first().waitFor({ state: 'visible', timeout: 3000 })
      const toastText = await tableToast(page).first().textContent()
      assert.match(toastText, /Pasted as table · (Ctrl|Cmd)\+Shift\+V to paste as plain text/)
      await toRead(page)
      await page.locator('.preview-pane table').first().waitFor({ timeout: 5000 })
      assert.equal(await page.locator('.preview-pane table th').count(), 2)
      assert.equal(await page.locator('.preview-pane table tbody tr').count(), 2)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-11.2 undo 1 → the raw TSV (caret at its end), undo 2 → empty; redo re-applies each in one step', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await paste(page, TSV)
      await waitEditorText(page, (t) => t.startsWith('| Name'), 'the table')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === TSV, 'undo 1 → raw TSV')
      // The caret sits at the end of the raw text: typing appends there.
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === '', 'undo 2 → empty')
      // Redo with Mod+Y: Playwright's repeated Shift+z presses can arrive as key "z" (= Mod+Z, undo).
      await page.keyboard.press(`${MOD}+y`)
      await waitEditorText(page, (t) => t === TSV, 'redo 1 → raw TSV')
      await page.keyboard.press(`${MOD}+y`)
      await waitEditorText(page, (t) => t.startsWith('| Name'), 'redo 2 → the table')
    } finally { await context.close() }
  })

  it('AC-11.2 the raw step leaves the caret at the end of the raw text; neither step merges with typing', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await page.keyboard.type('x')
      await paste(page, TSV)
      await waitEditorText(page, (t) => t.includes('| Name'), 'the table')
      await page.keyboard.type('y')
      await waitEditorText(page, (t) => t.endsWith('y'), 'typed after')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t.includes('| Name') && !t.endsWith('y'), 'undo the typing only')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === 'x' + TSV, 'undo → raw text')
      await page.keyboard.type('Z')
      await waitEditorText(page, (t) => t === 'x' + TSV + 'Z', 'the caret was at the end of the raw text')
    } finally { await context.close() }
  })

  it('AC-11.3 Ctrl/Cmd+Shift+V pastes the raw text with tabs, no table toast; the next normal paste converts again', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await plainPaste(page, TSV)
      await waitEditorText(page, (t) => t === TSV, 'verbatim TSV')
      assert.equal(await settled(page), TSV, 'still verbatim (tabs kept)')
      assert.equal(await tableToast(page).count(), 0, 'no "Pasted as table" toast')
      await page.keyboard.press(`${MOD}+a`)
      await page.keyboard.press('Delete')
      await waitEditorText(page, (t) => t === '', 'cleared')
      await paste(page, TSV)
      await waitEditorText(page, (t) => t.startsWith('| Name'), 'a normal paste converts again')
    } finally { await context.close() }
  })

  it('the plain-text chord also skips the image path (no upload) and the SVG special case', T, async () => {
    const { context, page, uploads } = await open()
    try {
      await openLocal(page, '# P\n\n')
      await caretToEnd(page)
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
      await plainPaste(page, svg)
      await waitEditorText(page, (t) => t === '# P\n\n' + svg, 'svg pasted verbatim at the caret')
      await page.keyboard.press(`${MOD}+Shift+V`)
      await paste(page, '', { files: [{ name: 'image.png', type: 'image/png', b64: PNG_1x1 }] })
      await new Promise((r) => setTimeout(r, 500))
      assert.equal(uploads.length, 0, 'no upload')
      assert.equal(await page.locator(`${tid('share-required-dialog')}:visible`).count(), 0, 'no share prompt either')
    } finally { await context.close() }
  })

  it('AC-11.4 the quoted CSV example → cells Smith, J / said "hi" / a\\|b; preview shows 3 columns with a|b', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await paste(page, 'id,name,note\n1,"Smith, J","said ""hi"""\n2,Lee,a|b')
      const text = await waitEditorText(page, (t) => /^\| +id \|/.test(t), 'the table')
      const lines = text.split('\n')
      assert.ok(lines[2].includes('Smith, J') && lines[2].includes('said "hi"'), lines[2])
      assert.ok(lines[3].includes('a\\|b'), lines[3])
      await toRead(page)
      await page.locator('.preview-pane table').first().waitFor({ timeout: 5000 })
      assert.equal(await page.locator('.preview-pane table th').count(), 3)
      const last = await page.locator('.preview-pane table tbody tr').last().locator('td').allTextContents()
      assert.deepEqual(last.map((s) => s.trim()), ['2', 'Lee', 'a|b'])
    } finally { await context.close() }
  })

  it('AC-11.7 a quoted cell with a newline renders as a line break inside one cell', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await paste(page, 'a\tb\n"line1\nline2"\tx')
      const text = await waitEditorText(page, (t) => t.startsWith('| a'), 'the table')
      assert.ok(text.includes('line1<br>line2'), text)
      await toRead(page)
      const cell = page.locator('.preview-pane table tbody td').first()
      await cell.waitFor({ timeout: 5000 })
      assert.equal(await cell.locator('br').count(), 1, 'one <br> in the cell')
    } finally { await context.close() }
  })

  it('AC-11.8 inside a fenced block or an inline code span the TSV is inserted verbatim', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Code\n\n```\nfenced here\n```\n\nSome `inline code` text\n'
      await openLocal(page, doc)
      await caretAfter(page, 'fenced')
      await paste(page, TSV)
      await waitEditorText(page, (t) => t.includes('fenced' + TSV), 'verbatim inside the fence')
      assert.ok(!(await settled(page)).includes('| Name'), 'no table in the fence')
      await caretAfter(page, '`inline')
      await paste(page, 'p\tq\nr\ts')
      await waitEditorText(page, (t) => t.includes('`inlinep\tq\nr\ts code`'), 'verbatim inside inline code')
      assert.equal(await tableToast(page).count(), 0)
    } finally { await context.close() }
  })

  it('pasting into an existing table row inserts verbatim', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '| a | b |\n| - | - |\n| c | d |\n')
      await caretAfter(page, '| c')
      await paste(page, 'x\ty\nz\tw')
      await waitEditorText(page, (t) => t.includes('| cx\ty\nz\tw'), 'verbatim in the table row')
    } finally { await context.close() }
  })

  it('AC-11.9 mid-line paste: blank lines isolate the table; preview shows paragraph, table, paragraph', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, 'Intro textmore\n')
      await caretAfter(page, 'Intro text')
      await paste(page, TSV)
      const text = await waitEditorText(page, (t) => t.includes('| Name'), 'the table')
      assert.ok(text.startsWith(`Intro text\n\n${TABLE}\n\nmore`), JSON.stringify(text))
      await toRead(page)
      await page.locator('.preview-pane table').first().waitFor({ timeout: 5000 })
      const kinds = await page.locator('.preview-pane').first().evaluate((el) => {
        const out = []
        for (const n of el.querySelectorAll('p, table')) if (!n.closest('table') || n.tagName === 'TABLE') out.push(n.tagName)
        return out
      })
      assert.deepEqual(kinds, ['P', 'TABLE', 'P'])
    } finally { await context.close() }
  })

  it('selection replaced; a previous non-blank line gets one newline; caret at the end of the last row', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, 'para\nREPLACE ME\nafter\n')
      await page.locator('.cm-editor:visible .cm-line', { hasText: 'REPLACE ME' }).first().click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
      await paste(page, TSV)
      const text = await waitEditorText(page, (t) => t.includes('| Name'), 'the table')
      assert.equal(text, `para\n\n${TABLE}\n\nafter\n`)
      await page.keyboard.type('!')
      await waitEditorText(page, (t) => t.includes('|  12 |!'), 'caret at the end of the last row')
    } finally { await context.close() }
  })

  it('an Excel-style clipboard (PNG + TSV) converts to a table and uploads nothing', T, async () => {
    const { context, page, uploads } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await paste(page, TSV, { files: [{ name: 'image.png', type: 'image/png', b64: PNG_1x1 }] })
      await waitEditorText(page, (t) => t.startsWith('| Name'), 'the table')
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(uploads.length, 0)
      assert.equal(await page.locator(`${tid('share-required-dialog')}:visible`).count(), 0)
    } finally { await context.close() }
  })

  it('AC-11.16 an html doc gets the TSV verbatim', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '<p>x</p>\n', filename: 'page.html', contentType: 'html', sessionName: uniq('Tbl'), protected: true })
      await page.goto(`${BASE}/d/${doc.id}?edit=${doc.editToken}`)
      await page.locator('.html-frame, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
      await toEdit(page)
      await caretToEnd(page)
      await paste(page, TSV)
      await waitEditorText(page, (t) => t.endsWith(TSV), 'verbatim TSV')
      assert.ok(!(await settled(page)).includes('| Name'))
      assert.equal(await tableToast(page).count(), 0)
    } finally { await context.close() }
  })
})

describe('#11 format table command (Shift+Alt+F)', () => {
  it('AC-11.12 the ragged table is re-aligned; the caret lands at the start of "long cell"', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '|a|b|\n|:-|-:|\n|long cell|1|2|')
      await caretAfter(page, 'long c')
      await page.keyboard.press('Shift+Alt+F')
      const want = '| a         |   b |     |\n| :-------- | --: | --- |\n| long cell |   1 | 2   |'
      await waitEditorText(page, (t) => t === want, 'the formatted table')
      await page.keyboard.type('^')
      await waitEditorText(page, (t) => t.includes('| ^long cell |'), 'caret at the start of the cell content')
    } finally { await context.close() }
  })

  it('AC-11.12 one undo reverts the formatting (one step)', T, async () => {
    const { context, page } = await open()
    try {
      const ragged = '|a|b|\n|-|-|\n|cc|d|'
      await openLocal(page, ragged)
      await caretAfter(page, '|c')
      await page.keyboard.press('Shift+Alt+F')
      await waitEditorText(page, (t) => t.startsWith('| a '), 'formatted')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === ragged, 'one undo → the ragged table')
    } finally { await context.close() }
  })

  it('AC-11.13 an already formatted table: unchanged, and the press adds nothing to undo', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await page.keyboard.type('x')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await paste(page, TSV)
      const formatted = await waitEditorText(page, (t) => t.includes('| Name'), 'the pasted table')
      await caretAfter(page, '| App')
      await page.keyboard.press('Shift+Alt+F')
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(await editorText(page), formatted, 'unchanged')
      // Undo must peel the paste's formatting step, not a no-op from the press.
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === 'x\n\n' + TSV, 'undo → the raw paste (the press recorded nothing)')
    } finally { await context.close() }
  })

  it('AC-11.14 caret on a paragraph: unchanged and an info toast "No table at cursor"', T, async () => {
    const { context, page } = await open()
    try {
      const doc = 'Just a paragraph.\n'
      await openLocal(page, doc)
      await caretAfter(page, 'Just')
      await page.keyboard.press('Shift+Alt+F')
      await page.locator(`${tid('app-toast')}[data-kind="info"]`).filter({ hasText: 'No table at cursor' }).first().waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await editorText(page), doc.replace(/\n$/, '\n'))
    } finally { await context.close() }
  })

  it('the caret on the delimiter row / in the indentation before | still formats', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '|a|b|\n|---|---|\n|c|d|')
      await caretAfter(page, '|--')
      await page.keyboard.press('Shift+Alt+F')
      await waitEditorText(page, (t) => t === '| a   | b   |\n| --- | --- |\n| c   | d   |', 'formatted from the delimiter row')
    } finally { await context.close() }
  })

  it('the shortcuts overlay lists Format table (Shift+Alt+F) and plain-text paste', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '# Keys\n')
      await page.locator(tid('editor-shortcuts-btn')).first().click()
      await page.locator(tid('shortcuts-overlay')).waitFor({ state: 'visible', timeout: 5000 })
      const rows = await page.locator(`${tid('shortcuts-overlay')} ${tid('shortcuts-row')}`).allInnerTexts()
      const fmt = rows.find((r) => r.includes('Format table'))
      assert.ok(fmt, `a Format table row in ${JSON.stringify(rows)}`)
      assert.match(fmt, /Shift\+Alt\+F|⌥⇧F/)
      const plain = rows.find((r) => /plain text/i.test(r))
      assert.ok(plain, 'a paste-as-plain-text row')
      assert.match(plain, /Ctrl\+Shift\+V|⇧⌘V/)
    } finally { await context.close() }
  })
})

describe('#11 review/QA round', () => {
  it('pasting the same TSV twice in a row gives two tables, one blank line apart', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await paste(page, TSV)
      await waitEditorText(page, (t) => t === TABLE, 'the first table')
      await paste(page, TSV)
      await waitEditorText(page, (t) => t === `${TABLE}\n\n${TABLE}`, 'two tables')
    } finally { await context.close() }
  })

  it('a plain Ctrl/Cmd+V after the chord disarms it: the next paste converts', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '')
      await caretToEnd(page)
      await page.keyboard.press(`${MOD}+Shift+V`)
      await page.keyboard.press(`${MOD}+V`)
      await paste(page, TSV)
      await waitEditorText(page, (t) => t.startsWith('| Name'), 'converted (chord disarmed)')
    } finally { await context.close() }
  })

  it('Shift+Alt+F on pipe lines inside a fenced block changes nothing ("No table at cursor")', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '```\n|a|b|\n|-|-|\n|c|d|\n```\n'
      await openLocal(page, doc)
      await caretAfter(page, '|c')
      await page.keyboard.press('Shift+Alt+F')
      await page.locator(`${tid('app-toast')}[data-kind="info"]`).filter({ hasText: 'No table at cursor' }).first().waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await editorText(page), doc)
    } finally { await context.close() }
  })
})
