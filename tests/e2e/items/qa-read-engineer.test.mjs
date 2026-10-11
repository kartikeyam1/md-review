// Persona QA "engineer" (writes + reviews, 1400×900) — regression tests for the read/shell/UI lane
// (scratchpad persona-engineer.md: M1, M2 (Share), M3, m1, m2, m5, m6, m8, m9, m10, c1–c5). Each failed on 8be2187.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq } from '../lib/docs.mjs'
import { openCtx, VIEWPORTS, tid, eventually } from './14-lib.mjs'

const T = { timeout: 60_000 }
const DOC = '# Capacity plan\n\nSome intro text for the plan.\n\n## Numbers\n\nMore numbers here.\n'
const NAME = 'Kartikeya Manchanda'
const withName = () => (n) => { try { if (!sessionStorage.getItem('__qa_name')) { localStorage.setItem('md-review-reviewer', n); sessionStorage.setItem('__qa_name', '1') } } catch { /* storage */ } }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

const key = (d) => d.slug || d.id
async function openEditor(page, d) {
  await page.goto(`${BASE}/d/${key(d)}?edit=${d.editToken}`)
  await page.locator('.preview-pane h1').waitFor({ timeout: 15_000 })
}
async function reviewDoc(markdown = DOC) {
  const d = await createDoc({ markdown, filename: 'plan.md', sessionName: uniq('Capacity plan'), mode: 'review', protected: true })
  await putMarkdown(d.id, markdown.replace('More numbers here.', 'More numbers here!'), { author: 'claude', editToken: d.editToken })
  return d
}
async function namedCtx(opts = {}) {
  const r = await openCtx(browser, opts)
  await r.context.addInitScript(withName(), NAME)
  return r
}

describe('qa-read: engineer persona', () => {
  it('M1 at 1400px in review mode the doc title stays readable; the meta moves to doc-meta-row', T, async () => {
    const d = await reviewDoc()
    for (const theme of ['locus-light', 'light']) {
      const { context, page } = await namedCtx({ viewport: VIEWPORTS.desktop, theme })
      try {
        await openEditor(page, d)
        await page.locator(tid('reviewer-name')).waitFor()
        await page.waitForTimeout(400)
        const r = await page.evaluate(() => {
          const h = document.querySelector('[data-testid="doc-header"]')
          const t = h.querySelector('[data-testid="doc-title"]')
          return { title: t.clientWidth, full: t.scrollWidth, overflow: h.scrollWidth - h.clientWidth }
        })
        assert.ok(r.title >= Math.min(160, r.full) - 1, `${theme}: title ${r.title}px of ${r.full}px`)
        assert.ok(r.overflow <= 1, `${theme}: header overflows by ${r.overflow}px`)
        await page.locator(`${tid('doc-meta-row')} ${tid('doc-updated')}`).waitFor({ timeout: 3000 })
      } finally { await context.close() }
    }
  })

  it('M2 the Share dialog traps focus, Esc closes it and focus returns to Share', T, async () => {
    const d = await reviewDoc()
    const { context, page } = await openCtx(browser)
    try {
      await openEditor(page, d)
      await page.locator(tid('share-btn')).focus()
      await page.keyboard.press('Enter')
      const dlg = page.locator(tid('share-dialog'))
      await dlg.waitFor()
      await eventually(async () => assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="share-dialog"]')), true, 'focus moved into the dialog'))
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab')
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="share-dialog"]')), true, `Tab ${i + 1} stays inside`)
      }
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })
      await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'share-btn'))
    } finally { await context.close() }
  })

  it('m8 the Generated Prompt dialog is a modal dialog: role, focus inside, Esc closes, focus back to the menu', T, async () => {
    const d = await reviewDoc()
    const { context, page } = await openCtx(browser)
    try {
      await openEditor(page, d)
      await page.locator(tid('header-overflow-btn')).click()
      await page.locator(tid('menu-generate-prompt')).click()
      const dlg = page.locator(tid('prompt-dialog'))
      await dlg.waitFor()
      assert.equal(await dlg.getAttribute('role'), 'dialog')
      assert.equal(await dlg.getAttribute('aria-modal'), 'true')
      await eventually(async () => assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="prompt-dialog"]')), true))
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })
      await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'header-overflow-btn'))
    } finally { await context.close() }
  })

  it('M3 a triple-click comment anchors on the paragraph only (card, highlight, prompt agree)', T, async () => {
    const d = await createDoc({ markdown: DOC, filename: 'plan.md', sessionName: uniq('Triple'), mode: 'review', protected: true })
    const { context, page } = await namedCtx()
    try {
      await openEditor(page, d)
      await page.locator('.preview-pane p', { hasText: 'Some intro text' }).click({ clickCount: 3 })
      await page.locator('.selection-action-bar .action-btn').click()
      await page.locator('.popover .popover-input').fill('Needs a source')
      await page.locator('.popover .category-btn', { hasText: /must/i }).click()
      await page.locator('.popover .btn-primary').click()
      const card = page.locator('.comment-card').first()
      await card.waitFor()
      assert.match(await card.innerText(), /\bL3\b(?!-)/, 'card says L3, not L3-5')
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.preview-pane .comment-highlight')].map((e) => e.tagName)), ['P'])
      assert.match(await page.locator('.attention-line').first().innerText(), /^L3$/)
    } finally { await context.close() }
  })

  it('m6 header controls share one 2px accent focus ring', T, async () => {
    const d = await reviewDoc()
    const { context, page } = await openCtx(browser, { theme: 'locus-light' })
    try {
      await openEditor(page, d)
      for (const id of ['app-home-link', 'nav-library', 'share-btn', 'copy-link-btn', 'slides-enter-btn']) {
        await page.locator(tid(id)).first().focus()
        await page.keyboard.press('Shift+Tab')
        await page.keyboard.press('Tab')
        const o = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { id: document.activeElement.dataset.testid, w: cs.outlineWidth, s: cs.outlineStyle, c: cs.outlineColor } })
        assert.equal(o.id, id)
        assert.deepEqual([o.w, o.s, o.c], ['2px', 'solid', 'rgb(176, 102, 255)'], `${id} ring`)
      }
    } finally { await context.close() }
  })

  it('m5/c5 one name field: with a header name the approval banner shows "as <name>"; approval time is relative', T, async () => {
    const d = await createDoc({ markdown: DOC, filename: 'plan.md', sessionName: uniq('Approve'), mode: 'review', protected: true })
    const { context, page } = await namedCtx()
    try {
      await openEditor(page, d)
      await page.locator('.approval-banner').waitFor()
      assert.equal(await page.locator('.approval-banner .reviewer-input').count(), 0)
      assert.match(await page.locator(tid('approval-as')).innerText(), new RegExp(NAME))
      await page.locator('.btn.approve').click()
      await eventually(async () => assert.match(await page.locator('.status-badge').innerText(), /approved/i))
      const t = page.locator('.approved-time')
      assert.equal((await t.innerText()).trim(), 'just now')
      assert.ok(await t.getAttribute('title'), 'exact time on hover')
    } finally { await context.close() }
  })

  it('m9 the comments badge counts open comments and turns into a check when all are resolved', T, async () => {
    const d = await createDoc({ markdown: DOC, filename: 'plan.md', sessionName: uniq('Badge'), mode: 'review', protected: true })
    const { context, page } = await namedCtx()
    try {
      await openEditor(page, d)
      await page.locator('.preview-pane p', { hasText: 'Some intro text' }).click({ clickCount: 3 })
      await page.locator('.selection-action-bar .action-btn').click()
      await page.locator('.popover .popover-input').fill('One')
      await page.locator('.popover .btn-primary').click()
      const badge = page.locator(tid('comments-badge'))
      await eventually(async () => assert.equal((await badge.innerText()).trim(), '1'))
      await page.locator('.resolve-btn').first().click()
      await eventually(async () => assert.equal((await badge.innerText()).trim(), '✓'))
    } finally { await context.close() }
  })

  it('c1 Locus review statuses use the brand palette', T, async () => {
    const d = await createDoc({ markdown: DOC, filename: 'plan.md', sessionName: uniq('Palette'), mode: 'review', protected: true })
    const { context, page } = await namedCtx({ theme: 'locus-light' })
    try {
      await openEditor(page, d)
      const approve = page.locator('.btn.approve')
      assert.equal(await approve.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(0, 210, 115)')
      await approve.click()
      await eventually(async () => assert.equal(await page.locator('.status-badge').evaluate((e) => getComputedStyle(e).color), 'rgb(0, 112, 61)'))
    } finally { await context.close() }
  })

  it('c3 copying from the Share dialog confirms with the same toast as Copy link', T, async () => {
    const d = await reviewDoc()
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await openEditor(page, d)
      await page.locator(tid('share-btn')).click()
      await page.locator(tid('share-copy-view')).click()
      await page.locator(tid('app-toast')).filter({ hasText: 'Link copied' }).first().waitFor({ timeout: 3000 })
    } finally { await context.close() }
  })

  it('c4 the reaction bar lines up with the reading column', T, async () => {
    const d = await createDoc({ markdown: DOC, filename: 'plan.md', sessionName: uniq('Bar'), mode: 'publish', protected: true })
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${key(d)}`)
      const bar = page.locator(tid('reaction-bar'))
      await bar.waitFor()
      const r = await page.evaluate(() => {
        const b = document.querySelector('[data-testid="reaction-bar"]').getBoundingClientRect()
        const p = document.querySelector('.preview-pane p').getBoundingClientRect()
        return { bar: Math.round(b.left), text: Math.round(p.left), barR: Math.round(b.right), textR: Math.round(p.right) }
      })
      assert.ok(Math.abs(r.bar - r.text) <= 4, `bar left ${r.bar} vs text ${r.text}`)
      assert.ok(r.barR <= r.textR + 4, `bar right ${r.barR} vs column ${r.textR}`)
    } finally { await context.close() }
  })

  it('m1/m2/m10 start blank offers the editor, the doc takes its H1 as its name; the paste button says "Open document"', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/`)
      await page.locator('button:has-text("Paste markdown or HTML")').click()
      assert.equal(await page.locator('button:has-text("Open document")').count(), 1)
      assert.equal(await page.locator('button:has-text("Start Review")').count(), 0)
      await page.goto(`${BASE}/`)
      await page.locator('button:has-text("Start blank")').click()
      await page.locator(tid('empty-doc-hint')).waitFor()
      await page.locator(tid('empty-doc-edit')).click()
      const cm = page.locator('.cm-content')
      await cm.waitFor()
      await cm.click()
      await page.keyboard.type('# Capacity plan\n\nBody.')
      await eventually(async () => assert.equal((await page.locator('header .filename').innerText()).trim(), 'capacity-plan.md'), { timeout: 5000 })
    } finally { await context.close() }
  })
})
