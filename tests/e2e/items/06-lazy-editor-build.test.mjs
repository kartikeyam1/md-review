// #6 Lazy-load the editor on a PRODUCTION build (docs/build/specs/06-lazy-editor.md
// AC-06.1/06.2/06.3/06.6 and rule 4), served the way GitHub Pages serves it
// (lib/pages.mjs, base /md-review/).
//
// On a build, CodeMirror may sit in a chunk with any name (a shared vendor
// chunk can be called index-<hash>.js), so besides the AC's URL pattern these
// tests look INSIDE every script the page downloads for CodeMirror's class-name
// markers `cm-gutters` / `cm-content` (the same markers as `check:lazy-editor`).
//
// The build talks to the throwaway backend from helpers.mjs (E2E_API_URL).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { API } from '../helpers.mjs'
import { buildForPages, startPagesServer } from '../lib/pages.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, waitForDoc } from '../lib/docs.mjs'

const B = '/md-review'
const EDITOR_RE = /codemirror|EditorPane/i
const MARKERS = ['cm-gutters', 'cm-content']

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

/**
 * Fresh context + a recorder of every request and every script body.
 *   urls()            every request URL
 *   scripts()         [{ url, markers }] for each script response (bodies read)
 *   editorScripts()   the scripts containing a CodeMirror marker
 *   settle()          waits for in-flight requests and pending body reads
 */
async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const urls = []
  const scripts = []
  const reads = []
  const inflight = new Set()
  let lastChange = Date.now()
  page.on('request', (r) => { urls.push(r.url()); inflight.add(r); lastChange = Date.now() })
  const done = (r) => { inflight.delete(r); lastChange = Date.now() }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  page.on('response', (res) => {
    if (res.request().resourceType() !== 'script' || res.status() !== 200) return
    reads.push(res.text().then(
      (body) => { scripts.push({ url: res.url(), markers: MARKERS.filter((m) => body.includes(m)) }) },
      () => {},
    ))
  })
  const rec = {
    urls: () => [...urls],
    editorUrls: () => urls.filter((u) => EDITOR_RE.test(u)),
    scripts: () => [...scripts],
    editorScripts: () => scripts.filter((s) => s.markers.length),
    async settle({ idle = 400, timeout = 10_000 } = {}) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline && !(inflight.size === 0 && Date.now() - lastChange >= idle)) {
        await new Promise((r) => setTimeout(r, 50))
      }
      await Promise.all(reads)
    },
  }
  return { context, page, rec }
}

const short = (u) => { try { const x = new URL(u); return x.pathname + x.search } catch { return u } }
const show = (xs) => xs.map((x) => (typeof x === 'string' ? short(x) : `${short(x.url)} [${x.markers.join(',')}]`)).join('\n  ')

/** The view-toggle segment (#2), or today's header Edit / Preview button before #2. */
async function toggle(page, which) {
  const byId = page.locator(`[data-testid="view-toggle-${which}"]`).first()
  if (await byId.count()) return byId
  return page.locator(`header button:has-text("${which === 'edit' ? 'Edit' : 'Preview'}")`).first()
}

function plainDoc(title, marker, paragraphs = 60) {
  const body = Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i + 1} of ${title}. Lorem ipsum dolor sit amet.`)
  return [`# ${title}`, '', marker, '', ...body.flatMap((p) => [p, ''])].join('\n')
}

async function scrollWholePage(page) {
  await page.mouse.move(700, 600)
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(40) }
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight)
    for (const el of document.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight
    }
  })
}

function assertNoEditorLoaded(rec, where) {
  assert.ok(rec.scripts().length > 0, `${where}: the recorder saw the app's scripts`)
  assert.deepEqual(rec.editorUrls(), [], `${where}: requests matching /codemirror|EditorPane/i:\n  ${show(rec.editorUrls())}`)
  assert.deepEqual(rec.editorScripts(), [], `${where}: scripts containing CodeMirror:\n  ${show(rec.editorScripts())}`)
}

describe('#6 lazy editor on the production build', () => {
  it('AC-06.1 [build] read view of a shared doc, idle 5 s: no script contains CodeMirror; AC-06.2 [build] Edit then loads it', T, async () => {
    const marker = 'Build read marker (AC-06.1).'
    const doc = await createDoc({ markdown: plainDoc('Build read', marker), filename: 'bread.md', sessionName: uniq('Build read') })
    const { context, page, rec } = await open()
    try {
      await page.goto(`${pages.url}/d/${doc.id}`)
      await waitForDoc(page, marker)
      const edit = await toggle(page, 'edit')
      await edit.waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(5000) // the AC's idle window, pointer untouched
      await rec.settle()
      assertNoEditorLoaded(rec, 'read view')

      await edit.click()
      await page.locator('.cm-editor:visible .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
      await rec.settle()
      assert.ok(rec.editorScripts().length > 0, `Edit downloaded a script containing CodeMirror:\n  ${show(rec.scripts())}`)
      const text = await page.locator('.cm-editor:visible .cm-content').first().innerText()
      assert.ok(text.includes(marker), '.cm-content shows the doc text')
    } finally { await context.close() }
  })

  describe('AC-06.3 [build] viewers and non-doc pages', () => {
    let doc, oldHash
    before(async () => {
      const md = (v) => plainDoc('Build viewer', `Build viewer v${v} (AC-06.3).`, 80)
      doc = await createDoc({ markdown: md(1), filename: 'bview.md', sessionName: uniq('Build viewer'), author: 'Alice' })
      await putMarkdown(doc.id, md(2), { author: 'Bob' })
      const revs = await listRevisions(doc.id)
      oldHash = revs.revisions.find((r) => r.hash !== revs.current)?.hash
      assert.match(oldHash ?? '', /^[0-9a-f]{32}$/)
    })

    const cases = [
      ['pinned revision /d/<id>@<hash>', () => `/d/${doc.id}@${oldHash}`, (p) => waitForDoc(p, 'Build viewer v1 (AC-06.3).')],
      ['?embed=1', () => `/d/${doc.id}?embed=1`, (p) => waitForDoc(p, 'Build viewer v2 (AC-06.3).')],
      ['landing /', () => '/', (p) => p.locator('#app *').first().waitFor({ state: 'attached', timeout: 10_000 })],
      ['library /library', () => '/library', (p) => p.locator('#app *').first().waitFor({ state: 'attached', timeout: 10_000 })],
    ]
    for (const [name, path, ready] of cases) {
      it(`AC-06.3 [build] ${name}: scrolling the whole page downloads no CodeMirror`, T, async () => {
        const { context, page, rec } = await open()
        try {
          await page.goto(`${pages.url}${path()}`)
          await ready(page)
          await rec.settle()
          await scrollWholePage(page)
          await rec.settle()
          assertNoEditorLoaded(rec, name)
        } finally { await context.close() }
      })
    }
  })

  it('AC-06.6 [build] / rule 4: a redeployed (404) editor chunk shows the error, retry and the reload hint; read view still works', T, async () => {
    const marker = 'Build stale chunk marker (AC-06.6).'
    const doc = await createDoc({ markdown: plainDoc('Build stale', marker, 10), filename: 'bstale.md', sessionName: uniq('Build stale') })
    const { context, page, rec } = await open()
    try {
      await page.goto(`${pages.url}/d/${doc.id}`)
      await waitForDoc(page, marker)
      await rec.settle()
      const readText = await page.locator('.preview-pane').first().innerText()

      // Simulate a redeploy: every JS asset this page has not loaded yet is gone.
      const loaded = new Set(rec.urls().map((u) => new URL(u).pathname))
      const gone = (u) => u.pathname.startsWith(`${B}/assets/`) && /\.m?js$/.test(u.pathname) && !loaded.has(u.pathname)
      const notFound = (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 (redeployed)' })
      await page.route(gone, notFound)

      await (await toggle(page, 'edit')).click()
      const err = page.locator('[data-testid="editor-load-error"]')
      await err.waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator('[data-testid="editor-load-retry"]').waitFor({ state: 'visible', timeout: 5000 })
      // The stale-deployment diagnosis may need a round trip (e.g. a HEAD on the chunk URL).
      await page.locator('[data-testid="editor-load-reload"]').waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => assert.fail('rule 4: a chunk 404 looks like a stale deployment — editor-load-reload not shown'))
      const msg = await err.innerText()
      assert.match(msg, /Couldn['’]t load the editor/)
      assert.match(msg, /Reload the page to get the latest version/, 'rule 4: reload hint text')

      await (await toggle(page, 'read')).click()
      const pane = page.locator('.preview-pane').first()
      await pane.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await pane.innerText(), readText, 'the rendered doc is unchanged')

      // Back to edit: still the error with its actions. (Recovery by Retry after
      // un-blocking is asserted on vite dev — AC-06.6 in 06-lazy-editor.test.mjs.
      // On a build, Chrome keeps failed module fetches — including Vite's
      // modulepreload of the chunk's deps — in its module map, so after a real
      // redeploy only a reload recovers, which is what the hint is for.)
      await (await toggle(page, 'edit')).click()
      await err.waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator('[data-testid="editor-load-retry"]').waitFor({ state: 'visible', timeout: 5000 })
    } finally { await context.close() }
  })
})
