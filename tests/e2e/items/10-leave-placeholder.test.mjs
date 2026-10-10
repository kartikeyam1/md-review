// #10 rule 13 follow-up (orchestrator): leaving, reloading or autosaving mid-upload never persists
// `![Uploading …]()` placeholders, and an editor opened on a doc holding leftover placeholders removes them.
// Images are pasted as a synthetic ClipboardEvent carrying a File; uploads are held with page.route.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import { createDoc, uniq } from '../lib/docs.mjs'

const T = { timeout: 90_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const ELL = '…'
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page }
}

const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()
async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await page.locator(tid('view-toggle-edit')).first().click()
  await editorContent(page).waitFor({ state: 'visible', timeout: 20_000 })
}
async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    return ed ? [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n') : null
  })
}
async function until(fn, { timeout = 8000, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${message}` })
    await new Promise((r) => setTimeout(r, 100))
  }
}
async function serverMarkdown(id) {
  const r = await fetch(`${API}/paste/${id}/markdown`)
  return (await r.json()).markdown
}
async function openShared(page, markdown) {
  const doc = await createDoc({ markdown, filename: 'doc.md', sessionName: uniq('Leave'), protected: true })
  await page.goto(`${BASE}/d/${doc.id}?edit=${doc.editToken}`)
  await page.locator('.preview-pane, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
  await toEdit(page)
  await editorContent(page).click()
  await page.keyboard.press(`${MOD}+End`)
  return doc
}
async function pasteImage(page) {
  await editorContent(page).evaluate((el, b64) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, PNG_1x1)
}
/** Hold every upload until the test ends (the response never comes back). */
async function holdUploads(page) {
  await page.route(/\/paste\/[^/]+\/files$/, (route) => (route.request().method() === 'POST' ? undefined : route.continue()))
}

describe('#10 placeholders never persist (rule 13)', () => {
  it('autosave during an upload sends the doc without the placeholder (and keeps other edits)', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await openShared(page, '# Autosave\n\nbody\n\n')
      await holdUploads(page)
      await pasteImage(page)
      await until(async () => (await editorText(page))?.includes(`![Uploading shot${ELL}]()`), { message: 'the placeholder' })
      await page.locator('.cm-editor:visible .cm-line', { hasText: 'body' }).first().click()
      await page.keyboard.press('End')
      await page.keyboard.type(' edited')
      await until(async () => (await serverMarkdown(doc.id)).includes('body edited'), { timeout: 15_000, message: 'autosave of the edit' })
      assert.equal(await serverMarkdown(doc.id), '# Autosave\n\nbody edited\n\n', 'server copy: the edit, no placeholder')
    } finally { await context.close() }
  })

  it('reloading mid-upload leaves no placeholder on the server or in the restored draft', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Reload\n\nkeep me\n\n'
      const doc = await openShared(page, pre)
      await holdUploads(page)
      await pasteImage(page)
      await until(async () => (await editorText(page))?.includes(`![Uploading shot${ELL}]()`), { message: 'the placeholder' })
      await page.reload()
      await page.locator('.preview-pane, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
      await toEdit(page)
      await new Promise((r) => setTimeout(r, 3000))
      const text = await editorText(page)
      assert.ok(!text.includes('Uploading'), `no placeholder after reload: ${JSON.stringify(text)}`)
      assert.equal(text, pre)
      assert.ok(!(await serverMarkdown(doc.id)).includes('Uploading'), 'server copy has no placeholder')
    } finally { await context.close() }
  })

  it('an editor opened on a doc holding a leftover placeholder removes it; autosave stores the clean doc', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await openShared(page, `# Stale\n\nbefore\n\n![Uploading old${ELL}]()\n\nafter ![real](https://example.com/x.png)\n`)
      await until(async () => !(await editorText(page))?.includes('Uploading'), { message: 'leftover removed in the editor' })
      assert.equal(await editorText(page), '# Stale\n\nbefore\n\n\n\nafter ![real](https://example.com/x.png)\n')
      await until(async () => !(await serverMarkdown(doc.id)).includes('Uploading'), { timeout: 15_000, message: 'clean doc autosaved' })
      // The clean-up is not an undo step.
      await page.keyboard.press(`${MOD}+z`)
      await new Promise((r) => setTimeout(r, 300))
      assert.ok(!(await editorText(page)).includes('Uploading'))
    } finally { await context.close() }
  })
})
