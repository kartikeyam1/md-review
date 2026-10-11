// #4 Path-based routes under the GitHub Pages base path (docs/build/specs/04-routes.md
// rules 1, 17, 18). A production build with base `/md-review/` is served by
// lib/pages.mjs, which mimics Pages: real files are served, every other path
// under the base gets 404.html with status 404 (the SPA fallback).
//
// The build talks to the throwaway backend from helpers.mjs (E2E_API_URL).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { API } from '../helpers.mjs'
import { buildForPages, startPagesServer } from '../lib/pages.mjs'
import { createDoc, uniq, installUrlRecorder, historyLength, waitForDoc, readingOffset, collectShareUrls } from '../lib/docs.mjs'

const B = '/md-review'

/** Per-test cap: a missing feature must fail, never hang the gate. */
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
  await installUrlRecorder(context)
  const page = await context.newPage()
  return { context, page }
}

const here = (page) => new URL(page.url())

async function waitForPath(page, pathname, { search, hash, timeout = 10000 } = {}) {
  await page.waitForFunction(([p, s, h]) =>
    location.pathname === p && (s === null || location.search === s) && (h === null || location.hash === h),
  [pathname, search ?? null, hash ?? null], { timeout })
}

function anchorDoc(title) {
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} filler paragraph ${i + 1}. Lorem ipsum dolor sit amet.`).join('\n\n')
  return [`# ${title}`, '', 'Jump: [go](#intro)', '', filler(30, 'Before'), '', '## Intro', '', 'Intro section body text.', '', filler(80, 'After'), ''].join('\n')
}

describe('#4 routes on the GitHub Pages base (/md-review/ + 404.html fallback)', () => {
  it('rule 18: the Pages server falls back to 404.html for deep paths (harness check)', T, async () => {
    const res = await fetch(`${pages.url}/d/anything`)
    assert.equal(res.status, 404)
    const html = await res.text()
    assert.match(html, /<div id="app">/, 'deep paths are served the app shell from dist/404.html — the build must emit it')
  })

  it('AC-04.1 [pages] /md-review/d/<slug> boots from the 404.html fallback and renders the doc', T, async () => {
    const doc = await createDoc({ markdown: '# Pages weekly\n\nPages deep link body (AC-04.1).', filename: 'pw.md', sessionName: uniq('Pages weekly') })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/d/${doc.slug}`)
      await waitForDoc(page, 'Pages deep link body (AC-04.1).')
      assert.equal(here(page).pathname, `${B}/d/${doc.slug}`)
      assert.equal(here(page).hash, '')
    } finally { await context.close() }
  })

  it('AC-04.2 [pages] /md-review/?view=read#shared=<id> → /md-review/d/<id>?view=read without a history entry', T, async () => {
    const doc = await createDoc({ markdown: '# Pages legacy\n\nPages legacy body (AC-04.2).', filename: 'pl.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/?view=read#shared=${doc.id}`)
      await waitForDoc(page, 'Pages legacy body (AC-04.2).')
      await waitForPath(page, `${B}/d/${doc.id}`, { search: '?view=read', hash: '' })
      const { initialHistoryLength } = await page.evaluate(() => window.__mdr)
      assert.equal(await historyLength(page), initialHistoryLength)
    } finally { await context.close() }
  })

  it('rule 1 [pages] /md-review/index.html is the landing route: #shared= redirects to /md-review/d/<id>', T, async () => {
    const doc = await createDoc({ markdown: '# Pages index\n\nPages index.html body (rule 1).', filename: 'pi.md' })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/index.html#shared=${doc.id}`)
      await waitForDoc(page, 'Pages index.html body (rule 1).')
      await waitForPath(page, `${B}/d/${doc.id}`, { hash: '' })
      assert.equal(await page.locator('[data-testid="not-found"]').count(), 0)
    } finally { await context.close() }
  })

  it('AC-04.3 [pages] /md-review/#dashboard → /md-review/library?mode=review', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/#dashboard`)
      await waitForPath(page, `${B}/library`, { search: '?mode=review', hash: '' })
      await page.locator('[data-testid="library-page"], .dashboard').first().waitFor({ state: 'visible', timeout: 10000 })
    } finally { await context.close() }
  })

  it('AC-04.4/04.5 [pages] an in-doc #intro link pushes /md-review/d/<slug>#intro and survives a reload', T, async () => {
    const title = uniq('Pages anchors')
    const doc = await createDoc({ markdown: anchorDoc(title), filename: 'pa.md', sessionName: title })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/d/${doc.slug}`)
      await waitForDoc(page, 'Intro section body text.')
      const before = await historyLength(page)
      await page.locator('.preview-pane a[href="#intro"]').first().click()
      await waitForPath(page, `${B}/d/${doc.slug}`, { hash: '#intro' })
      assert.equal(await historyLength(page), before + 1)

      await page.reload()
      await waitForDoc(page, title)
      assert.equal(here(page).pathname, `${B}/d/${doc.slug}`)
      assert.equal(here(page).hash, '#intro')
      let offset = null
      for (let i = 0; i < 50; i++) {
        offset = await readingOffset(page, '.preview-pane #intro')
        if (offset !== null && offset >= 0 && offset <= 48) break
        await page.waitForTimeout(100)
      }
      assert.ok(offset !== null && offset >= 0 && offset <= 48, `after reload Intro should be 0–48px below the header, got ${offset}`)
    } finally { await context.close() }
  })

  it('AC-04.10 [pages] /md-review/nope/x → not-found; /md-review/d/<unknown> → doc-not-found', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/nope/x`)
      await page.locator('[data-testid="not-found"]').waitFor({ state: 'visible', timeout: 10000 })
      const homes = await page.locator('[data-testid="not-found"] a[href]').evaluateAll((as) => as.map((a) => new URL(a.href).pathname))
      assert.ok(homes.includes(`${B}/`), `not-found links to the base, got ${JSON.stringify(homes)}`)

      await page.goto(`${pages.url}/d/${uniq('missing')}`)
      await page.locator('[data-testid="doc-not-found"]').waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await page.locator('.upload-area, .upload-screen').filter({ visible: true }).count(), 0)
    } finally { await context.close() }
  })

  it('AC-04.19 [pages] a <origin>/md-review/d/<other> link navigates in-app; Back returns', T, async () => {
    const other = await createDoc({ markdown: '# P other\n\nPages other body (AC-04.19).', filename: 'po.md', sessionName: uniq('P other') })
    const first = await createDoc({
      markdown: `# P first\n\nPages first body (AC-04.19).\n\n[to other](${pages.origin}${B}/d/${other.slug})\n`,
      filename: 'pf.md', sessionName: uniq('P first'),
    })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/d/${first.slug}`)
      await waitForDoc(page, 'Pages first body (AC-04.19).')
      await page.evaluate(() => { window.__probe = 'pages-probe' })
      await page.locator('.preview-pane a', { hasText: 'to other' }).click()
      await waitForPath(page, `${B}/d/${other.slug}`)
      await waitForDoc(page, 'Pages other body (AC-04.19).')
      await page.goBack()
      await waitForPath(page, `${B}/d/${first.slug}`)
      await waitForDoc(page, 'Pages first body (AC-04.19).')
      assert.equal(await page.evaluate(() => window.__probe ?? null), 'pages-probe', 'no reload')
    } finally { await context.close() }
  })

  it('rule 17 [pages] FE share / copy links are <origin>/md-review/d/<slug>', T, async () => {
    const doc = await createDoc({ markdown: '# P share\n\nPages share body (rule 17).', filename: 'ps.md', sessionName: uniq('P share') })
    const { context, page } = await open()
    try {
      await page.goto(`${pages.url}/d/${doc.slug}`)
      await waitForDoc(page, 'Pages share body (rule 17).')
      const urls = await collectShareUrls(page)
      const want = `${pages.origin}${B}/d/${doc.slug}`
      assert.ok(urls.some((u) => u.replace(/[).,;:]+$/, '') === want), `expected ${want} among ${JSON.stringify(urls)}`)
      assert.ok(urls.every((u) => !u.includes('#shared=')), `no legacy share links: ${JSON.stringify(urls)}`)
    } finally { await context.close() }
  })
})
