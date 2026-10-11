// #9 Markdown keyboard shortcuts + shortcuts overlay — frozen acceptance tests
// (docs/build/specs/09-md-shortcuts.md; 00 §3.3 EditorToolbar, §3.4 Esc layering,
// §3.5 global shortcuts, §3.6 undo contract).
//
// Key combos use Playwright's `ControlOrMeta`, i.e. Ctrl on a Linux/Windows host
// and Cmd on a mac host — the spec's "Mod". The platform-label checks (overlay,
// Ctrl+B on mac) also run with an EMULATED mac (navigator.platform / userAgent
// overridden before any app script runs, which is what CodeMirror's keymap and
// any label helper read), the same way 08-undo-redo.test.mjs does it.
//
// Views are switched with #2's `view-toggle-*` testids (today's header Edit /
// Preview buttons before #2). After #6 the editor is lazy, so every switch to
// Edit waits for a visible `.cm-content`.
//
// The editor's text is read from the rendered `.cm-line`s of the visible editor
// (short docs, so CodeMirror renders every line). The caret is placed with real
// keys only (Mod+Home, ArrowDown, ArrowRight, Shift+ArrowRight, End), so these
// tests make no assumption about CodeMirror internals.
//
// Doc text in the read view is checked through `.preview-pane` (00 §4.6).
//
// ACs left to the blind verifier (manual-agent): none are tagged manual-agent;
// the spec's "edge cases" list (CJK IME composition, tables, `> - a`, `1)` markers…)
// is for the adversarial verifier.
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
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac09-'))
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

// ════════════════════════════════════════════════════════════════════════════

describe('#9 shortcuts — wrap / link / code in the browser', () => {
  it('AC-09.1 `world` selected + Mod+B → `hello **world**`, `world` still selected; Mod+B again → `hello world`', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Bold\n\nhello world\n'
      await editLocal(page, doc)
      await selectWord(page, 2, 'world')
      await page.keyboard.press(`${MOD}+b`)
      await expectText(page, '# Bold\n\nhello **world**\n', 'Mod+B wraps the selection')
      assert.equal(await domSelection(page), 'world', 'the original text stays selected inside the markers')
      await page.keyboard.press(`${MOD}+b`)
      await expectText(page, doc, 'Mod+B again unwraps')
      // The bare text is still selected: typing replaces exactly `world`.
      await page.keyboard.type('Z')
      await expectText(page, '# Bold\n\nhello Z\n', 'after unwrapping, `world` is still the selection')
    } finally { await context.close() }
  })

  it('rule 1c (e2e) empty selection inside a word + Mod+B wraps the word and keeps the caret offset', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# W\n\nplanning\n')
      await caret(page, 2, 4)
      await page.keyboard.press(`${MOD}+b`)
      await expectText(page, '# W\n\n**planning**\n', 'the word is wrapped')
      await page.keyboard.type('X')
      await expectText(page, '# W\n\n**planXning**\n', 'the caret kept its offset inside the word')
    } finally { await context.close() }
  })

  it('rule 1 (e2e) Mod+I wraps a selection in `*` (not CodeMirror select-parent-syntax)', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# I\n\nsome text here\n')
      await selectWord(page, 2, 'text')
      await page.keyboard.press(`${MOD}+i`)
      await expectText(page, '# I\n\nsome *text* here\n', 'Mod+I italicises')
      assert.equal(await domSelection(page), 'text', 'the selection stays on the bare text')
    } finally { await context.close() }
  })

  it('AC-09.3 empty line + Mod+Shift+X then typing `gone` → `~~gone~~`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Strike\n\n')
      await caret(page, 2, 0)
      await page.keyboard.press(`${MOD}+Shift+x`)
      await page.keyboard.type('gone')
      await expectText(page, '# Strike\n\n~~gone~~', 'the struck line')
    } finally { await context.close() }
  })

  it('AC-09.5 `docs` selected + Mod+K + typing a URL → `[docs](https://x.io)`; a URL selected + Mod+K + `site` → `[site](https://x.io)`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Link\n\ndocs\nhttps://x.io\n')
      await selectWord(page, 2, 'docs')
      await page.keyboard.press(`${MOD}+k`)
      await page.keyboard.type('https://x.io')
      await expectText(page, '# Link\n\n[docs](https://x.io)\nhttps://x.io\n', 'text → [text](url)')

      await select(page, 3, 0, 'https://x.io'.length)
      await page.keyboard.press(`${MOD}+k`)
      await page.keyboard.type('site')
      await expectText(page, '# Link\n\n[docs](https://x.io)\n[site](https://x.io)\n', 'url → [label](url)')
    } finally { await context.close() }
  })

  it('rule 3 (e2e) Mod+E wraps a selection in backticks; Mod+E on several whole lines makes a fenced block', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Code\n\nrun npm test\none\ntwo\n')
      await selectWord(page, 2, 'npm test')
      await page.keyboard.press(`${MOD}+e`)
      await expectText(page, '# Code\n\nrun `npm test`\none\ntwo\n', 'inline code')

      await caret(page, 3, 0)
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+End')
      await page.keyboard.press(`${MOD}+e`)
      await expectText(page, '# Code\n\nrun `npm test`\n```\none\ntwo\n```\n', 'fenced block around the selected lines')
      await page.keyboard.type('js')
      await expectText(page, '# Code\n\nrun `npm test`\n```js\none\ntwo\n```\n', 'the caret was at the end of the opening fence')
    } finally { await context.close() }
  })

  it('rule "preventDefault": Mod+B/I/K/E and Mod+Shift+X are consumed in a markdown doc (no browser action)', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Keys\n\nalpha beta\n')
      for (const key of ['b', 'i', 'k', 'e', 'Shift+x']) {
        await selectWord(page, 2, 'beta')
        await takeKeys(page)
        await page.keyboard.press(`${MOD}+${key}`)
        const keys = await takeKeys(page)
        const main = keys.find((k) => k.key.toLowerCase() === key.slice(-1) && (k.ctrl || k.meta))
        assert.ok(main, `Mod+${key}: keydown reached window (${JSON.stringify(keys)})`)
        assert.equal(main.prevented, true, `Mod+${key}: defaultPrevented`)
        // Put the line back for the next key (one undo per shortcut, #8).
        await page.keyboard.press(`${MOD}+z`)
        await expectText(page, '# Keys\n\nalpha beta\n', `Mod+${key} undone`)
      }
    } finally { await context.close() }
  })
})

describe('#9 shortcuts — Enter / Backspace list continuation', () => {
  it('AC-09.7 `- [x] done` + Enter → a new `- [ ] ` line with the caret after it', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Tasks\n\n- [x] done')
      await caretEnd(page, 2)
      await page.keyboard.press('Enter')
      await expectText(page, '# Tasks\n\n- [x] done\n- [ ] ', 'unchecked task continuation')
      await page.keyboard.type('Q')
      await expectText(page, '# Tasks\n\n- [x] done\n- [ ] Q', 'the caret is after the new marker')
    } finally { await context.close() }
  })

  it('AC-09.7 `3. three` / `4. four`, Enter at the end of `3. three` → new `4. ` and `4. four` becomes `5. four`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Ordered\n\n3. three\n4. four\n')
      await caretEnd(page, 2)
      await page.keyboard.press('Enter')
      await expectText(page, '# Ordered\n\n3. three\n4. \n5. four\n', 'N+1 marker and renumbered sibling')
    } finally { await context.close() }
  })

  it('rule 4: `9. nine` + Enter → `10. ` and the following sibling is renumbered `11.`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Ten\n\n9. nine\n10. ten\n')
      await caretEnd(page, 2)
      await page.keyboard.press('Enter')
      await expectText(page, '# Ten\n\n9. nine\n10. \n11. ten\n', '9 → 10 continuation, 10 → 11')
    } finally { await context.close() }
  })

  it('rule 4: `- `, `* `, `+ ` bullets continue with the same marker; `1)` continues as `2)`', T, async () => {
    const { context, page } = await open()
    try {
      for (const [line, next] of [['- a', '- '], ['* a', '* '], ['+ a', '+ '], ['1) a', '2) ']]) {
        const doc = `# B\n\n${line}`
        await editLocal(page, doc)
        await caretEnd(page, 2)
        await page.keyboard.press('Enter')
        await expectText(page, `${doc}\n${next}`, `Enter after "${line}"`)
      }
    } finally { await context.close() }
  })

  it('rule 4: a nested item continues at its indent; a `> ` quote continues', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# N\n\n- a\n  - b')
      await caretEnd(page, 3)
      await page.keyboard.press('Enter')
      await expectText(page, '# N\n\n- a\n  - b\n  - ', 'nested continuation')

      await editLocal(page, '# Q\n\n> quoted')
      await caretEnd(page, 2)
      await page.keyboard.press('Enter')
      await expectText(page, '# Q\n\n> quoted\n> ', 'quote continuation')
    } finally { await context.close() }
  })

  it('AC-09.8 Enter on the empty second item of a tight list removes the marker, inserts no blank line, preview shows one item', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# L\n\n- a\n- ')
      await caretEnd(page, 3)
      await page.keyboard.press('Enter')
      await expectText(page, '# L\n\n- a\n', 'the empty item lost its marker and no blank line was inserted')
      assert.equal(await settledText(page), '# L\n\n- a\n', 'no further change')
      await toRead(page)
      await previewHas(page, () => {
        const p = document.querySelector('.preview-pane')
        return p && p.querySelectorAll('ul').length === 1 && p.querySelectorAll('li').length === 1 && p.querySelector('li').textContent.trim() === 'a'
      }, null, 'the preview shows a one-item list')
    } finally { await context.close() }
  })

  it('AC-09.8 Enter on an empty nested item `  - ` under `- a` → it becomes a top-level `- ` item', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# L\n\n- a\n  - ')
      await caretEnd(page, 3)
      await page.keyboard.press('Enter')
      await expectText(page, '# L\n\n- a\n- ', 'outdented one level with the parent marker')
    } finally { await context.close() }
  })

  it('rule 4: Enter inside a fenced code block inserts a plain newline (no list marker)', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '# F\n\n```\n  - x\n```\n'
      await editLocal(page, doc)
      await caretEnd(page, 3)
      await page.keyboard.press('Enter')
      const t = await waitEditorText(page, (s) => s.split('\n').length === doc.split('\n').length + 1, 'a new line')
      const added = t.split('\n')[4]
      assert.match(added, /^\s*$/, `the new line inside the fence has no list marker: ${JSON.stringify(added)}`)
    } finally { await context.close() }
  })

  it('rule 5: Backspace right after an empty `- ` / `> ` marker removes the marker', T, async () => {
    const { context, page } = await open()
    try {
      for (const marker of ['- ', '> ']) {
        await editLocal(page, `# M\n\n${marker}`)
        await caretEnd(page, 2)
        await page.keyboard.press('Backspace')
        await expectText(page, '# M\n\n', `Backspace after "${marker}"`)
      }
    } finally { await context.close() }
  })
})

describe('#9 shortcuts — Tab / Shift+Tab', () => {
  it('AC-09.9 `- a` / `- b`, Tab on b → `  - b` nested in the preview; Shift+Tab → `- b` again', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# T\n\n- a\n- b')
      await caretEnd(page, 3)
      await page.keyboard.press('Tab')
      await expectText(page, '# T\n\n- a\n  - b', 'Tab nests b under a')
      assert.ok(await focusInEditor(page), 'Tab is consumed by the editor (focus stays)')
      await page.keyboard.press('Shift+Tab')
      await expectText(page, '# T\n\n- a\n- b', 'Shift+Tab outdents b')

      await page.keyboard.press('Tab')
      await expectText(page, '# T\n\n- a\n  - b', 'Tab again')
      await toRead(page)
      await previewHas(page, () => {
        const outer = document.querySelector('.preview-pane ul')
        const li = outer?.querySelector(':scope > li')
        const nested = li?.querySelector(':scope > ul > li')
        return !!nested && nested.textContent.trim() === 'b' && outer.querySelectorAll(':scope > li').length === 1
      }, null, 'b is in a nested ul inside the a item')
    } finally { await context.close() }
  })

  it('AC-09.9 `1. a` / `2. b`, Tab on b → b\'s line starts with 3 spaces and the preview shows a nested ol', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# O\n\n1. a\n2. b')
      await caretEnd(page, 3)
      await page.keyboard.press('Tab')
      const t = await waitEditorText(page, (s) => /^ {3}\S/.test(s.split('\n')[3] ?? ''), 'b indented by 3')
      assert.match(t.split('\n')[3], /^ {3}\d+[.)] b$/, `b's line: ${JSON.stringify(t.split('\n')[3])}`)
      await toRead(page)
      await previewHas(page, () => {
        const li = document.querySelector('.preview-pane ol > li')
        const nested = li?.querySelector(':scope > ol > li')
        return !!nested && nested.textContent.trim() === 'b'
      }, null, 'b is in a nested ol inside the a item')
    } finally { await context.close() }
  })

  it('rule 6: Tab after a `10. ` sibling indents by 4; Tab on a first item (no previous sibling) changes nothing and keeps focus', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# W\n\n10. a\n11. b')
      await caretEnd(page, 3)
      await page.keyboard.press('Tab')
      const t = await waitEditorText(page, (s) => /^ {4}\S/.test(s.split('\n')[3] ?? ''), 'b indented by 4')
      assert.match(t.split('\n')[3], /^ {4}\d+[.)] b$/)

      await editLocal(page, '# F\n\n- first')
      await caretEnd(page, 2)
      await page.keyboard.press('Tab')
      assert.equal(await settledText(page), '# F\n\n- first', 'a first item with no previous sibling is left unchanged')
      assert.ok(await focusInEditor(page), 'the Tab key is still consumed (focus stays in the editor)')
    } finally { await context.close() }
  })

  it('AC-09.10 Tab alone on a non-list line inserts two spaces and focus stays in the editor', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# P\n\nplain')
      await caret(page, 2, 0)
      await page.keyboard.press('Tab')
      await expectText(page, '# P\n\n  plain', 'two spaces at the caret')
      assert.ok(await focusInEditor(page), 'focus stays in .cm-editor')
    } finally { await context.close() }
  })

  it('AC-09.10 Esc then Tab moves focus out of the editor', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# E\n\nplain')
      await caret(page, 2, 0)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Tab')
      await until(async () => !(await focusInEditor(page)), { timeout: 2000, message: 'focus to leave .cm-editor' })
      const inside = await page.evaluate(() => !!document.activeElement?.closest?.('.cm-editor'))
      assert.equal(inside, false, 'document.activeElement is outside .cm-editor')
      assert.equal(await editorText(page), '# E\n\nplain', 'the Tab inserted nothing')
    } finally { await context.close() }
  })

  it('rule 6: on non-list lines Tab indents every selected line by two; Shift+Tab removes up to two leading spaces', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# S\n\none\ntwo\n   three')
      await caret(page, 2, 0)
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+End')
      await page.keyboard.press('Tab')
      await expectText(page, '# S\n\n  one\n  two\n   three', 'both selected lines indented by two')
      await caret(page, 4, 0)
      await page.keyboard.press('Shift+Tab')
      await expectText(page, '# S\n\n  one\n  two\n three', 'Shift+Tab removes two of the three leading spaces')
    } finally { await context.close() }
  })
})

describe('#9 shortcuts — line moves, comments, undo', () => {
  it('AC-09.11 Alt+↑ on `two` → two/one/three; then Shift+Alt+↓ duplicates `two` below itself', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'one\ntwo\nthree')
      await caret(page, 1, 1)
      await page.keyboard.press('Alt+ArrowUp')
      await expectText(page, 'two\none\nthree', 'Alt+↑ moves the line up')
      await page.keyboard.press('Shift+Alt+ArrowDown')
      await expectText(page, 'two\ntwo\none\nthree', 'Shift+Alt+↓ duplicates the line below')
    } finally { await context.close() }
  })

  it('rule 7: Alt+↓ moves all selected lines down together', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'a\nb\nc\nd')
      await caret(page, 0, 0)
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Shift+End') // `a` and `b` selected
      await page.keyboard.press('Alt+ArrowDown')
      await expectText(page, 'c\na\nb\nd', 'the selected block moved down one line')
    } finally { await context.close() }
  })

  it('AC-09.12 `secret` selected + Mod+/ → `<!-- secret -->`; again → `secret`; commented text is not in the preview', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# C\n\nsecret\nvisible')
      await select(page, 2, 0, 'secret'.length)
      await page.keyboard.press(`${MOD}+/`)
      await expectText(page, '# C\n\n<!-- secret -->\nvisible', 'Mod+/ comments the line')
      await page.keyboard.press(`${MOD}+/`)
      await expectText(page, '# C\n\nsecret\nvisible', 'Mod+/ again restores it')
      await page.keyboard.press(`${MOD}+/`)
      await expectText(page, '# C\n\n<!-- secret -->\nvisible', 'commented once more for the preview check')
      await toRead(page)
      await previewHas(page, () => {
        const p = document.querySelector('.preview-pane')
        return !!p && p.textContent.includes('visible') && !p.textContent.includes('secret')
      }, null, 'the preview renders `visible` but no `secret` text')
    } finally { await context.close() }
  })

  it('AC-09.13 each of Mod+B, Mod+K, Mod+E, Mod+I, Mod+Shift+X on a selection is undone by ONE Mod+Z', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Undo\n\nalpha beta gamma\n'
      await editLocal(page, doc)
      for (const key of ['b', 'k', 'e', 'i', 'Shift+x']) {
        await selectWord(page, 2, 'beta')
        await page.keyboard.press(`${MOD}+${key}`)
        await waitEditorText(page, (t) => t !== doc, `Mod+${key} changes the doc`)
        await page.keyboard.press(`${MOD}+z`)
        await expectText(page, doc, `one Mod+Z after Mod+${key} restores the pre-shortcut text`)
      }
    } finally { await context.close() }
  })
})

describe('#9 shortcuts — no conflicts, HTML docs, read view', () => {
  it('AC-09.14 in a shared doc with unsaved edits, Mod+S from inside the editor sends a save; Mod+F opens the CodeMirror search panel', T, async () => {
    const { context, page } = await open()
    try {
      const marker = 'Shared shortcuts body.'
      const doc = await createDoc({ markdown: `# Shared\n\n${marker}\n`, sessionName: uniq('Shortcuts') })
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, marker)
      await toEdit(page)
      await waitEditorText(page, (t) => t.includes(marker), 'the shared doc in the editor')

      const writes = []
      page.on('request', (r) => {
        if (!['PUT', 'PATCH'].includes(r.method())) return
        try { if (/\/paste\/[^/]+\/markdown\/?$/.test(new URL(r.url()).pathname)) writes.push(Date.now()) } catch {}
      })
      await caretEnd(page, 2)
      await page.keyboard.type(' edited')
      const pressed = Date.now()
      await page.keyboard.press(`${MOD}+s`)
      // Autosave fires 2 s after the last keystroke; a save inside 1.2 s is Mod+S.
      await until(() => writes.some((t) => t >= pressed), { timeout: 1200, message: 'a save request after Mod+S' })

      await page.keyboard.press(`${MOD}+f`)
      await page.locator('.cm-editor:visible .cm-search').first().waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-09.15 HTML doc with `<b>x</b>` selected: Mod+B, Mod+K, Mod+E leave the text unchanged and open no browser UI', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '<p>intro</p>\n<b>x</b>\n'
      await editLocalHtml(page, doc)
      for (const key of ['b', 'k', 'e']) {
        await select(page, 1, 0, '<b>x</b>'.length)
        await page.keyboard.press(`${MOD}+${key}`)
        assert.equal(await settledText(page), doc, `Mod+${key} leaves the HTML text unchanged`)
        assert.equal(await page.evaluate(() => document.hasFocus()), true, `Mod+${key}: the page still has focus`)
        assert.equal(context.pages().length, 1, `Mod+${key}: no new tab/window opened`)
      }
    } finally { await context.close() }
  })

  it('rule 9: in an HTML doc Mod+B/K/E are consumed (preventDefault) and Tab inserts two spaces', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '<p>intro</p>\n<b>x</b>\n'
      await editLocalHtml(page, doc)
      for (const key of ['b', 'k', 'e']) {
        await select(page, 1, 0, '<b>x</b>'.length)
        await takeKeys(page)
        await page.keyboard.press(`${MOD}+${key}`)
        const k = (await takeKeys(page)).find((e) => e.key.toLowerCase() === key && (e.ctrl || e.meta))
        assert.ok(k, `Mod+${key} keydown reached window`)
        assert.equal(k.prevented, true, `Mod+${key} is consumed in an HTML doc`)
      }
      await caret(page, 1, 0)
      await page.keyboard.press('Tab')
      await expectText(page, '<p>intro</p>\n  <b>x</b>\n', 'Tab = two spaces in an HTML doc')
    } finally { await context.close() }
  })

  it('rule 10: in the read view Mod+B/K/E and Mod+Shift+X do not touch the document', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Read\n\nread view text\n'
      await page.goto(localDocUrl(doc))
      await waitForText(page, 'read view text')
      await page.locator('.preview-pane').first().waitFor({ state: 'visible', timeout: 10_000 })
      // Select some preview text, then try the editor shortcuts.
      await page.locator('.preview-pane p').first().dblclick()
      for (const key of [`${MOD}+b`, `${MOD}+k`, `${MOD}+e`, `${MOD}+Shift+x`]) await page.keyboard.press(key)
      const p = await page.locator('.preview-pane').first().textContent()
      assert.ok(p.includes('read view text') && !p.includes('**') && !p.includes('~~'), `preview unchanged: ${JSON.stringify(p)}`)
      await toEdit(page)
      await expectText(page, doc, 'the document is unchanged')
    } finally { await context.close() }
  })

  it('rule 1 (emulated mac): Cmd+B bolds; Ctrl+B does NOT bold (Mod is Cmd on macOS)', T, async () => {
    const { context, page } = await open({ platform: 'mac' })
    try {
      const doc = '# Mac\n\nmac word\n'
      await editLocal(page, doc)
      await selectWord(page, 2, 'word')
      await page.keyboard.press('Control+b')
      assert.equal(await settledText(page), doc, 'Ctrl+B on mac does not bold')
      await selectWord(page, 2, 'word')
      await page.keyboard.press('Meta+b')
      await expectText(page, '# Mac\n\nmac **word**\n', 'Cmd+B bolds on mac')
    } finally { await context.close() }
  })
})

describe('#9 shortcuts overlay', () => {
  it('AC-09.16 editor-shortcuts-btn opens a modal shortcuts-overlay with ≥ 14 rows incl. Bold/Link/Undo/Find; Bold shows the host labels; Esc closes and refocuses the button', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Help\n\nbody\n')
      const btn = shortcutsBtn(page)
      await btn.waitFor({ state: 'visible', timeout: 10_000 })
      await btn.click()
      const ov = overlay(page).first()
      await ov.waitFor({ state: 'visible', timeout: 5000 })

      assert.equal(await ov.getAttribute('role'), 'dialog', 'role="dialog"')
      assert.equal(await ov.getAttribute('aria-modal'), 'true', 'aria-modal="true"')
      const name = await ov.evaluate((el) => el.getAttribute('aria-label')
        ?? (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : null))
      assert.match(name ?? '', /keyboard shortcuts/i, `labelled "Keyboard shortcuts": ${JSON.stringify(name)}`)

      const rows = await page.locator(`${tid('shortcuts-overlay')} ${tid('shortcuts-row')}`).allInnerTexts()
      assert.ok(rows.length >= 14, `≥ 14 shortcuts-row items, got ${rows.length}: ${JSON.stringify(rows)}`)
      for (const label of [/\bBold\b/i, /\bLink\b/i, /\bUndo\b/i, /\bFind\b/i, /\bRedo\b/i, /\bSave\b/i, /\bItalic\b/i, /\bStrike/i, /\bcode\b/i]) {
        assert.ok(rows.some((r) => label.test(r)), `a row matching ${label}: ${JSON.stringify(rows)}`)
      }
      const bold = await rowText(page, /\bBold\b/i)
      const keys = bold.replace(/\bBold\b/i, ' ')
      if (HOST_MAC) {
        assert.match(keys, /⌘/, `Bold row shows ⌘ on macOS: ${JSON.stringify(bold)}`)
      } else {
        assert.match(keys, /\bCtrl\b/, `Bold row shows Ctrl on Linux/Windows: ${JSON.stringify(bold)}`)
        assert.doesNotMatch(keys, /⌘/, `no ⌘ off macOS: ${JSON.stringify(bold)}`)
      }
      assert.match(keys, /(^|[^A-Za-z])B([^A-Za-z]|$)/, `Bold row shows the B key: ${JSON.stringify(bold)}`)

      await page.keyboard.press('Escape')
      await expectOverlayClosed(page, 'Esc')
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      assert.equal(focused, 'editor-shortcuts-btn', 'focus returns to the button')
    } finally { await context.close() }
  })

  it('AC-09.16 (a11y) the open overlay has no serious/critical axe violations and traps focus', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Help\n\nbody\n')
      await shortcutsBtn(page).waitFor({ state: 'visible', timeout: 10_000 })
      await shortcutsBtn(page).click()
      await overlay(page).first().waitFor({ state: 'visible', timeout: 5000 })
      const v = await runAxe(page, { include: tid('shortcuts-overlay') })
      assert.equal(v.length, 0, formatViolations(v))
      for (const [i, key] of [...Array(6).fill('Tab'), ...Array(6).fill('Shift+Tab')].entries()) {
        await page.keyboard.press(key)
        const inside = await page.evaluate(() => !!document.activeElement?.closest?.('[data-testid="shortcuts-overlay"]'))
        assert.ok(inside, `focus stays inside the modal overlay (${key} #${i})`)
      }
    } finally { await context.close() }
  })

  it('AC-09.16 (emulated mac) the Bold row shows ⌘ and no Ctrl', T, async () => {
    const { context, page } = await open({ platform: 'mac' })
    try {
      await editLocal(page, '# Help\n\nbody\n')
      await shortcutsBtn(page).waitFor({ state: 'visible', timeout: 10_000 })
      await shortcutsBtn(page).click()
      await overlay(page).first().waitFor({ state: 'visible', timeout: 5000 })
      const bold = await rowText(page, /\bBold\b/i)
      assert.ok(bold, 'a Bold row')
      assert.match(bold, /⌘/, `mac Bold row: ${JSON.stringify(bold)}`)
      assert.doesNotMatch(bold, /\bCtrl\b/, `mac Bold row has no Ctrl: ${JSON.stringify(bold)}`)
    } finally { await context.close() }
  })

  it('rule 11: shortcuts-close-btn and a backdrop click close the overlay; the button sits after Undo/Redo, is labelled and titled with `?`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# Help\n\nbody\n')
      const btn = shortcutsBtn(page)
      await btn.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await btn.getAttribute('aria-label'), 'Keyboard shortcuts')
      assert.match((await btn.getAttribute('title')) ?? '', /\?/, 'title names its `?` shortcut')
      const order = await page.locator(tid('editor-toolbar')).first().evaluate((bar) =>
        [...bar.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
          .filter((i) => ['editor-undo-btn', 'editor-redo-btn', 'editor-shortcuts-btn'].includes(i)))
      assert.deepEqual(order, ['editor-undo-btn', 'editor-redo-btn', 'editor-shortcuts-btn'], 'toolbar order (00 §3.3)')

      await btn.click()
      await overlay(page).first().waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(`${tid('shortcuts-close-btn')}:visible`).first().click()
      await expectOverlayClosed(page, 'close button')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'editor-shortcuts-btn', 'close button returns focus to the opener')

      await btn.click()
      await overlay(page).first().waitFor({ state: 'visible', timeout: 5000 })
      // A click near the viewport corner lands on the backdrop, outside the dialog box.
      await page.mouse.click(5, 895)
      await expectOverlayClosed(page, 'backdrop click')
    } finally { await context.close() }
  })

  it('AC-09.17 `?` with focus on the page body opens the overlay (edit view); `?` in the editor inserts `?`; `?` in the read view does nothing', T, async () => {
    const { context, page } = await open()
    try {
      const doc = '# Q\n\nask\n'
      await editLocal(page, doc)
      await blurAll(page)
      assert.equal(await focusInEditor(page), false, 'precondition: focus is not in the editor')
      await page.keyboard.type('?')
      await overlay(page).first().waitFor({ state: 'visible', timeout: 3000 })
      await page.keyboard.press('Escape')
      await expectOverlayClosed(page, 'Esc after `?`')

      await caretEnd(page, 2)
      await page.keyboard.type('?')
      await expectText(page, '# Q\n\nask?\n', '`?` typed in the editor is inserted')
      await expectNoOverlay(page, 400, '`?` in the editor')

      await toRead(page)
      await blurAll(page)
      await page.keyboard.type('?')
      await expectNoOverlay(page, 400, '`?` in the read view')
    } finally { await context.close() }
  })
})
