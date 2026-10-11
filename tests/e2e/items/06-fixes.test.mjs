// #6 Lazy-load the editor — review-round fixes, on a PRODUCTION build served
// the way GitHub Pages serves it (lib/pages.mjs, base /md-review/).
//
//   - Retry after a chunk load failure mounts the editor (the build's EditorPane
//     chunk has no `default` export when imported by URL).
//   - After a failure, hovering Edit does not fire silent retries.
//   - The kept-alive editor belongs to one document: opening another doc in the
//     same tab never shows the previous doc's editor instance.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { API } from '../helpers.mjs'
import { buildForPages, startPagesServer } from '../lib/pages.mjs'
import { createDoc, uniq, waitForDoc } from '../lib/docs.mjs'

const B = '/md-review'
const EDITOR_CHUNK = (u) => /\/assets\/EditorPane-[^/]*\.js$/.test(u.pathname)
const T = { timeout: 60_000 }

let browser, dist, pages

before(async () => {
  dist = await buildForPages({ apiUrl: API, base: `${B}/` })
  pages = await startPagesServer({ root: dist, base: `${B}/` })
  browser = await chromium.launch({ headless: true })
}, { timeout: 300_000 })

after(async () => {
  await browser?.close()
  await pages?.close()
  if (dist) rmSync(dist, { recursive: true, force: true })
})

async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const chunkRequests = []
  page.on('request', (r) => { const u = new URL(r.url()); if (EDITOR_CHUNK(u)) chunkRequests.push(u.pathname + u.search) })
  return { context, page, chunkRequests }
}

const plainDoc = (title, marker) => [`# ${title}`, '', marker, '', 'Some body text.', ''].join('\n')
const editor = (page) => page.locator('.cm-editor:visible .cm-content').first()

describe('#6 fixes on the production build', () => {
  it('AC-06.6 [build] a 404 for the editor chunk, then un-blocking: Retry mounts the editor', T, async () => {
    const marker = 'Build retry marker (06 fixes).'
    const doc = await createDoc({ markdown: plainDoc('Build retry', marker), filename: 'bretry.md', sessionName: uniq('Build retry') })
    const { context, page, chunkRequests } = await open()
    try {
      await page.goto(`${pages.url}/d/${doc.id}`)
      await waitForDoc(page, marker)
      const notFound = (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 (06 fixes)' })
      await page.route(EDITOR_CHUNK, notFound)

      await page.locator('[data-testid="view-toggle-edit"]').click()
      const err = page.locator('[data-testid="editor-load-error"]')
      await err.waitFor({ state: 'visible', timeout: 15_000 })

      // Rule 4 / review: no silent retries on hover after a failure.
      await page.locator('[data-testid="view-toggle-read"]').click()
      const before = chunkRequests.length
      await page.locator('[data-testid="view-toggle-edit"]').hover()
      await page.mouse.move(5, 5)
      await page.locator('[data-testid="view-toggle-edit"]').hover()
      await page.waitForTimeout(500)
      assert.equal(chunkRequests.length, before, `hover after a failure requested the chunk again:\n  ${chunkRequests.join('\n  ')}`)

      await page.locator('[data-testid="view-toggle-edit"]').click()
      await err.waitFor({ state: 'visible', timeout: 5000 })
      await page.unroute(EDITOR_CHUNK, notFound)
      await page.locator('[data-testid="editor-load-retry"]').click()
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      assert.ok((await editor(page).innerText()).includes(marker), 'the retried editor shows the doc')
      assert.equal(await err.isVisible(), false, 'error gone after a successful retry')
      assert.equal(await editor(page).getAttribute('contenteditable'), 'true', 'the retried editor is editable')
    } finally { await context.close() }
  })

  it('rule 5 [build] the kept-alive editor is per document: another doc in the same tab gets a fresh editor', T, async () => {
    const a = await createDoc({ markdown: plainDoc('Doc A', 'Doc A marker (06 fixes).'), filename: 'a.md', sessionName: uniq('Doc A') })
    const b = await createDoc({ markdown: plainDoc('Doc B', 'Doc B marker (06 fixes).'), filename: 'b.md', sessionName: uniq('Doc B') })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/d/${a.id}`)
      await waitForDoc(page, 'Doc A marker (06 fixes).')
      await page.locator('[data-testid="view-toggle-edit"]').click()
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await page.evaluate(() => { document.querySelector('.cm-editor').__mdrDocA = true })
      await page.locator('[data-testid="view-toggle-read"]').click()
      await page.waitForFunction(() => ![...document.querySelectorAll('.cm-editor')].some((el) => el.getClientRects().length > 0), null, { timeout: 5000 })

      // In-app navigation (no reload) to doc B.
      await page.evaluate((url) => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')) }, `${B}/d/${b.id}`)
      await waitForDoc(page, 'Doc B marker (06 fixes).')
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.cm-editor')].some((e) => e.__mdrDocA === true)), false,
        "doc A's editor instance is gone once doc B is on screen")

      await page.locator('[data-testid="view-toggle-edit"]').click()
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      const text = await editor(page).innerText()
      assert.ok(text.includes('Doc B marker (06 fixes).') && !text.includes('Doc A marker'), `the editor shows doc B, got: ${text.slice(0, 200)}`)
      assert.equal(await page.evaluate(() => document.querySelectorAll('.cm-editor').length), 1, 'one editor instance')
    } finally { await context.close() }
  })
})
