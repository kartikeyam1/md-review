// #9 fix round — e2e tests for the QA / review findings on the markdown
// shortcuts (docs/build/specs/09-md-shortcuts.md):
//   1  bold/italic/link on whole list, task, heading and quote lines keep the block markup outside
//   2  Mod+E never merges two separate code blocks
//   3  `?` opens the overlay only while the editor toolbar is visible
//   4  Mod+K escapes brackets in the label
//   5  Shift+Tab renumbers ordered lists; Tab/Shift+Tab in quoted lists; tab-indented items
//   6  `**a** and **b**` + Mod+B never produces `a** and **b`
//   8  no "No tile at position" page error when the doc shrinks under a pending selection report
// Helpers are copied from 09-md-shortcuts.test.mjs (frozen; not imported so it stays untouched).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE } from '../helpers.mjs'
import { createDoc, uniq, waitForDoc } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }

const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const HOST_MAC = process.platform === 'darwin'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-09fix-'))
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ── platform emulation ──────────────────────────────────────────────────────

const PLATFORMS = {
  mac: {
    platform: 'MacIntel',
    uaPlatform: 'macOS',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
}

/**
 * Fresh context. `platform: 'mac'` emulates macOS for CodeMirror's keymap and for
 * the overlay's key labels. Every keydown that reaches `window` is recorded in
 * `window.__keys` with its `defaultPrevented` state (CodeMirror handles keys on
 * its content element, so a bubbling window listener sees its verdict).
 */
async function open({ viewport = { width: 1400, height: 900 }, platform } = {}) {
  const emu = platform ? PLATFORMS[platform] : null
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(emu ? { userAgent: emu.userAgent } : {}) })
  if (emu) {
    await context.addInitScript((e) => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => e.platform, configurable: true })
      const uaData = {
        platform: e.uaPlatform, mobile: false, brands: [],
        getHighEntropyValues: async () => ({ platform: e.uaPlatform, mobile: false, brands: [] }),
        toJSON: () => ({ platform: e.uaPlatform, mobile: false, brands: [] }),
      }
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => uaData, configurable: true })
    }, emu)
  }
  await context.addInitScript(() => {
    window.__keys = []
    window.addEventListener('keydown', (e) => {
      window.__keys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey, prevented: e.defaultPrevented })
    })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page, errors }
}

// ── docs ────────────────────────────────────────────────────────────────────

let fileSeq = 0
/** A local (never-shared, so editor capability) doc through the dev `?filePath=` loader. */
function localDocUrl(text, name = `shortcuts-${++fileSeq}.md`) {
  const p = join(tmp, name)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}`
}

/** Waits until `marker` is on screen in either the read view or the editor. */
async function waitForText(page, marker, timeout = 15_000) {
  await page.waitForFunction(
    (m) => [...document.querySelectorAll('.preview-pane, .cm-content')].some((e) => e.textContent.includes(m)),
    marker, { timeout },
  )
}

/**
 * Open `text` as a local markdown doc and switch to Edit. Readiness is judged
 * from the editor (keep switching to Edit until it shows exactly `text`), since
 * markdown syntax such as list markers never appears in the rendered read view.
 * `name` overrides the generated file name (its extension picks the content type).
 */
async function editLocal(page, text, name) {
  await page.goto(localDocUrl(text, name))
  await until(async () => {
    try { await toEdit(page) } catch { return false }
    return (await editorText(page)) === text
  }, { timeout: 20_000, interval: 200, message: `the doc in the editor: ${JSON.stringify(text)}` })
}

/** Open `text` as a local HTML doc (its read view is an opaque-origin iframe) and switch to Edit. */
const editLocalHtml = (page, text) => editLocal(page, text, `shortcuts-${++fileSeq}.html`)

// ── views ───────────────────────────────────────────────────────────────────

/** The view-toggle segment (#2), or today's header Edit / Preview button before #2. */
async function toggle(page, which) {
  const byId = page.locator(tid(`view-toggle-${which}`)).first()
  if (await byId.count()) return byId
  const label = which === 'edit' ? 'Edit' : which === 'read' ? 'Preview' : 'Split'
  return page.locator(`header button:has-text("${label}")`).first()
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
  await page.waitForFunction(() => ![...document.querySelectorAll('.cm-editor')].some((e) => e.getClientRects().length > 0), null, { timeout: 5000 })
}

// ── editor helpers ──────────────────────────────────────────────────────────

/** The visible editor's document text, joined from its rendered lines. */
async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    if (!ed) return null
    return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')
  })
}

async function until(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await fn()
    if (last) return last
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

/** Expect the editor text to become exactly `want`. */
const expectText = (page, want, what) => waitEditorText(page, (t) => t === want, `${what}: ${JSON.stringify(want)}`)

/** The editor text once it has stopped changing (two equal reads 150 ms apart). */
async function settledText(page, timeout = 2000) {
  let prev = await editorText(page)
  const deadline = Date.now() + timeout
  for (;;) {
    await new Promise((r) => setTimeout(r, 150))
    const now = await editorText(page)
    if (now === prev || Date.now() > deadline) return now
    prev = now
  }
}

/** Put the caret at (0-based) `line`, `col` using keys only: Mod+Home, ArrowDown×line, ArrowRight×col. */
async function caret(page, line, col = 0) {
  await editorContent(page).focus()
  await page.keyboard.press(`${MOD}+Home`)
  for (let i = 0; i < line; i++) await page.keyboard.press('ArrowDown')
  for (let i = 0; i < col; i++) await page.keyboard.press('ArrowRight')
}

/** Caret at the end of (0-based) `line`. */
async function caretEnd(page, line) {
  await caret(page, line, 0)
  await page.keyboard.press('End')
}

/** Select columns [from, to) of (0-based) `line`. */
async function select(page, line, from, to) {
  await caret(page, line, from)
  for (let i = from; i < to; i++) await page.keyboard.press('Shift+ArrowRight')
}

/** Select the substring `word` (first occurrence) on (0-based) `line`. */
async function selectWord(page, line, word) {
  const t = (await editorText(page)).split('\n')[line]
  const at = t.indexOf(word)
  assert.ok(at >= 0, `precondition: line ${line} "${t}" contains "${word}"`)
  await select(page, line, at, at + word.length)
}

const domSelection = (page) => page.evaluate(() => window.getSelection()?.toString() ?? '')
const focusInEditor = (page) => page.evaluate(() => !!document.activeElement?.closest?.('.cm-editor'))
const blurAll = (page) => page.evaluate(() => { document.activeElement?.blur?.() })

/** keydowns recorded since the last call (see `open`). */
async function takeKeys(page) {
  return page.evaluate(() => window.__keys.splice(0))
}

// ── preview ─────────────────────────────────────────────────────────────────

async function previewHas(page, fn, arg, message, timeout = 10_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout })
  } catch {
    const html = await page.evaluate(() => document.querySelector('.preview-pane')?.innerHTML.slice(0, 600) ?? '(no .preview-pane)')
    assert.fail(`${message}\n  preview: ${html}`)
  }
}

// ── overlay ─────────────────────────────────────────────────────────────────

const overlay = (page) => page.locator(tid('shortcuts-overlay'))
const shortcutsBtn = (page) => page.locator(`${tid('editor-shortcuts-btn')}:visible`).first()

async function overlayVisible(page) {
  return (await page.locator(`${tid('shortcuts-overlay')}:visible`).count()) > 0
}

async function expectOverlayClosed(page, what) {
  await until(async () => !(await overlayVisible(page)), { timeout: 3000, message: `${what}: shortcuts-overlay closes` })
}

/** Observe for `ms` that the overlay never opens. */
async function expectNoOverlay(page, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    assert.equal(await overlayVisible(page), false, `${what}: shortcuts-overlay must not open`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The text of the `shortcuts-row` whose label matches `label`. */
async function rowText(page, label) {
  const rows = await page.locator(`${tid('shortcuts-overlay')} ${tid('shortcuts-row')}`).allInnerTexts()
  return rows.find((r) => label.test(r)) ?? null
}

/** Select the whole of (0-based) `line` with keys only. */
async function selectLine(page, line) {
  await caret(page, line, 0)
  await page.keyboard.press('Shift+End')
}

describe('#9 fix 1 — block markup stays outside the markers', () => {
  it('Mod+B on whole list / task / heading / quote lines wraps only the text; the list still renders', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# L\n\n- item\n- [ ] task\n\n## Head\n\n> quote\n')
      for (const n of [2, 3, 5, 7]) {
        await selectLine(page, n)
        await page.keyboard.press(`${MOD}+b`)
      }
      await expectText(page, '# L\n\n- **item**\n- [ ] **task**\n\n## **Head**\n\n> **quote**\n', 'prefixes kept outside the markers')
      await toRead(page)
      await previewHas(page, () => {
        const p = document.querySelector('.preview-pane')
        const li = p?.querySelector('ul > li strong')
        return li?.textContent === 'item' && p.querySelector('h2 strong')?.textContent === 'Head' && p.querySelector('blockquote strong')?.textContent === 'quote'
      }, null, 'list item, heading and quote render with bold text')
    } finally { await context.close() }
  })

  it('a multi-line selection over list items wraps each item text', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# M\n\n1. one\n2. two\n')
      await caret(page, 2, 0)
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+End')
      await page.keyboard.press(`${MOD}+i`)
      await expectText(page, '# M\n\n1. *one*\n2. *two*\n', 'ordered markers kept')
    } finally { await context.close() }
  })
})

describe('#9 fix 2 — Mod+E does not merge two code blocks', () => {
  it('lines between two separate fenced blocks get a new fence; nothing is unfenced', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '```\na\n```\n\n```\nb\n```\n')
      await caret(page, 1, 0)
      for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+End')
      await page.keyboard.press(`${MOD}+e`)
      await expectText(page, '```\n```\na\n```\n\n```\nb\n```\n```\n', 'wrapped, both original blocks intact')
    } finally { await context.close() }
  })
})

describe('#9 fix 3 — `?` needs the editor toolbar on screen', () => {
  it('with the toolbar hidden (editor mounted) `?` does nothing; visible again, `?` opens', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Q\n\nask\n')
      await page.addStyleTag({ content: '.editor-pane { display: none !important; }' })
      await blurAll(page)
      await page.keyboard.type('?')
      await expectNoOverlay(page, 400, '`?` with the editor hidden')
      await page.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('.editor-pane { display: none')) s.remove() }))
      await blurAll(page)
      await page.keyboard.type('?')
      await overlay(page).first().waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })
})

describe('#9 fix 4 — Mod+K escapes brackets', () => {
  it('`a [b] c` + Mod+K + URL → `[a \\[b\\] c](url)`, rendered as one link', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# K\n\na [b] c\n')
      await selectLine(page, 2)
      await page.keyboard.press(`${MOD}+k`)
      await page.keyboard.type('https://x.io')
      await expectText(page, '# K\n\n[a \\[b\\] c](https://x.io)\n', 'escaped label')
      await toRead(page)
      await previewHas(page, () => {
        const a = document.querySelector('.preview-pane a')
        return a?.textContent === 'a [b] c' && a.getAttribute('href') === 'https://x.io'
      }, null, 'one link with the bracketed text')
    } finally { await context.close() }
  })
})

describe('#9 fix 5 — outdent renumbering, quoted and tab-indented lists', () => {
  it('Shift+Tab on a nested ordered item renumbers both levels; the preview nests correctly', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# O\n\n1. a\n   1. x\n   2. y\n2. b')
      await caretEnd(page, 3)
      await page.keyboard.press('Shift+Tab')
      await expectText(page, '# O\n\n1. a\n2. x\n   1. y\n3. b', 'renumbered')
      await toRead(page)
      await previewHas(page, () => {
        const top = document.querySelector('.preview-pane ol')
        const items = top ? [...top.querySelectorAll(':scope > li')] : []
        return items.length === 3 && items[1].querySelector(':scope > ol > li')?.textContent.trim() === 'y'
      }, null, 'a, x (with y nested), b')
    } finally { await context.close() }
  })

  it('Tab / Shift+Tab nest and un-nest inside a blockquote', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Q\n\n> - a\n> - b')
      await caretEnd(page, 3)
      await page.keyboard.press('Tab')
      await expectText(page, '# Q\n\n> - a\n>   - b', 'nested inside the quote')
      await page.keyboard.press('Shift+Tab')
      await expectText(page, '# Q\n\n> - a\n> - b', 'back')
    } finally { await context.close() }
  })

  it('Shift+Tab outdents a tab-indented item', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# T\n\n- a\n\t- b')
      await caretEnd(page, 3)
      await page.keyboard.press('Shift+Tab')
      await expectText(page, '# T\n\n- a\n- b', 'the tab is removed')
    } finally { await context.close() }
  })
})

describe('#9 fix 6 — markers inside the selection', () => {
  it('`**a** and **b**` + Mod+B → `**a and b**`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# B\n\n**a** and **b**\n')
      await selectLine(page, 2)
      await page.keyboard.press(`${MOD}+b`)
      await expectText(page, '# B\n\n**a and b**\n', 'one bold span')
    } finally { await context.close() }
  })
})

describe('#9 fix 8 — no stale-position error from the selection report', () => {
  it('the doc shrinking before the deferred selection report runs raises no page error', T, async () => {
    const { context, page, errors } = await open()
    try {
      await editLocal(page, `# S\n\n${'long line of text '.repeat(40)}\n${'more text '.repeat(60)}\n`)
      await editorContent(page).focus()
      // Select everything, and in the same task (before the next frame) replace it
      // with one character: the selection report scheduled for the next frame then
      // refers to a position past the new end of the document.
      await page.evaluate(() => {
        document.addEventListener('selectionchange', () => { document.execCommand('insertText', false, 'x') }, { once: true })
        const content = document.querySelector('.cm-editor .cm-content')
        const range = document.createRange()
        range.selectNodeContents(content)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      })
      await waitEditorText(page, (t) => t.length < 20, 'the doc replaced')
      await page.waitForTimeout(300)
      assert.deepEqual(errors.filter((e) => /tile|position/i.test(e)), [], `page errors: ${JSON.stringify(errors)}`)
    } finally { await context.close() }
  })
})
