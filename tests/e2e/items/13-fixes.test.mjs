// #13 fix round (orchestrator product call + owner fix-everything policy):
//   - History stays reachable in focus mode: `focus-history-btn` in the editor
//     toolbar opens the same History dialog; Esc closes the dialog first, a
//     second Esc exits focus mode (00 §3.4).
//   - Below 960px the split tabs keep their full width in focus mode (the
//     focus controls sit in the toolbar row under them, clear of the tabs).
//   - The header stays mounted while hidden: a filename edit in progress
//     survives entering and leaving focus mode.
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

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-13fix-'))
})
after(async () => {
  await browser?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function open(viewport = { width: 1400, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page }
}

let seq = 0
function localDocUrl(text, query = '') {
  const p = join(tmp, `fix13-${++seq}.md`)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}${query}`
}

const editor = (page) => page.locator('.cm-editor:visible .cm-content').first()
const focusOn = (page) => page.evaluate(() => document.querySelector('.app')?.dataset.focusMode === 'true')

async function until(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${message}` })
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function enterFocus(page) {
  await page.locator(`${tid('editor-toolbar')} ${tid('focus-mode-btn')}`).click()
  await until(() => focusOn(page), { message: 'focus mode on' })
  await page.locator(tid('focus-exit-btn')).waitFor({ state: 'visible', timeout: 5000 })
}

const box = (page, sel) => page.locator(sel).first().evaluate((e) => {
  const r = e.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
})
const overlaps = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)

describe('#13 fixes', () => {
  it('History in focus mode: toolbar button opens it; Esc closes the dialog, a second Esc exits focus mode', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# History\n\nVersion one.\n', filename: 'h.md', sessionName: uniq('Focus history'), author: 'Alice' })
      await putMarkdown(doc.id, '# History\n\nVersion two.\n', { author: 'Bob' })
      await page.goto(`${BASE}/d/${doc.id}?view=edit`)
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await until(async () => (await editor(page).textContent()).includes('Version two.'), { message: 'v2 shown' })
      assert.equal(await page.locator(tid('focus-history-btn')).count(), 0, 'no History button outside focus mode')
      await enterFocus(page)
      const btn = page.locator(`${tid('editor-toolbar')} ${tid('focus-history-btn')}`)
      await btn.waitFor({ state: 'visible', timeout: 3000 })
      assert.equal(await btn.getAttribute('aria-label'), 'History')
      await btn.click()
      await page.locator(tid('revisions-modal')).waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await focusOn(page), true, 'still in focus mode with History open')
      await page.keyboard.press('Escape')
      await page.locator(tid('revisions-modal')).waitFor({ state: 'detached', timeout: 3000 })
      await page.waitForTimeout(150)
      assert.equal(await focusOn(page), true, 'the first Esc only closed History')
      await page.keyboard.press('Escape')
      await until(async () => !(await focusOn(page)), { message: 'the second Esc exits focus mode' })
    } finally { await context.close() }
  })

  it('History button: absent for an unshared local doc (no history), as in the header menu', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl('# Local\n\nNo history here.\n', '&view=edit'))
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await enterFocus(page)
      assert.equal(await page.locator(tid('focus-history-btn')).count(), 0)
    } finally { await context.close() }
  })

  for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    it(`narrow split in focus mode (${viewport.width}px): the tabs keep the full width; the controls cover no tab, button or first line`, T, async () => {
      const { context, page } = await open(viewport)
      try {
        await page.goto(localDocUrl('A first line long enough to run under any top-right control on a narrow screen\n\nmore\n', '&view=split'))
        await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
        const before = await box(page, tid('split-tabs'))
        await enterFocus(page)
        const tabs = await box(page, tid('split-tabs'))
        const vw = await page.evaluate(() => document.documentElement.clientWidth)
        assert.ok(Math.abs(tabs.width - vw) <= 2, `tabs span the viewport (${tabs.width} vs ${vw}; before ${before.width})`)
        const controls = await box(page, tid('focus-controls'))
        for (const id of ['split-tab-edit', 'split-tab-preview', 'focus-mode-btn', 'editor-shortcuts-btn', 'editor-undo-btn']) {
          assert.ok(!overlaps(controls, await box(page, tid(id))), `focus controls overlap ${id}`)
        }
        const exit = await box(page, tid('focus-exit-btn'))
        if (viewport.width < 641) assert.ok(exit.width >= 40 && exit.height >= 40, `exit ${exit.width}×${exit.height}`)
        const line = await page.evaluate(() => {
          const l = [...document.querySelectorAll('[data-testid="split-pane-editor"] .cm-line')][0]
          const r = document.createRange(); r.selectNodeContents(l)
          return [...r.getClientRects()].map((x) => ({ left: x.left, right: x.right, top: x.top, bottom: x.bottom }))
        })
        for (const r of line) assert.ok(!overlaps(controls, r), `first line ${JSON.stringify(r)} under the controls`)
        // The Preview tab: its bar holds the controls the same way.
        await page.locator(tid('split-tab-preview')).click()
        await page.locator(`${tid('split-pane-preview')} .preview-pane`).waitFor({ state: 'visible' })
        const c2 = await box(page, tid('focus-controls'))
        assert.ok(!overlaps(c2, await box(page, tid('split-sync-toggle'))), 'controls clear of the sync toggle')
        assert.ok(!overlaps(c2, await box(page, tid('split-tab-preview'))), 'controls clear of the Preview tab')
        const hs = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        assert.ok(hs <= 0, `no horizontal scroll (${hs})`)
      } finally { await context.close() }
    })
  }

  it('the header stays mounted in focus mode: a filename edit in progress is kept across entering and leaving', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl('# Rename\n\nBody.\n', '&view=edit'))
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await page.locator(`${tid('doc-header')} .filename`).first().click()
      const input = page.locator(`${tid('doc-header')} input`).first()
      await input.waitFor({ state: 'visible', timeout: 3000 })
      await input.fill('renamed-in-progress.md')
      await page.keyboard.press(FOCUS_KEY)
      await until(() => focusOn(page), { message: 'on' })
      assert.equal(await page.locator(tid('doc-header')).isVisible(), false, 'header hidden')
      await page.locator(tid('focus-exit-btn')).click()
      await until(async () => !(await focusOn(page)), { message: 'off' })
      // Entering focus mode moves focus into the editor, which commits the field (its blur rule);
      // either way the typed name is not lost.
      const shown = await page.evaluate(() => {
        const h = document.querySelector('[data-testid="doc-header"]')
        const i = h.querySelector('input')
        return i ? i.value : h.querySelector('.filename')?.textContent?.trim()
      })
      assert.equal(shown, 'renamed-in-progress.md')
    } finally { await context.close() }
  })
})
