// #8 Undo / redo that works — frozen acceptance tests (docs/build/specs/08-undo-redo.md,
// 00 §3.3 EditorToolbar, §3.5 keys, §3.6 undo contract).
//
// Key combos use Playwright's `ControlOrMeta`, so the suite means Ctrl on a
// Linux/Windows host and Cmd on a mac host. On top of that, AC-08.1 runs twice
// more with an EMULATED platform (navigator.platform / userAgent overridden
// before any app script runs, which is what CodeMirror's keymap reads):
//   - mac:     Meta+Z undo, Meta+Shift+Z and Meta+Y redo   (CM's default lacks Cmd+Y)
//   - Windows: Ctrl+Z undo, Ctrl+Y and Ctrl+Shift+Z redo   (CM's default lacks Ctrl+Shift+Z on Windows)
//
// Remote updates are simulated the way durable-sync.test.mjs does it: a PUT of
// new markdown to the throwaway backend (E2E_API_URL) while the page is open,
// then waiting on a condition until the app's 5 s poll has applied it.
//
// Views are switched with #2's `view-toggle-*` testids (today's header Edit /
// Preview buttons before #2). After #6 the editor is lazy, so every switch to
// Edit waits for a visible `.cm-content`. Overflow items (#2) fall back to the
// pre-#2 header buttons the same way.
//
// The editor's text is read from the rendered `.cm-line`s of the visible
// editor. Docs whose exact text is compared are short, so CodeMirror renders
// every line (no virtualised gaps).
//
// Deferred halves (written now, run as node:test `todo` until their item lands):
//   AC-08.5 /table   → needs #12 · AC-08.5 table paste → needs #11 · AC-08.11 Split → needs #7
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, waitForDoc } from '../lib/docs.mjs'

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }
/** One poll cycle is 5 s; a remote PUT must be on screen within ~2 cycles. */
const POLL_WAIT = 15_000

const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac08-'))
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
  win: {
    platform: 'Win32',
    uaPlatform: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
}

/**
 * Fresh context (no cache, no persisted drafts). `platform` emulates mac / win
 * for CodeMirror's keymap and for any shortcut label the app derives.
 * Dialogs (discard confirmations) are accepted; page errors are collected.
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
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page, errors }
}

// ── docs ────────────────────────────────────────────────────────────────────

let fileSeq = 0
/** A local (never-shared) doc through the dev `?filePath=` loader. */
function localDocUrl(text, name = `undo-${++fileSeq}.md`) {
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

async function openLocal(page, text, marker) {
  await page.goto(localDocUrl(text))
  await waitForText(page, marker)
}

async function openShared(page, markdown, marker, filename = 'doc.md') {
  const doc = await createDoc({ markdown, filename, sessionName: uniq('Undo') })
  await page.goto(`${BASE}/d/${doc.id}`)
  await waitForDoc(page, marker)
  return doc
}

async function serverMarkdown(id) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(id)}/markdown`)
  assert.equal(res.status, 200, 'GET /paste/:id/markdown')
  return (await res.json()).markdown
}

// ── views / header ──────────────────────────────────────────────────────────

/** The view-toggle segment (#2), or today's header Edit / Preview button before #2. */
async function toggle(page, which) {
  const byId = page.locator(tid(`view-toggle-${which}`)).first()
  if (await byId.count()) return byId
  const label = which === 'edit' ? 'Edit' : which === 'read' ? 'Preview' : 'Split'
  return page.locator(`header button:has-text("${label}")`).first()
}

const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()

async function waitEditor(page, timeout = 20_000) {
  await editorContent(page).waitFor({ state: 'visible', timeout })
}

/** Switch to Edit (no-op when an editor is already on screen) and wait for `.cm-content`. */
async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await (await toggle(page, 'edit')).click()
  await waitEditor(page)
}

async function toRead(page) {
  await (await toggle(page, 'read')).click()
  await page.locator('.preview-pane').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => ![...document.querySelectorAll('.cm-editor')].some((e) => e.getClientRects().length > 0), null, { timeout: 5000 })
}

/** Click an overflow-menu item (#2), or the pre-#2 header button with `legacyText`. */
async function headerAction(page, menuId, legacy) {
  const overflow = page.locator(tid('header-overflow-btn')).first()
  if (await overflow.count() && await overflow.isVisible()) {
    await overflow.click()
    await page.locator(tid(menuId)).first().click()
    return
  }
  const direct = page.locator(tid(menuId)).first()
  if (await direct.count() && await direct.isVisible()) return direct.click()
  await page.locator(legacy).first().click()
}

async function openHistory(page) {
  const old = page.locator(tid('history-button')).first()
  if (await old.count() && await old.isVisible()) await old.click()
  else await headerAction(page, 'menu-history', tid('history-button'))
  await page.locator(tid('revisions-modal')).waitFor({ state: 'visible', timeout: 5000 })
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

async function until(fn, { timeout = 5000, interval = 100, message = 'condition' } = {}) {
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

/** The editor text once it has stopped changing (two equal reads 250 ms apart). */
async function settledText(page, timeout = 3000) {
  let prev = await editorText(page)
  const deadline = Date.now() + timeout
  for (;;) {
    await new Promise((r) => setTimeout(r, 250))
    const now = await editorText(page)
    if (now === prev || Date.now() > deadline) return now
    prev = now
  }
}

/** Click into the editor and put the caret at the end of the document. */
async function caretToEnd(page) {
  await editorContent(page).click()
  await page.keyboard.press(`${MOD}+End`)
}

/** Focus the editor without moving its selection. */
async function focusEditor(page) {
  await editorContent(page).focus()
}

/** A paste of text/plain into the focused editor (one ClipboardEvent, like a real Ctrl/Cmd+V). */
async function paste(page, text) {
  await editorContent(page).evaluate((el, t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

const focusInEditor = (page) => page.evaluate(() => !!document.activeElement?.closest?.('.cm-content'))

// ── toolbar ─────────────────────────────────────────────────────────────────

const undoBtn = (page) => page.locator(tid('editor-undo-btn'))
const redoBtn = (page) => page.locator(tid('editor-redo-btn'))

async function waitToolbar(page) {
  await page.locator(tid('editor-toolbar')).first().waitFor({ state: 'visible', timeout: 10_000 })
  await undoBtn(page).first().waitFor({ state: 'visible', timeout: 5000 })
  await redoBtn(page).first().waitFor({ state: 'visible', timeout: 5000 })
}

/** Wait (≤ 3 s) for a toolbar button's disabled state to settle on `want`. */
async function expectDisabled(loc, want, what) {
  await loc.first().waitFor({ state: 'visible', timeout: 10_000 })
  let got
  try {
    await until(async () => (got = await loc.first().isDisabled()) === want, { timeout: 3000, message: what })
  } catch {
    assert.fail(`${what}: expected disabled=${want}, got disabled=${got}`)
  }
}

// ── network ─────────────────────────────────────────────────────────────────

/** Every PUT/PATCH to /paste/:id/markdown from `since()` on. */
function recordWrites(page) {
  const writes = []
  page.on('request', (r) => {
    if (!['PUT', 'PATCH'].includes(r.method())) return
    let path
    try { path = new URL(r.url()).pathname } catch { return }
    if (/\/paste\/[^/]+\/markdown\/?$/.test(path)) writes.push({ at: Date.now(), method: r.method(), path })
  })
  return { since: (t) => writes.filter((w) => w.at >= t) }
}

/**
 * Observe for `ms` that no write happens (the AC's observation window; polled
 * every 100 ms so a write fails the test as soon as it is seen).
 */
async function expectNoWrites(rec, from, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const w = rec.since(from)
    assert.equal(w.length, 0, `${what}: unexpected ${w.map((x) => `${x.method} ${x.path}`).join(', ')}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ── scrolling (AC-08.8) ─────────────────────────────────────────────────────

/**
 * In-page: the element that scrolls the visible editor (its .cm-scroller, an
 * ancestor pane, or the document), the line height, and the text of the first
 * line whose box is visible at the top of that scroll area (probed with
 * elementFromPoint, so a sticky header over the editor is skipped).
 */
const SCROLL_PROBE = () => {
  const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
  if (!ed) return null
  const scrolls = (el) => {
    const oy = getComputedStyle(el).overflowY
    return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
  }
  let sc = ed.querySelector('.cm-scroller')
  if (!sc || !scrolls(sc)) {
    sc = null
    for (let p = ed.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (scrolls(p)) { sc = p; break }
    }
  }
  const el = sc ?? document.scrollingElement
  // Line height = the smallest gap between consecutive rendered lines (CodeMirror
  // also renders the caret's line far outside the viewport, so not lines[1] - lines[0]).
  const tops = [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.getBoundingClientRect().top)
  const gaps = tops.slice(1).map((t, i) => t - tops[i]).filter((d) => d > 1)
  const lh = gaps.length ? Math.min(...gaps) : 20
  const content = ed.querySelector('.cm-content').getBoundingClientRect()
  const top = sc ? Math.max(sc.getBoundingClientRect().top, 0) : 0
  const x = content.left + 6
  let first = null
  for (let y = top + 1; y < top + 240 && y < innerHeight; y += 2) {
    const hit = document.elementFromPoint(x, y)?.closest?.('.cm-line')
    if (hit && ed.contains(hit)) { first = hit.textContent; break }
  }
  return { first, lh, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, isDoc: !sc }
}

async function scrollProbe(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page.evaluate(SCROLL_PROBE)
}

/** Scroll the editor's scroll area (same resolution as SCROLL_PROBE) by `dy` px; never moves the caret. */
async function scrollBy(page, dy) {
  await page.evaluate((delta) => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    const scrolls = (el) => {
      const oy = getComputedStyle(el).overflowY
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
    }
    let sc = ed.querySelector('.cm-scroller')
    if (!sc || !scrolls(sc)) {
      sc = null
      for (let p = ed.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (scrolls(p)) { sc = p; break }
      }
    }
    ;(sc ?? document.scrollingElement).scrollTop += delta
  }, dy)
}

// ════════════════════════════════════════════════════════════════════════════

const BASIC = '# Undo doc\n\nFirst paragraph of the undo doc.\n'
const BASIC_MARK = 'First paragraph of the undo doc.'

/** AC-08.1 for one platform: `mod` is the modifier the platform's shortcuts use. */
async function ac081(page, mod) {
  await openLocal(page, BASIC, BASIC_MARK)
  await toEdit(page)
  const original = await editorText(page)
  assert.equal(original, BASIC, 'precondition: the editor shows the doc')
  await caretToEnd(page)
  await page.keyboard.type('hello')
  await waitEditorText(page, (t) => t === BASIC + 'hello', 'typed text')

  await page.keyboard.press(`${mod}+z`)
  await waitEditorText(page, (t) => t === original, `${mod}+Z removes "hello"`)
  await page.keyboard.press(`${mod}+Shift+z`)
  await waitEditorText(page, (t) => t === BASIC + 'hello', `${mod}+Shift+Z redoes "hello"`)

  await page.keyboard.press(`${mod}+z`)
  await waitEditorText(page, (t) => t === original, `${mod}+Z undoes again`)
  await page.keyboard.press(`${mod}+y`)
  await waitEditorText(page, (t) => t === BASIC + 'hello', `${mod}+Y also redoes`)
}

describe('#8 undo/redo — keys and grouping', () => {
  it('AC-08.1 Ctrl/Cmd+Z undoes typed text; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo (host platform, ControlOrMeta)', T, async () => {
    const { context, page } = await open()
    try { await ac081(page, MOD) } finally { await context.close() }
  })

  it('AC-08.1 (emulated mac) Cmd+Z undoes; Cmd+Shift+Z and Cmd+Y redo', T, async () => {
    const { context, page } = await open({ platform: 'mac' })
    try { await ac081(page, 'Meta') } finally { await context.close() }
  })

  it('AC-08.1 (emulated Windows) Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo', T, async () => {
    const { context, page } = await open({ platform: 'win' })
    try { await ac081(page, 'Control') } finally { await context.close() }
  })

  it('AC-08.2 typing, a 1000 ms pause, more typing → two undo steps', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('alpha')
      // The AC's stimulus: a pause longer than the 500 ms grouping delay.
      await page.waitForTimeout(1000)
      await page.keyboard.type(' beta')
      await waitEditorText(page, (t) => t === BASIC + 'alpha beta', 'typed text')

      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t !== BASIC + 'alpha beta', 'the first undo')
      assert.equal(await settledText(page), BASIC + 'alpha', 'one undo removes only " beta"')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC, 'the second undo removes "alpha"')
    } finally { await context.close() }
  })

  it('AC-08.3 a paste right after typing is its own undo step', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('x')
      await paste(page, 'PASTED BLOCK\nline 2') // within 200 ms of the keystroke
      await waitEditorText(page, (t) => t === BASIC + 'xPASTED BLOCK\nline 2', 'pasted text')

      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC + 'x', 'one undo removes the paste and keeps "x"')
    } finally { await context.close() }
  })

  it('AC-08.4 an SVG paste (SVG path) is undone in one step, back to the exact pre-paste text', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await caretToEnd(page)
      // Typing right before the paste: the SVG insert must not merge with it.
      await page.keyboard.type('y')
      const prePaste = await waitEditorText(page, (t) => t === BASIC + 'y', 'typed text')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
      await paste(page, svg)
      await waitEditorText(page, (t) => t.includes('<svg') && t.includes('</svg>'), 'the SVG text in the doc')

      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === prePaste, 'one undo returns to the pre-paste text')
    } finally { await context.close() }
  })

  it('AC-08.5 (/table) one undo after a slash-menu /table insertion restores `/table` as typed, menu closed', { ...T, todo: 'needs #12' }, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Slash\n\n'
      await openLocal(page, doc, 'Slash')
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('/table')
      const preCommit = await waitEditorText(page, (t) => t === doc + '/table', '/table typed')
      await page.locator(tid('slash-menu')).waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press('Enter')
      await waitEditorText(page, (t) => !t.includes('/table') && t.includes('|'), 'the inserted table')

      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === preCommit, 'one undo → `/table` as typed')
      assert.equal(await page.locator(`${tid('slash-menu')}:visible`).count(), 0, 'no slash menu is open after the undo')
    } finally { await context.close() }
  })

  it('AC-08.5 (table paste) undo 1 → the raw pasted TSV, undo 2 → the pre-paste text', { ...T, todo: 'needs #11' }, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Paste\n\n'
      const tsv = 'Name\tQty\nApple\t3\nPear\t12'
      await openLocal(page, doc, 'Paste')
      await toEdit(page)
      await caretToEnd(page)
      await paste(page, tsv)
      await waitEditorText(page, (t) => t.includes('| Name'), 'the formatted table')

      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === doc + tsv, 'undo 1 → the raw TSV')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === doc, 'undo 2 → the pre-paste text')
    } finally { await context.close() }
  })
})

// ── toolbar ─────────────────────────────────────────────────────────────────
describe('#8 undo/redo — EditorToolbar', () => {
  it('AC-08.6 Undo/Redo buttons are disabled exactly when their stack is empty; Redo click re-applies and focuses the editor', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await waitToolbar(page)
      await expectDisabled(undoBtn(page), true, 'fresh load: editor-undo-btn')
      await expectDisabled(redoBtn(page), true, 'fresh load: editor-redo-btn')

      await caretToEnd(page)
      await page.keyboard.type('abc')
      await waitEditorText(page, (t) => t === BASIC + 'abc', 'typed text')
      await expectDisabled(undoBtn(page), false, 'after typing: editor-undo-btn')
      await expectDisabled(redoBtn(page), true, 'after typing: editor-redo-btn')

      // Undo everything with the button.
      for (let i = 0; i < 20 && !(await undoBtn(page).first().isDisabled()); i++) {
        await undoBtn(page).first().click()
        await page.waitForTimeout(50)
      }
      await waitEditorText(page, (t) => t === BASIC, 'undoing everything restores the original')
      await expectDisabled(undoBtn(page), true, 'after undoing everything: editor-undo-btn')
      await expectDisabled(redoBtn(page), false, 'after undoing everything: editor-redo-btn')
      assert.ok(await focusInEditor(page), 'clicking Undo returns focus to the editor')

      await redoBtn(page).first().click()
      await waitEditorText(page, (t) => t.includes('abc'), 'Redo re-applies the typing')
      assert.ok(await focusInEditor(page), 'after clicking Redo, focus is in .cm-content')
      await expectDisabled(undoBtn(page), false, 'after Redo: editor-undo-btn')
    } finally { await context.close() }
  })

  it('rule 8 / 00 §3.3: toolbar order Undo then Redo, aria-labels, platform shortcut in titles (host), visible on a phone', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await waitToolbar(page)
      const undo = undoBtn(page).first()
      const redo = redoBtn(page).first()
      assert.equal(await undo.getAttribute('aria-label'), 'Undo')
      assert.equal(await redo.getAttribute('aria-label'), 'Redo')
      const mac = process.platform === 'darwin'
      const modRe = mac ? /⌘|Cmd/i : /Ctrl/i
      const ut = (await undo.getAttribute('title')) ?? ''
      const rt = (await redo.getAttribute('title')) ?? ''
      assert.match(ut, modRe, `undo title names the platform modifier: "${ut}"`)
      assert.match(ut, /Z/i, `undo title names Z: "${ut}"`)
      assert.match(rt, modRe, `redo title names the platform modifier: "${rt}"`)
      assert.match(rt, /Y|Shift|⇧/i, `redo title names its shortcut: "${rt}"`)
      const order = await page.locator(tid('editor-toolbar')).first().evaluate((bar) => {
        const ids = [...bar.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
        return ids.filter((i) => i === 'editor-undo-btn' || i === 'editor-redo-btn')
      })
      assert.deepEqual(order, ['editor-undo-btn', 'editor-redo-btn'], 'Undo comes before Redo inside editor-toolbar')
      const inEditorPane = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="editor-toolbar"]')
        const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
        return !!bar && !!ed && bar.getBoundingClientRect().bottom <= ed.getBoundingClientRect().top + 1
      })
      assert.ok(inEditorPane, 'editor-toolbar sits above the editor')

      await page.setViewportSize({ width: 390, height: 844 })
      await undo.waitFor({ state: 'visible', timeout: 5000 })
      await redo.waitFor({ state: 'visible', timeout: 5000 })
    } finally { await context.close() }
  })

  it('rule 8 (emulated mac): titles use the Cmd shortcut', T, async () => {
    const { context, page } = await open({ platform: 'mac' })
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await waitToolbar(page)
      const ut = (await undoBtn(page).first().getAttribute('title')) ?? ''
      const rt = (await redoBtn(page).first().getAttribute('title')) ?? ''
      assert.match(ut, /⌘|Cmd/i, `mac undo title: "${ut}"`)
      assert.match(rt, /⌘|Cmd/i, `mac redo title: "${rt}"`)
      assert.doesNotMatch(ut, /Ctrl/i, `mac undo title has no Ctrl: "${ut}"`)
    } finally { await context.close() }
  })
})

// ── remote updates ──────────────────────────────────────────────────────────
describe('#8 undo/redo — remote updates', () => {
  it('AC-08.7 a remote insert at the top keeps the caret on its line: typing Q lands at line 11 column 3', T, async () => {
    const { context, page } = await open()
    try {
      const lines = ['# Caret doc', ...Array.from({ length: 19 }, (_, i) => `row-${String(i + 2).padStart(2, '0')} text`)]
      const md = lines.join('\n') + '\n'
      const doc = await openShared(page, md, 'row-05 text')
      await toEdit(page)
      await waitEditorText(page, (t) => t === md, 'the doc in the editor')
      // Caret at line 10, column 3 (after "ro" of "row-10 text").
      await page.locator('.cm-editor:visible .cm-content .cm-line').nth(9).click({ position: { x: 2, y: 4 } })
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')

      await putMarkdown(doc.id, 'REMOTE TOP LINE\n' + md)
      await waitEditorText(page, (t) => t.startsWith('REMOTE TOP LINE\n'), 'the poll applying the remote insert', POLL_WAIT)

      await page.keyboard.type('Q')
      const after = await waitEditorText(page, (t) => t.includes('Q'), 'the typed Q')
      const got = after.split('\n')
      const qLine = got.findIndex((l) => l.includes('Q'))
      assert.equal(got[10], 'roQw-10 text', `Q is inserted at line 11 column 3; line 11 is "${got[10]}", Q landed on line ${qLine + 1}: "${got[qLine]}"`)
      assert.equal(got[0], 'REMOTE TOP LINE', 'the new line is on screen at the top')
    } finally { await context.close() }
  })

  it('AC-08.8 a remote insert of 3 lines at the top does not move the first visible line (±1)', T, async () => {
    const { context, page } = await open()
    try {
      const lines = Array.from({ length: 200 }, (_, i) => `L${String(i + 1).padStart(3, '0')} scroll line`)
      const md = lines.join('\n') + '\n'
      const doc = await openShared(page, md, 'L005 scroll line')
      await toEdit(page)
      await waitEditorText(page, (t) => t.startsWith('L001 scroll line'), 'the doc in the editor')
      // Caret at the very top, then scroll (without moving it) so line 120 is first.
      await editorContent(page).click()
      await page.keyboard.press(`${MOD}+Home`)

      let info = await scrollProbe(page)
      assert.ok(info && info.lh > 4, `editor line height measurable: ${JSON.stringify(info)}`)
      for (let i = 0; i < 8; i++) {
        const n = Number(/^L(\d{3})/.exec(info.first ?? '')?.[1] ?? 1)
        if (n === 120) break
        await scrollBy(page, (120 - n) * info.lh)
        info = await scrollProbe(page)
      }
      assert.equal(info.first, 'L120 scroll line', `precondition: line 120 is the first visible line (${JSON.stringify(info)})`)
      const before = info

      await putMarkdown(doc.id, 'R1 inserted\nR2 inserted\nR3 inserted\n' + md)
      // The inserted lines are off screen above; the scroll area grows when the poll applies them.
      await until(async () => {
        const p = await scrollProbe(page)
        return p && p.scrollHeight >= before.scrollHeight + 2 * before.lh
      }, { timeout: POLL_WAIT, interval: 150, message: 'the poll applying the 3-line remote insert (scrollHeight grows)' })

      const now = await scrollProbe(page)
      const okTexts = ['L119 scroll line', 'L120 scroll line', 'L121 scroll line']
      assert.ok(okTexts.includes(now.first), `first visible line after the update is "${now.first}", expected one of ${okTexts.join(' / ')} (scrollTop ${before.scrollTop} → ${now.scrollTop})`)
    } finally { await context.close() }
  })

  it('AC-08.9 a remote update is a history barrier: Undo disabled, Ctrl/Cmd+Z leaves the server text, no PUT', T, async () => {
    const { context, page } = await open()
    try {
      const md = '# Barrier\n\nParagraph one.\n\nParagraph two original.\n\nParagraph three.\n'
      const doc = await openShared(page, md, 'Paragraph two original.')
      const rec = recordWrites(page)
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('LOCAL1')
      await until(async () => (await serverMarkdown(doc.id)).includes('LOCAL1'), { timeout: 10_000, interval: 200, message: 'LOCAL1 autosaved' })
      // Saved: since #2 rule 5 save-state is quiet (absent) when saved, or reads "Saved".
      await page.waitForFunction(() => { const t = document.querySelector('[data-testid="save-state"]')?.textContent ?? ''
        return !/Unsaved|Saving|failed|Conflict/.test(t) }, null, { timeout: 8000 })

      const saved = await serverMarkdown(doc.id)
      const remote = saved.replace('Paragraph two original.', 'Paragraph two REPLACED remotely.')
      assert.notEqual(remote, saved)
      await putMarkdown(doc.id, remote)
      await waitEditorText(page, (t) => t.includes('Paragraph two REPLACED remotely.'), 'the poll applying the remote update', POLL_WAIT)
      const from = Date.now()

      await expectDisabled(undoBtn(page), true, 'after the remote update: editor-undo-btn')
      await focusEditor(page)
      await page.keyboard.press(`${MOD}+z`)
      // Autosave fires ~2 s after a change: watch 3 s for a write.
      await expectNoWrites(rec, from, 3000, 'Ctrl/Cmd+Z after a remote update')
      assert.equal(await editorText(page), remote, 'the editor text still equals the server text (LOCAL1 kept, old paragraph 2 not restored)')
      assert.equal(await serverMarkdown(doc.id), remote, 'the server text is untouched')
    } finally { await context.close() }
  })

  it('AC-08.10 applying a remote update sends no PUT/PATCH for 3 s and save-state stays "Saved"', T, async () => {
    const { context, page } = await open()
    try {
      const md = '# Quiet\n\nBody before the remote write.\n'
      const doc = await openShared(page, md, 'Body before the remote write.')
      const rec = recordWrites(page)
      await toEdit(page)
      await waitEditorText(page, (t) => t === md, 'the doc in the editor')
      await putMarkdown(doc.id, '# Quiet\n\nBody AFTER the remote write.\n')
      await waitEditorText(page, (t) => t.includes('Body AFTER the remote write.'), 'the poll applying the remote update', POLL_WAIT)
      const from = Date.now()
      await expectNoWrites(rec, from, 3000, 'after a remote update')
      // Since #2 rule 5 save-state is quiet (absent) when saved, or reads "Saved".
      const el = page.locator(tid('save-state')).first()
      const state = (await el.count()) ? ((await el.textContent())?.trim() ?? '') : ''
      assert.doesNotMatch(state, /Unsaved|Saving|failed|Conflict/, `save-state: "${state}"`)
      assert.doesNotMatch(state, /Unsaved|Saving/, `save-state: "${state}"`)
    } finally { await context.close() }
  })

  it('AC-08.13 "Use server version" shows the server text, keeps a usable caret, and leaves Undo disabled', T, async () => {
    const { context, page, errors } = await open()
    try {
      const md = '# Doc\n\nbody\n'
      const doc = await openShared(page, md, 'body')
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type(' MINE')
      const theirs = '# Doc\n\nbody THEIRS\n\nanother server paragraph\n'
      await putMarkdown(doc.id, theirs)
      const bar = page.locator(tid('conflict-bar'))
      await bar.waitFor({ state: 'visible', timeout: POLL_WAIT })
      await bar.locator('button:has-text("Use server version")').click()
      await bar.waitFor({ state: 'hidden', timeout: 5000 })

      await waitEditorText(page, (t) => t === theirs, 'the editor shows the server text')
      await expectDisabled(undoBtn(page), true, 'after "Use server version": editor-undo-btn')
      await focusEditor(page)
      await page.keyboard.press(`${MOD}+z`)
      await page.waitForTimeout(300)
      assert.equal(await editorText(page), theirs, 'Ctrl/Cmd+Z does not bring back " MINE" or the old text')
      // The caret is somewhere inside the doc: typing inserts exactly one character.
      await page.keyboard.type('Q')
      const typed = await waitEditorText(page, (t) => t.includes('Q'), 'the typed Q')
      assert.equal(typed.length, theirs.length + 1)
      assert.equal(typed.replace('Q', ''), theirs, 'Q is inserted inside the server text')
      assert.deepEqual(errors, [], 'no page errors')
    } finally { await context.close() }
  })
})

// ── history lifetime ────────────────────────────────────────────────────────
describe('#8 undo/redo — history lifetime', () => {
  it('AC-08.11 typing, Read view, back to Edit: Ctrl/Cmd+Z removes the typing', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('KEEPME')
      await waitEditorText(page, (t) => t === BASIC + 'KEEPME', 'typed text')
      await toRead(page)
      await page.locator('.preview-pane').filter({ hasText: 'KEEPME' }).first().waitFor({ state: 'visible', timeout: 5000 })
      await (await toggle(page, 'edit')).click()
      await waitEditor(page)
      await focusEditor(page)
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC, 'KEEPME removed after the Read → Edit round trip')
    } finally { await context.close() }
  })

  it('AC-08.11 (Split) typing, Split view: Ctrl/Cmd+Z removes the typing', { ...T, todo: 'needs #7' }, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, BASIC, BASIC_MARK)
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('KEEPME')
      await waitEditorText(page, (t) => t === BASIC + 'KEEPME', 'typed text')
      await page.locator(tid('view-toggle-split')).click({ timeout: 5000 })
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(`${tid('split-pane-editor')} .cm-content`).focus()
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === BASIC, 'KEEPME removed in Split view')
    } finally { await context.close() }
  })

  it('AC-08.12 restoring an older revision is one undo step back to the pre-restore text', T, async () => {
    const { context, page } = await open()
    try {
      const v1 = '# Restore doc\n\nVersion one body.\n'
      const v2 = '# Restore doc\n\nVersion two body, rewritten.\n'
      const doc = await createDoc({ markdown: v1, filename: 'restore.md', sessionName: uniq('Restore') })
      // A different author than the create, so the write is its own revision (no coalescing).
      await putMarkdown(doc.id, v2, { author: 'agent' })
      const revs = await listRevisions(doc.id)
      assert.ok(revs.revisions.length >= 2, 'precondition: ≥ 2 revisions')
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Version two body, rewritten.')
      await toEdit(page)
      await waitEditorText(page, (t) => t === v2, 'the current revision in the editor')

      await openHistory(page)
      // With two revisions the modal compares the previous one (v1) with the current one.
      const restore = page.locator(tid('restore-revision'))
      // Let the diff finish loading before restoring (the footer re-renders while it loads).
      await page.locator(`${tid('revisions-modal')} ${tid('diff-stats')}`).waitFor({ state: 'visible', timeout: 10_000 })
      await restore.waitFor({ state: 'visible', timeout: 5000 })
      await restore.click({ timeout: 10_000 })
      await page.locator(tid('revisions-modal')).waitFor({ state: 'hidden', timeout: 5000 })
      await waitEditorText(page, (t) => t === v1, 'the restored revision in the editor')

      await focusEditor(page)
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === v2, 'one undo returns to the pre-restore text')
    } finally { await context.close() }
  })

  it('AC-08.14 opening another file starts with an empty history (no doc A text comes back)', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '# Doc A\n\nDoc A body.\n', 'Doc A body.')
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('DOCA_EDIT')
      await waitEditorText(page, (t) => t.includes('DOCA_EDIT'), 'doc A edit')

      const docB = '# Doc B\n\nDoc B body.\n'
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10_000 }),
        headerAction(page, 'menu-open-file', 'header button:has-text("Open file")'),
      ])
      await chooser.setFiles({ name: 'doc-b.md', mimeType: 'text/markdown', buffer: Buffer.from(docB) })
      await waitForText(page, 'Doc B body.')
      await toEdit(page)
      await waitEditorText(page, (t) => t === docB, 'doc B in the editor')
      await waitToolbar(page)
      await expectDisabled(undoBtn(page), true, 'doc B: editor-undo-btn')
      await focusEditor(page)
      for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+z`)
      await page.waitForTimeout(300)
      const t = await editorText(page)
      assert.equal(t, docB, 'Ctrl/Cmd+Z leaves doc B unchanged')
      assert.ok(!t.includes('Doc A') && !t.includes('DOCA_EDIT'), 'no doc A text comes back')
    } finally { await context.close() }
  })

  it('AC-08.14 (New) a new blank doc starts with an empty history (no doc A text comes back)', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, '# Doc A\n\nDoc A body.\n', 'Doc A body.')
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('DOCA_EDIT')
      await waitEditorText(page, (t) => t.includes('DOCA_EDIT'), 'doc A edit')

      await headerAction(page, 'menu-new-doc', 'header button:text-is("New")')
      const blank = page.locator('button:has-text("Start blank")').first()
      await blank.waitFor({ state: 'visible', timeout: 10_000 })
      await blank.click()
      await toEdit(page)
      const start = await waitEditorText(page, (t) => !t.includes('Doc A'), 'the new doc in the editor')
      await waitToolbar(page)
      await expectDisabled(undoBtn(page), true, 'new doc: editor-undo-btn')
      await focusEditor(page)
      for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+z`)
      await page.waitForTimeout(300)
      const t = await editorText(page)
      assert.equal(t, start, 'Ctrl/Cmd+Z leaves the new doc unchanged')
      assert.ok(!t.includes('Doc A') && !t.includes('DOCA_EDIT'), 'no doc A text comes back')
    } finally { await context.close() }
  })
})
