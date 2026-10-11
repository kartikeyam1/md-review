// #8 fix round (orchestrator QA/review of #8):
//  - MAJOR 1: Ctrl/Cmd+Z / redo pressed in a text input outside the editor
//    (filename rename, reviewer name) must never undo the DOCUMENT. Chrome
//    routes a native undo with an empty input stack to the last edited
//    contenteditable (the editor) as a `historyUndo` beforeinput.
//  - MAJOR 2: a remote edit in two distant places is applied as two small
//    changes, so the caret and the scroll position stay put.
//  - should-fix 2: history kept across a view switch never leaks into another
//    local doc that happens to have the same text.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq, waitForDoc } from '../lib/docs.mjs'

const T = { timeout: 90_000 }
const POLL_WAIT = 15_000
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-08fix-'))
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page }
}

async function serverMarkdown(id) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(id)}/markdown`)
  return (await res.json()).markdown
}

async function toggle(page, which) {
  const byId = page.locator(tid(`view-toggle-${which}`)).first()
  if (await byId.count()) return byId
  return page.locator(`header button:has-text("${which === 'edit' ? 'Edit' : 'Preview'}")`).first()
}
const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()
async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await (await toggle(page, 'edit')).click()
  await editorContent(page).waitFor({ state: 'visible', timeout: 20_000 })
}
async function toRead(page) {
  await (await toggle(page, 'read')).click()
  await page.locator('.preview-pane').first().waitFor({ state: 'visible', timeout: 10_000 })
}

/** The editor's whole document (through the view, so long docs are not cut by virtualisation). */
async function docText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    // CodeMirror tags its DOM with its tile tree; the root tile holds the view.
    return ed ? ed.querySelector('.cm-content').cmTile?.root?.view?.state.doc.toString() ?? null : null
  })
}
/** Rendered lines (short docs only). */
async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    return ed ? [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n') : null
  })
}
async function until(fn, { timeout = 5000, interval = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${message}` })
    await new Promise((r) => setTimeout(r, interval))
  }
}
function recordWrites(page) {
  const writes = []
  page.on('request', (r) => {
    if (!['PUT', 'PATCH'].includes(r.method())) return
    if (/\/paste\/[^/]+\/markdown\/?$/.test(new URL(r.url()).pathname)) writes.push(r.method())
  })
  return writes
}
const undoDisabled = (page) => page.locator(tid('editor-undo-btn')).first().isDisabled()

// ── MAJOR 1 ─────────────────────────────────────────────────────────────────
describe('#8 fix — undo keys in text inputs never touch the document', () => {
  for (const field of ['filename', 'reviewer']) {
    it(`Ctrl/Cmd+Z and redo inside the ${field} input leave the document and the server alone`, T, async () => {
      const { context, page } = await open()
      try {
        const md = '# Inputs\n\nBody text.\n'
        // Review mode: the reviewer name only shows there since #2 (00 §11).
        const { id } = await createDoc({ markdown: md, filename: 'inputs.md', sessionName: uniq('Inputs'), mode: 'review' })
        await page.goto(`${BASE}/d/${id}`)
        await waitForDoc(page, 'Body text.')
        await toEdit(page)
        await editorContent(page).click()
        await page.keyboard.press(`${MOD}+End`)
        await page.keyboard.type('EDITED')
        await until(async () => (await serverMarkdown(id)).includes('EDITED'), { timeout: 10_000, message: 'autosave' })
        const saved = await serverMarkdown(id)
        const writes = recordWrites(page)

        if (field === 'filename') await page.locator('header .filename').first().click()
        else await page.locator(tid('reviewer-name')).first().click()
        const input = page.locator('header input.filename-edit').first()
        await input.waitFor({ state: 'visible', timeout: 5000 })
        for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+z`)
        await page.keyboard.press(`${MOD}+Shift+z`)
        await page.keyboard.press(`${MOD}+y`)
        for (let i = 0; i < 2; i++) await page.keyboard.press(`${MOD}+z`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(3000) // > autosave delay

        assert.equal(await editorText(page), saved.replace(/\n$/, '\n'), 'the document is unchanged')
        assert.equal(await serverMarkdown(id), saved, 'the server copy is unchanged')
        assert.deepEqual(writes, [], 'no save was triggered')
      } finally { await context.close() }
    })
  }

  it('native undo inside the filename input still undoes the input\'s own typing', T, async () => {
    const { context, page } = await open()
    try {
      const p = join(tmp, 'native-undo.md')
      writeFileSync(p, '# Native\n\nText.\n')
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(p)}`)
      await waitForDoc(page, 'Text.')
      await toEdit(page) // the filename field is in the editor header since #2 (00 §2.2)
      await page.locator('header .filename').first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator('header .filename').first().click()
      const input = page.locator('header input.filename-edit').first()
      await input.waitFor({ state: 'visible' })
      await page.keyboard.press('End')
      await page.keyboard.type('xyz')
      assert.equal(await input.inputValue(), 'native-undo.mdxyz')
      await page.keyboard.press(`${MOD}+z`)
      assert.notEqual(await input.inputValue(), 'native-undo.mdxyz', 'the input\'s own undo works')
    } finally { await context.close() }
  })
})

// ── MAJOR 2 ─────────────────────────────────────────────────────────────────
async function firstVisibleLine(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    const sc = ed.querySelector('.cm-scroller')
    const top = sc.getBoundingClientRect().top
    const x = ed.querySelector('.cm-content').getBoundingClientRect().left + 6
    for (let y = top + 1; y < top + 240; y += 2) {
      const hit = document.elementFromPoint(x, y)?.closest?.('.cm-line')
      if (hit && ed.contains(hit)) return hit.textContent
    }
    return null
  })
}

/** Scroll (without moving the caret) until line `n` is the first visible one. */
async function scrollToFirst(page, n) {
  for (let i = 0; i < 10; i++) {
    const first = await firstVisibleLine(page)
    const at = Number(/^L(\d+)/.exec(first ?? '')?.[1] ?? 1)
    if (at === n) return
    await page.evaluate((d) => {
      const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
      const sc = ed.querySelector('.cm-scroller')
      const lh = ed.querySelector('.cm-line').getBoundingClientRect().height || 20
      sc.scrollTop += d * lh
    }, n - at)
  }
}

async function distantEdits(lineCount) {
  const { context, page } = await open()
  try {
    const pad = String(lineCount).length
    const lines = Array.from({ length: lineCount }, (_, i) => `L${String(i + 1).padStart(pad, '0')} line text`)
    const md = lines.join('\n') + '\n'
    const { id } = await createDoc({ markdown: md, filename: 'long.md', sessionName: uniq('Long') })
    await page.goto(`${BASE}/d/${id}`)
    await waitForDoc(page, lines[2])
    await toEdit(page)
    await until(async () => (await docText(page)) === md, { timeout: 10_000, message: 'the doc in the editor' })

    // Caret at line 151, column 3 (after "L1"), then scroll so line 140 is first.
    const caretLine = 151
    await page.evaluate((ln) => {
      const view = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0).querySelector('.cm-content').cmTile.root.view
      const pos = view.state.doc.line(ln).from + 2
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
    }, caretLine)
    await scrollToFirst(page, 140)
    const before = await firstVisibleLine(page)
    assert.match(before ?? '', /^L0*140 /, `precondition: line 140 is the first visible line (${before})`)

    const remote = lines.slice()
    remote[1] = remote[1] + ' EDITED-NEAR-TOP'
    remote[249] = remote[249] + ' EDITED-FAR'
    const remoteMd = remote.join('\n') + '\n'
    await putMarkdown(id, remoteMd)
    await until(async () => (await docText(page)) === remoteMd, { timeout: POLL_WAIT, interval: 150, message: 'the poll applying both remote edits' })

    const after = await firstVisibleLine(page)
    const n = Number(/^L(\d+)/.exec(after ?? '')?.[1] ?? -1)
    assert.ok(Math.abs(n - 140) <= 1, `first visible line stays at ~140, got "${after}"`)
    await page.keyboard.type('Q')
    await until(async () => (await docText(page))?.includes('Q'), { message: 'typed Q' })
    const got = (await docText(page)).split('\n')
    const qLine = got.findIndex((l) => l.includes('Q')) + 1
    assert.equal(qLine, caretLine, `Q lands on line ${caretLine}, got line ${qLine}: "${got[qLine - 1]}"`)
    assert.equal(got[caretLine - 1].indexOf('Q'), 2, `Q lands at column 3: "${got[caretLine - 1]}"`)
  } finally { await context.close() }
}

describe('#8 fix — remote edits in distant places keep caret and scroll', () => {
  it('300 lines: edits at lines 2 and 250 keep caret 151:3 and first visible line 140', T, () => distantEdits(300))
  it('2000 lines: edits at lines 2 and 250 keep caret 151:3 and first visible line 140', T, () => distantEdits(2000))
})

// ── should-fix 2 ────────────────────────────────────────────────────────────
describe('#8 fix — kept history never leaks into another local doc', () => {
  it('opening a different local file with identical text (while in Read view) starts with empty history', T, async () => {
    const { context, page } = await open()
    try {
      const a = join(tmp, 'same-a.md')
      writeFileSync(a, '# Same\n\nText.\n')
      await page.goto(`${BASE}/?filePath=${encodeURIComponent(a)}`)
      await waitForDoc(page, 'Text.')
      await toEdit(page)
      await editorContent(page).click()
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.type('X')
      await until(async () => (await editorText(page)) === '# Same\n\nText.\nX', { message: 'typed X' })
      await toRead(page)

      const docB = '# Same\n\nText.\nX'
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10_000 }),
        (async () => {
          const overflow = page.locator(tid('header-overflow-btn')).first()
          if (await overflow.count() && await overflow.isVisible()) { await overflow.click(); await page.locator(tid('menu-open-file')).first().click() }
          else await page.locator('header button:has-text("Open file")').first().click()
        })(),
      ])
      await chooser.setFiles({ name: 'same-b.md', mimeType: 'text/markdown', buffer: Buffer.from(docB) })
      await waitForDoc(page, 'Text.')
      await toEdit(page) // the filename field is in the editor header since #2 (00 §2.2)
      await page.locator('header .filename', { hasText: 'same-b.md' }).first().waitFor({ timeout: 10_000 })
      await until(async () => (await editorText(page)) === docB, { message: 'doc B in the editor' })
      assert.equal(await undoDisabled(page), true, 'doc B starts with Undo disabled')
      await editorContent(page).focus()
      await page.keyboard.press(`${MOD}+z`)
      await page.waitForTimeout(300)
      assert.equal(await editorText(page), docB, 'Ctrl/Cmd+Z does not reach into doc A\'s history')
    } finally { await context.close() }
  })
})
