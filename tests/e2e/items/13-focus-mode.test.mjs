// #13 Focus mode — acceptance tests (docs/build/specs/13-focus-mode.md,
// 00 §3.3 EditorToolbar, §3.4 Esc layering, §3.5 Mod+Shift+Enter, §10.2 data-focus-mode).
//
// Key combos use Playwright's `ControlOrMeta` (Ctrl on Linux/Windows, Cmd on a
// mac host). Remote changes are simulated with a PUT to the throwaway backend
// while the page is open (as durable-sync.test.mjs does).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq } from '../lib/docs.mjs'

const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const FOCUS_KEY = `${MOD}+Shift+Enter`
const POLL_WAIT = 15_000

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac13-'))
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
  return { context, page, errors }
}

let seq = 0
function localDocUrl(text, query = '') {
  const p = join(tmp, `focus-${++seq}.md`)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}${query}`
}

const BASIC = '# Focus doc\n\nFirst paragraph of the focus doc.\n\nSecond paragraph.\n'
const editor = (page) => page.locator('.cm-editor:visible .cm-content').first()
const focusOn = (page) => page.evaluate(() => document.querySelector('.app')?.dataset.focusMode === 'true')

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

/** A local doc (review mode via the dev loader, so the comments sidebar exists) in `view`. */
async function openLocal(page, view = 'edit', text = BASIC) {
  await page.goto(localDocUrl(text, `&view=${view}`))
  await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
}

async function openShared(page, markdown, view = 'edit') {
  const doc = await createDoc({ markdown, filename: 'focus.md', sessionName: uniq('Focus'), mode: 'review' })
  await page.goto(`${BASE}/d/${doc.id}?view=${view}`)
  await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
  return doc
}

const editorText = (page) => page.evaluate(() => {
  const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
  return ed ? [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n') : null
})

const visibleBox = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  if (getComputedStyle(el).visibility === 'hidden') return null
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
}, sel)

async function enterFocusByButton(page) {
  await page.locator(`${tid('editor-toolbar')} ${tid('focus-mode-btn')}`).click()
  await until(() => focusOn(page), { message: 'data-focus-mode="true"' })
  // The floating controls are a lazily loaded component: wait until they are drawn.
  await page.locator(tid('focus-exit-btn')).waitFor({ state: 'visible', timeout: 5000 })
}

describe('#13 focus mode', () => {
  it('AC-13.1 the toolbar button hides header, sidebar and banners; main pane spans the viewport; exit button shown', T, async () => {
    const { context, page, errors } = await open()
    try {
      await openLocal(page)
      const btn = page.locator(`${tid('editor-toolbar')} ${tid('focus-mode-btn')}`)
      assert.equal(await btn.getAttribute('aria-pressed'), 'false')
      assert.equal(await page.locator(tid('doc-header')).isVisible(), true, 'precondition: header visible')
      assert.ok(await page.locator('.sidebar').first().isVisible(), 'precondition: comments sidebar visible')
      await enterFocusByButton(page)
      assert.equal(await btn.getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator(tid('doc-header')).isVisible(), false, 'header hidden')
      for (const sel of ['.sidebar', '.sidebar-toggle', tid('comments-toggle'), '.notice-bar:not([data-testid="persist-error"])']) {
        const n = await page.locator(sel).count()
        for (let i = 0; i < n; i++) assert.equal(await page.locator(sel).nth(i).isVisible(), false, `${sel} hidden`)
      }
      const main = await visibleBox(page, '.main-pane')
      const vw = await page.evaluate(() => document.documentElement.clientWidth)
      assert.ok(Math.abs(main.width - vw) <= 2, `.main-pane ${main.width} vs viewport ${vw}`)
      assert.ok(await page.locator(tid('focus-exit-btn')).isVisible(), 'exit button visible')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-13.1 (review doc) approval and summary banners hide in focus mode and come back on exit', T, async () => {
    const { context, page } = await open()
    try {
      await openShared(page, '# Banner focus\n\nBody.\n')
      const summary = page.locator('.summary-panel').first()
      await summary.waitFor({ state: 'visible', timeout: 10_000 })
      const approval = page.locator('.approval-banner').first()
      const hadApproval = await approval.isVisible().catch(() => false)
      await enterFocusByButton(page)
      assert.equal(await summary.isVisible(), false, 'summary hidden')
      if (hadApproval) assert.equal(await approval.isVisible(), false, 'approval banner hidden')
      await page.locator(tid('focus-exit-btn')).click()
      await until(async () => !(await focusOn(page)), { message: 'off' })
      assert.equal(await summary.isVisible(), true, 'summary back')
      if (hadApproval) assert.equal(await approval.isVisible(), true, 'approval banner back')
    } finally { await context.close() }
  })

  it('edge: browser Back to another document while in focus mode shows the chrome there', T, async () => {
    const { context, page } = await open()
    try {
      const b = await createDoc({ markdown: '# Doc B\n\nBody of doc B.\n', sessionName: uniq('Focus B') })
      const a = await createDoc({ markdown: `# Doc A\n\n[Go to B](/d/${b.id})\n`, sessionName: uniq('Focus A') })
      await page.goto(`${BASE}/d/${a.id}`)
      await page.locator('.preview-pane a').filter({ hasText: 'Go to B' }).click()
      await page.locator('.preview-pane').filter({ hasText: 'Body of doc B.' }).first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(tid('view-toggle-edit')).click()
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await enterFocusByButton(page)
      await page.goBack()
      await page.locator('.preview-pane').filter({ hasText: 'Go to B' }).first().waitFor({ state: 'visible', timeout: 10_000 })
      await until(async () => !(await focusOn(page)), { message: 'focus mode off on the other doc' })
      assert.ok(await page.locator(tid('doc-header')).isVisible(), 'header visible')
    } finally { await context.close() }
  })

  it('AC-13.2 Edit view at 1400px: the .cm-content container is ≤ 860px and centred', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await enterFocusByButton(page)
      const g = await page.evaluate(() => {
        const c = [...document.querySelectorAll('.cm-content')].find((e) => e.getClientRects().length > 0).parentElement.getBoundingClientRect()
        return { width: c.width, left: c.left, right: document.documentElement.clientWidth - c.right }
      })
      assert.ok(g.width <= 860, `container ${g.width}px`)
      assert.ok(Math.abs(g.left - g.right) <= 20, `margins ${g.left} / ${g.right}`)
    } finally { await context.close() }
  })

  it('AC-13.3 Mod+Shift+Enter toggles focus mode and keeps the caret where it was', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await page.locator('.cm-editor:visible .cm-line').filter({ hasText: 'Second paragraph.' }).click()
      await page.keyboard.press('End')
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'focus mode on' })
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.cm-content')), 'focus still in the editor')
      await page.keyboard.type('X')
      await until(async () => (await editorText(page))?.includes('Second paragraph.X'), { message: 'X at the old caret' })
      await page.keyboard.press(FOCUS_KEY)
      await until(async () => !(await focusOn(page)), { message: 'focus mode off' })
      assert.ok(await page.locator(tid('doc-header')).isVisible(), 'header back')
      assert.ok(!(await editorText(page)).includes('\n\n\n'), 'the shortcut inserted no newline')
    } finally { await context.close() }
  })

  it('AC-13.4 Esc in the editor with nothing open exits focus mode', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await editor(page).click()
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'on' })
      await page.keyboard.press('Escape')
      await until(async () => !(await focusOn(page)), { message: 'off after Esc' })
      assert.ok(await page.locator(tid('doc-header')).isVisible())
    } finally { await context.close() }
  })

  it('AC-13.5 Esc closes the search panel first, then exits focus mode', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await editor(page).click()
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'on' })
      await page.keyboard.press(`${MOD}+f`)
      await page.locator('.cm-search').waitFor({ state: 'visible', timeout: 3000 })
      await page.keyboard.press('Escape')
      await page.locator('.cm-search').waitFor({ state: 'detached', timeout: 3000 })
      assert.equal(await focusOn(page), true, 'still in focus mode after the first Esc')
      await page.keyboard.press('Escape')
      await until(async () => !(await focusOn(page)), { message: 'off after the second Esc' })
    } finally { await context.close() }
  })

  it('AC-13.5 (selection) a non-empty selection: the first Esc collapses it, the second exits', T, async () => {
    const { context, page } = await open()
    try {
      // A publish-mode doc: no comment action bar on selection.
      const doc = await createDoc({ markdown: BASIC, filename: 'sel.md', sessionName: uniq('Focus sel') })
      await page.goto(`${BASE}/d/${doc.id}?view=edit`)
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await page.locator('.cm-editor:visible .cm-line').filter({ hasText: 'Second paragraph.' }).click()
      await page.keyboard.press('End')
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'on' })
      await page.keyboard.press('Shift+Home')
      const selected = () => page.evaluate(() => (window.getSelection()?.toString() ?? '').length)
      await until(async () => (await selected()) > 0, { message: 'a selection' })
      await page.keyboard.press('Escape')
      await until(async () => (await selected()) === 0, { message: 'selection collapsed' })
      assert.equal(await focusOn(page), true, 'still in focus mode')
      await page.keyboard.press('Escape')
      await until(async () => !(await focusOn(page)), { message: 'off' })
    } finally { await context.close() }
  })

  it('AC-13.5 (comment action bar) review doc: Esc closes the action bar first, focus mode stays on', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await page.locator('.cm-editor:visible .cm-line').filter({ hasText: 'Second paragraph.' }).click()
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'on' })
      await page.keyboard.press('End')
      await page.keyboard.press('Shift+Home')
      const bar = page.locator('.selection-action-bar .action-btn').first()
      await bar.waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press('Escape')
      await bar.waitFor({ state: 'hidden', timeout: 3000 })
      assert.equal(await focusOn(page), true, 'focus mode stays on while a layer closes')
    } finally { await context.close() }
  })
  it('AC-13.6 with the shortcuts overlay open, Esc closes only the overlay', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await enterFocusByButton(page)
      await page.locator(tid('editor-shortcuts-btn')).click()
      await page.locator(tid('shortcuts-overlay')).waitFor({ state: 'visible', timeout: 3000 })
      await page.keyboard.press('Escape')
      await page.locator(tid('shortcuts-overlay')).waitFor({ state: 'detached', timeout: 3000 })
      await page.waitForTimeout(100)
      assert.equal(await focusOn(page), true, 'focus mode stays on')
    } finally { await context.close() }
  })

  it('00 §3.4: Mod+Shift+Enter does nothing under an open dialog (History), so one Esc never closes two layers', T, async () => {
    const { context, page } = await open()
    try {
      await openShared(page, '# Dialog focus\n\nBody.\n')
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('menu-history')).click()
      await page.locator(tid('revisions-modal')).waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press(FOCUS_KEY)
      await page.waitForTimeout(200)
      assert.equal(await focusOn(page), false, 'no focus mode under the dialog')
      await page.keyboard.press('Escape')
      await page.locator(tid('revisions-modal')).waitFor({ state: 'detached', timeout: 3000 })
      await editor(page).click()
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'focus mode after the dialog closed' })
    } finally { await context.close() }
  })

  it('AC-13.7 shared doc: focus-save-state shows "Unsaved changes", then "Saved" after autosave', T, async () => {
    const { context, page } = await open()
    try {
      await openShared(page, '# Save focus\n\nBody.\n')
      await enterFocusByButton(page)
      await editor(page).click()
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.type(' typed in focus')
      const st = page.locator(tid('focus-save-state'))
      await until(async () => /Unsaved changes|Saving/.test((await st.textContent().catch(() => '')) ?? ''), { message: 'Unsaved changes' })
      await until(async () => ((await st.textContent().catch(() => '')) ?? '').trim() === 'Saved', { timeout: 10_000, message: 'Saved' })
    } finally { await context.close() }
  })

  it('AC-13.8 a conflict shows conflict-bar while focus mode stays on', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await openShared(page, '# Conflict focus\n\nbody\n')
      await enterFocusByButton(page)
      await editor(page).click()
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.type(' MINE')
      await putMarkdown(doc.id, '# Conflict focus\n\nbody THEIRS\n', { author: 'agent' })
      await page.locator(tid('conflict-bar')).waitFor({ state: 'visible', timeout: POLL_WAIT })
      assert.equal(await focusOn(page), true)
      assert.equal(await page.locator(tid('focus-save-state')).textContent().then((t) => t.trim()), 'Conflict')
    } finally { await context.close() }
  })

  it('AC-13.9 Split view: editor, divider and preview span the viewport with the header hidden', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page, 'split')
      await page.locator(tid('split-divider')).waitFor({ state: 'visible', timeout: 10_000 })
      await enterFocusByButton(page)
      assert.equal(await page.locator(tid('doc-header')).isVisible(), false)
      const ed = await visibleBox(page, tid('split-pane-editor'))
      const dv = await visibleBox(page, tid('split-divider'))
      const pv = await visibleBox(page, tid('split-pane-preview'))
      assert.ok(ed && dv && pv, 'all three visible')
      const vw = await page.evaluate(() => document.documentElement.clientWidth)
      assert.ok(Math.abs(ed.left) <= 2, `editor starts at the left edge (${ed.left})`)
      assert.ok(Math.abs(pv.right - vw) <= 2, `preview ends at the right edge (${pv.right} vs ${vw})`)
      assert.ok(Math.abs((ed.width + dv.width + pv.width) - vw) <= 2, 'together they span the viewport')
    } finally { await context.close() }
  })

  it('AC-13.10 Read view or reload turns focus mode off; nothing in localStorage or the URL', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      const url = await page.evaluate(() => location.href)
      await enterFocusByButton(page)
      assert.equal(await page.evaluate(() => location.href), url, 'URL unchanged')
      const during = await page.evaluate(() => Object.entries(localStorage))
      for (const [k, v] of during) assert.ok(!/focus/i.test(k) && !/focus/i.test(v), `localStorage ${k}=${v.slice(0, 80)}`)
      // Exit, switch to Read: never on in Read.
      await page.keyboard.press(FOCUS_KEY)
      await until(async () => !(await focusOn(page)), { message: 'off' })
      await page.locator(tid('view-toggle-read')).click()
      await page.locator('.preview-pane').first().waitFor({ state: 'visible' })
      assert.equal(await focusOn(page), false)
      // Back to Edit, on again, then reload: off.
      await page.locator(tid('view-toggle-edit')).click()
      await editor(page).waitFor({ state: 'visible' })
      await enterFocusByButton(page)
      await page.reload()
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      assert.equal(await focusOn(page), false, 'off after reload')
      assert.ok(await page.locator(tid('doc-header')).isVisible())
    } finally { await context.close() }
  })

  it('AC-13.11 a collapsed sidebar stays collapsed after exit; typing in focus mode undoes after exit', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      const toggle = page.locator('.sidebar-toggle').first()
      await toggle.waitFor({ state: 'visible', timeout: 5000 })
      await toggle.click()
      const collapsed = () => page.evaluate(() => !!document.querySelector('.doc-aside.collapsed'))
      await until(collapsed, { message: 'sidebar collapsed' })
      await editor(page).click()
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'on' })
      await page.keyboard.type('FOCUSTYPED')
      await until(async () => (await editorText(page))?.includes('FOCUSTYPED'), { message: 'typed' })
      await page.locator(tid('focus-exit-btn')).click()
      await until(async () => !(await focusOn(page)), { message: 'off' })
      assert.equal(await collapsed(), true, 'sidebar still collapsed')
      await editor(page).focus()
      await page.keyboard.press(`${MOD}+z`)
      await until(async () => !(await editorText(page))?.includes('FOCUSTYPED'), { message: 'undone after exit' })
    } finally { await context.close() }
  })

  it('AC-13.12 Read view: no focus button and the shortcut does nothing', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl(BASIC))
      await page.locator('.preview-pane').filter({ hasText: 'Second paragraph.' }).first().waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(await page.locator(`${tid('focus-mode-btn')}:visible`).count(), 0)
      await page.locator('.preview-pane p').first().click()
      await page.keyboard.press(FOCUS_KEY)
      await page.waitForTimeout(200)
      assert.equal(await focusOn(page), false)
    } finally { await context.close() }
  })

  it('AC-13.12 (viewer) a protected doc without a token: no focus button, shortcut does nothing', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Viewer focus\n\nViewer focus body.\n', protected: true, sessionName: uniq('Viewer focus') })
      await page.goto(`${BASE}/d/${doc.id}?view=edit`)
      await page.locator('.preview-pane').filter({ hasText: 'Viewer focus body.' }).first().waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(await page.locator(tid('focus-mode-btn')).count(), 0)
      await page.keyboard.press(FOCUS_KEY)
      await page.waitForTimeout(200)
      assert.equal(await focusOn(page), false)
    } finally { await context.close() }
  })

  it('AC-13.13 390×844: exit button ≥ 40×40, inside the viewport, clear of the first line, no horizontal scroll', T, async () => {
    const { context, page } = await open({ viewport: { width: 390, height: 844 } })
    try {
      await openLocal(page, 'edit', 'A first line long enough to run under any top-right control on a phone screen width\n\nmore\n')
      await enterFocusByButton(page)
      const b = await visibleBox(page, tid('focus-exit-btn'))
      assert.ok(b.width >= 40 && b.height >= 40, `exit ${b.width}×${b.height}`)
      const vw = await page.evaluate(() => document.documentElement.clientWidth)
      const vh = await page.evaluate(() => innerHeight)
      assert.ok(b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh, `inside viewport: ${JSON.stringify(b)}`)
      const line = await page.evaluate(() => {
        const l = [...document.querySelectorAll('.cm-line')].find((e) => e.getClientRects().length > 0)
        const range = document.createRange()
        range.selectNodeContents(l)
        return [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }))
      })
      const controls = await visibleBox(page, tid('focus-controls'))
      for (const r of line) {
        const overlap = !(r.right <= controls.left || r.left >= controls.right || r.bottom <= controls.top || r.top >= controls.bottom)
        assert.ok(!overlap, `first line text ${JSON.stringify(r)} overlaps the focus controls ${JSON.stringify(controls)}`)
      }
      const hs = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(hs <= 0, `horizontal scroll ${hs}`)
    } finally { await context.close() }
  })

  it('AC-13.14 focus controls are keyboard-focusable with names; cluster opacity < 0.5 at rest, 1 while focused', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      const btn = page.locator(tid('focus-mode-btn'))
      assert.equal(await btn.getAttribute('aria-label'), 'Focus mode')
      assert.match(await btn.getAttribute('title'), /Focus mode/)
      await enterFocusByButton(page)
      const exit = page.locator(tid('focus-exit-btn'))
      assert.equal(await exit.getAttribute('aria-label'), 'Exit focus mode')
      await page.mouse.move(5, 500)
      const opacity = () => page.locator(tid('focus-controls')).evaluate((e) => Number(getComputedStyle(e).opacity))
      await until(async () => (await opacity()) < 0.5, { message: 'resting opacity < 0.5' })
      await exit.focus()
      assert.ok(await exit.evaluate((e) => e === document.activeElement), 'exit button focusable')
      await until(async () => (await opacity()) === 1, { message: 'opacity 1 while focused' })
      await btn.focus()
      assert.ok(await btn.evaluate((e) => e === document.activeElement), 'focus-mode-btn focusable')
    } finally { await context.close() }
  })

  it('AC-13.15 the shortcuts overlay lists "Focus mode" with Mod+Shift+Enter', T, async () => {
    const { context, page } = await open()
    try {
      await openLocal(page)
      await page.locator(tid('editor-shortcuts-btn')).click()
      await page.locator(tid('shortcuts-overlay')).waitFor({ state: 'visible', timeout: 3000 })
      const rows = await page.locator(`${tid('shortcuts-overlay')} ${tid('shortcuts-row')}`).allInnerTexts()
      const row = rows.find((r) => /^Focus mode/.test(r.trim()))
      assert.ok(row, `a "Focus mode" row: ${JSON.stringify(rows)}`)
      const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || ''))
      if (mac) assert.match(row, /⇧⌘(Enter|↵)/)
      else assert.match(row, /Ctrl\+Shift\+Enter/)
    } finally { await context.close() }
  })
})
