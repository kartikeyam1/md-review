// #19 Downloads: .md, self-contained .html, PDF (print), HTML source — acceptance tests
// in the browser (docs/build/specs/19-downloads.md AC-19.1, 19.2, 19.4 – 19.16).
// Filename rules and the export DOM clean-up are unit-tested in tests/items/19-downloads.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq } from '../lib/docs.mjs'
import { pngDataUri } from './05-lib.mjs'
import { openCtx, openDoc, THEMES, VIEWPORTS, tid, sleep, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(resolve(HERE, '../../..'), '.verify/screens/19')
const T = { timeout: 90_000 }
const SLOW = { timeout: 240_000 }

let browser
const docs = {}

const MERMAID_SRC = [
  '# Diagrams', '', 'Diagram fixture (AC-19.5).', '',
  '```mermaid', 'graph LR', '  A[One] --> B[Two]', '```', '',
  '```mermaid', 'sequenceDiagram', '  Alice->>Bob: Hi', '```', '',
  'See [the end](#the-end).', '',
  ...Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1} pushes the last section below the fold.\n`),
  '## The end', '', 'Last words.', '',
  ...Array.from({ length: 30 }, (_, i) => `Closing paragraph ${i + 1} gives the page room to scroll the heading to the top.\n`),
].join('\n')

const RICH_SRC = [
  '# Rich export', '', 'Rich fixture (AC-19.8).', '',
  '```js', 'const answer = 42', '```', '',
  '> [!WARNING]', '> Careful here.', '',
  'Status: :rag-amber[At risk]', '',
  '## Folded section', '', 'Text inside the folded section.', '',
  '<details><summary>More info</summary>', '', 'Hidden details body.', '', '</details>', '',
  '## After', '', 'Trailing text.',
].join('\n')

const HTML_SRC = '<!doctype html>\n<html><head><title>Report</title></head>\n<body><h1>Quarterly report</h1><p>HTML source body (AC-19.4) ünïcode ✓</p></body></html>\n'
const WEEKLY_SRC = '---\r\ntitle: Weekly Update\r\nowner: kay\r\n---\r\n# Weekly 🚀 update\r\n\r\nShipped the thing ✅ — café.\r\n'

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(OUT, { recursive: true })
  docs.weekly = await createDoc({ markdown: WEEKLY_SRC, filename: 'Weekly Update.md', sessionName: uniq('Weekly'), mode: 'publish' })
  docs.viewer = await createDoc({ markdown: '# Viewer doc\n\nViewer body (AC-19.1).\n', filename: 'viewer.md', sessionName: uniq('Viewer'), protected: true })
  docs.html = await createDoc({ markdown: HTML_SRC, filename: 'report.html', contentType: 'html', sessionName: uniq('Report') })
  docs.mermaid = await createDoc({ markdown: MERMAID_SRC, filename: 'plan.md', sessionName: uniq('Diagrams'), mode: 'publish' })
  docs.rich = await createDoc({ markdown: RICH_SRC, filename: 'rich.md', sessionName: uniq('Rich'), mode: 'publish' })
})
after(async () => { await browser?.close() })

const serverMarkdown = async (doc) => (await (await fetch(`${API}/paste/${doc.id}`)).json()).markdown

async function openMenu(page) {
  const btn = page.locator(tid('download-menu-btn'))
  // 00 §2.2: the bar button on desktop (≥ 1100px; a lazy chunk, so wait for it), the overflow group below.
  if (page.viewportSize().width >= 1100) {
    await btn.waitFor({ state: 'visible' })
    if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
    await page.locator(tid('download-menu')).waitFor({ state: 'visible' })
    return page.locator(tid('download-menu'))
  }
  await page.locator(tid('header-overflow-btn')).click()
  await page.locator(tid('header-overflow-menu')).waitFor({ state: 'visible' })
  return page.locator(tid('header-overflow-menu'))
}

/** Click a download item and return { name, bytes } of the one download it starts. */
async function download(page, item, { timeout = 20_000 } = {}) {
  const menu = await openMenu(page)
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), menu.locator(tid(item)).click()])
  const path = await dl.path()
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) }
}

/** Open an exported HTML string from disk with the network off. */
async function openExported(html, name, opts = {}) {
  const file = join(OUT, name)
  writeFileSync(file, html)
  const context = await browser.newContext({ offline: true, viewport: VIEWPORTS.desktop, ...opts })
  const page = await context.newPage()
  await page.goto(pathToFileURL(file).href)
  return { context, page }
}

const waitDiagrams = (page, n) => page.waitForFunction((count) => document.querySelectorAll('.preview-pane .mermaid > svg').length >= count, n, { timeout: 20_000 })

describe('#19 downloads', () => {
  it('AC-19.1 a viewer sees download-menu-btn with Markdown, HTML and PDF items', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.viewer, 'Viewer body (AC-19.1).')
      assert.equal(await page.locator('.app').getAttribute('data-capability'), 'viewer')
      const btn = page.locator(tid('download-menu-btn'))
      await btn.waitFor({ state: 'visible' })
      assert.equal(await btn.getAttribute('aria-haspopup'), 'menu')
      assert.equal(await btn.getAttribute('aria-expanded'), 'false')
      const menu = await openMenu(page)
      assert.equal(await menu.getAttribute('role'), 'menu')
      assert.equal(await btn.getAttribute('aria-expanded'), 'true')
      const items = await menu.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => [e.dataset.testid, e.textContent.trim()]))
      assert.deepEqual(items, [['download-md', 'Markdown (.md)'], ['download-html', 'HTML (.html)'], ['download-pdf', 'PDF (print)']])
      assert.equal(await page.locator(tid('download-html-source')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-19.2 .md download: one file named "Weekly Update.md" whose bytes equal the source exactly (UTF-8, no BOM)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.weekly, 'Shipped the thing')
      const source = await serverMarkdown(docs.weekly)
      assert.equal(source, WEEKLY_SRC, 'the backend keeps CRLF, emoji and the trailing newline')
      let downloads = 0
      page.on('download', () => downloads++)
      const { name, bytes } = await download(page, 'download-md')
      assert.equal(name, 'Weekly Update.md')
      assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'no BOM')
      assert.ok(bytes.equals(Buffer.from(WEEKLY_SRC, 'utf8')), 'bytes equal the source')
      await sleep(300)
      assert.equal(downloads, 1, 'exactly one download')
    } finally { await context.close() }
  })

  it('AC-19.4 HTML doc: only download-html-source; its bytes equal the stored source (no bridge script)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${docs.html.slug || docs.html.id}`)
      await page.locator('iframe.html-frame').waitFor({ state: 'visible' })
      const menu = await openMenu(page)
      const items = await menu.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => [e.dataset.testid, e.textContent.trim()]))
      assert.deepEqual(items, [['download-html-source', 'HTML source (.html)']])
      await page.keyboard.press('Escape')
      const { name, bytes } = await download(page, 'download-html-source')
      assert.equal(name, 'report.html')
      assert.ok(bytes.equals(Buffer.from(HTML_SRC, 'utf8')), 'bytes equal the stored source')
      assert.ok(!bytes.toString('utf8').includes('__mdreview'), 'no bridge script')
    } finally { await context.close() }
  })

  it('AC-19.5 .html export: 2 inline <svg> diagrams, no raw mermaid source, no <script>, no stylesheet <link>', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.mermaid, 'Diagram fixture (AC-19.5).')
      const { name, bytes } = await download(page, 'download-html')
      assert.equal(name, 'plan.html')
      const html = bytes.toString('utf8')
      assert.ok(html.startsWith('<!doctype html>'), 'doctype first')
      assert.match(html, /<html lang="en"/)
      assert.match(html, /<meta charset="utf-8">/)
      assert.match(html, /<meta name="viewport"/)
      assert.equal(await page.title().then((t) => t.replace(/ · md-review$/, '')), html.match(/<title>([^<]*)<\/title>/)[1], 'title = docTitle')
      assert.ok(!/ · md-review/.test(html.match(/<title>([^<]*)<\/title>/)[1]), 'no app suffix')
      assert.equal((html.match(/<script/gi) ?? []).length, 0, 'no <script')
      assert.equal((html.match(/<link[^>]+rel=["']?stylesheet/gi) ?? []).length, 0, 'no stylesheet link')
      assert.ok(!/@import/.test(html), 'no @import')
      const { context: c2, page: p2 } = await openExported(html, 'ac19-5.html')
      try {
        const r = await p2.evaluate(() => ({
          svgs: document.querySelectorAll('main.preview-pane .mermaid > svg').length,
          raw: [...document.querySelectorAll('.mermaid')].filter((m) => !m.querySelector('svg')).length,
          scripts: document.querySelectorAll('script').length,
          handlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
        }))
        assert.deepEqual(r, { svgs: 2, raw: 0, scripts: 0, handlers: 0 })
      } finally { await c2.close() }
    } finally { await context.close() }
  })

  it('AC-19.6 github-dark export carries the GitHub dark sheet and renders a #0d1117 body offline', T, async () => {
    const { context, page } = await openCtx(browser, { theme: 'github-dark' })
    try {
      await openDoc(page, docs.rich, 'Rich fixture (AC-19.8).')
      const html = (await download(page, 'download-html')).bytes.toString('utf8')
      assert.match(html, /<html lang="en" class="dark github-theme"/)
      assert.match(html, /<main class="preview-pane markdown-body github-mode">/)
      assert.match(html, /color-scheme:\s*dark/, 'github-markdown-css dark rules inlined')
      assert.match(html, /#0d1117/i)
      const { context: c2, page: p2 } = await openExported(html, 'ac19-6.html')
      try {
        assert.equal(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(13, 17, 23)')
        await p2.screenshot({ path: join(OUT, 'ac19-6-github-dark.png') })
      } finally { await c2.close() }
    } finally { await context.close() }
  })

  it('AC-19.7 locus-light vs light: h1 font and page background differ and each matches the app on screen', T, async () => {
    const results = {}
    for (const theme of ['light', 'locus-light']) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await openDoc(page, docs.rich, 'Rich fixture (AC-19.8).')
        const app = await page.evaluate(() => ({
          h1: getComputedStyle(document.querySelector('.preview-pane h1')).fontFamily,
          h1Size: getComputedStyle(document.querySelector('.preview-pane h1')).fontSize,
          bg: getComputedStyle(document.querySelector('.preview-pane')).backgroundColor,
        }))
        const html = (await download(page, 'download-html')).bytes.toString('utf8')
        const { context: c2, page: p2 } = await openExported(html, `ac19-7-${theme}.html`)
        try {
          const file = await p2.evaluate(() => ({
            h1: getComputedStyle(document.querySelector('main h1')).fontFamily,
            h1Size: getComputedStyle(document.querySelector('main h1')).fontSize,
            bg: getComputedStyle(document.body).backgroundColor,
          }))
          assert.deepEqual(file, app, `${theme}: export matches the app`)
          results[theme] = file
          await p2.screenshot({ path: join(OUT, `ac19-7-${theme}.png`) })
        } finally { await c2.close() }
      } finally { await context.close() }
    }
    assert.notEqual(results.light.h1, results['locus-light'].h1, 'h1 font differs')
    assert.notEqual(results.light.bg, results['locus-light'].bg, 'background differs')
  })

  it('AC-19.8 no copy buttons, no fold toggles, no hidden content; callout + badge styled; details present and closed', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.rich, 'Rich fixture (AC-19.8).')
      // Fold "Folded section" on screen first.
      const toggle = page.locator(`#folded-section ${tid('heading-fold-toggle')}`)
      await toggle.waitFor({ state: 'attached' })
      await toggle.click({ force: true })
      await page.locator('#folded-section[data-folded="true"]').waitFor({ state: 'attached' })
      const html = (await download(page, 'download-html')).bytes.toString('utf8')
      for (const s of ['code-copy-btn', 'heading-fold-toggle', 'heading-fold-ellipsis', 'heading-anchor', 'code-toolbar', 'zoom-trigger', 'comment-highlight']) {
        assert.ok(!html.includes(s), `no ${s}`)
      }
      const { context: c2, page: p2 } = await openExported(html, 'ac19-8.html')
      try {
        const r = await p2.evaluate(() => {
          const callout = document.querySelector('.callout')
          const badge = document.querySelector('.rag')
          const details = document.querySelector('details')
          const folded = [...document.querySelectorAll('p')].find((p) => p.textContent.includes('Text inside the folded section.'))
          return {
            hidden: document.querySelectorAll('main [hidden]').length,
            foldedVisible: !!folded && folded.getBoundingClientRect().height > 0,
            calloutEdge: callout && getComputedStyle(callout).borderLeftWidth,
            calloutBg: callout && getComputedStyle(callout).backgroundColor,
            badgeBg: badge && getComputedStyle(badge).backgroundColor,
            badgeRadius: badge && getComputedStyle(badge).borderRadius,
            details: !!details, detailsOpen: details?.open,
            buttons: document.querySelectorAll('main button').length,
          }
        })
        assert.equal(r.hidden, 0)
        assert.ok(r.foldedVisible, 'folded section expanded')
        assert.equal(r.calloutEdge, '4px', 'callout edge styled')
        assert.notEqual(r.calloutBg, 'rgba(0, 0, 0, 0)', 'callout tinted')
        assert.notEqual(r.badgeBg, 'rgba(0, 0, 0, 0)', 'badge styled')
        assert.equal(r.badgeRadius, '999px')
        assert.equal(r.details, true)
        assert.equal(r.detailsOpen, false, 'details stays closed')
        assert.equal(r.buttons, 0, 'no app buttons')
      } finally { await c2.close() }
    } finally { await context.close() }
  })

  it('AC-19.9 a backend attachment image is inlined as data:image/…; an external https image keeps its URL', T, async () => {
    const doc = await createDoc({ markdown: '# Images\n\nImage fixture (AC-19.9).\n', filename: 'img.md', sessionName: uniq('Images') })
    const png = Buffer.from(pngDataUri(24, 24).split(',')[1], 'base64')
    const name = `assets/20261011-000000-${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}.png`
    const up = await fetch(`${API}/paste/${doc.id}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content: png.toString('base64'), encoding: 'base64' }) })
    assert.ok(up.ok, `upload ${up.status}`)
    const attachment = new URL(`/paste/${doc.id}/files/${name}`, API).href
    const external = 'https://external.example.invalid/pic.png'
    await putMarkdown(doc.id, `# Images\n\nImage fixture (AC-19.9).\n\n![att](${attachment})\n\n![ext](${external})\n`)
    const { context, page } = await openCtx(browser)
    await context.route('https://external.example.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }))
    try {
      await openDoc(page, doc, 'Image fixture (AC-19.9).')
      await page.locator('.preview-pane img[alt="att"]').waitFor({ state: 'visible' })
      const html = (await download(page, 'download-html')).bytes.toString('utf8')
      const { context: c2, page: p2 } = await openExported(html, 'ac19-9.html')
      try {
        const srcs = await p2.evaluate(() => Object.fromEntries([...document.querySelectorAll('img')].map((i) => [i.alt, i.getAttribute('src')])))
        assert.match(srcs.att, /^data:image\//, 'attachment inlined')
        assert.equal(srcs.ext, external, 'external URL unchanged')
      } finally { await c2.close() }
    } finally { await context.close() }
  })

  it('AC-19.10 offline, an in-doc #section link in the exported file scrolls to its heading', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.mermaid, 'Diagram fixture (AC-19.5).')
      const html = (await download(page, 'download-html')).bytes.toString('utf8')
      const { context: c2, page: p2 } = await openExported(html, 'ac19-10.html')
      try {
        assert.equal(await p2.evaluate(() => window.scrollY), 0)
        await p2.locator('a[href="#the-end"]').click()
        await eventually(async () => {
          const top = await p2.evaluate(() => document.getElementById('the-end').getBoundingClientRect().top)
          assert.ok(top >= -1 && top < 100, `heading at the top (${top})`)
        })
        assert.ok(await p2.evaluate(() => window.scrollY) > 0)
      } finally { await c2.close() }
    } finally { await context.close() }
  })

  it('AC-19.11 PDF: window.print is called exactly once, after every mermaid SVG exists', T, async () => {
    const { context, page } = await openCtx(browser, {
      init: () => {
        window.__prints = []
        window.print = () => { window.__prints.push(document.querySelectorAll('.preview-pane .mermaid > svg').length) }
      },
    })
    try {
      await openDoc(page, docs.mermaid, 'Diagram fixture (AC-19.5).')
      const menu = await openMenu(page)
      await menu.locator(tid('download-pdf')).click()
      await page.waitForFunction(() => window.__prints.length > 0, null, { timeout: 15_000 })
      await sleep(300)
      assert.deepEqual(await page.evaluate(() => window.__prints), [2], 'once, with both diagrams drawn')
      assert.equal(await page.locator(tid('download-menu')).count(), 0, 'menu closed')
    } finally { await context.close() }
  })

  it('AC-19.12 a pinned revision downloads its own source, not the latest', T, async () => {
    const doc = await createDoc({ markdown: '# Pinned\n\nVersion ONE (AC-19.12).\n', filename: 'pinned.md', sessionName: uniq('Pinned19'), author: 'Alice' })
    await putMarkdown(doc.id, '# Pinned\n\nVersion TWO (AC-19.12).\n', { author: 'Bob' })
    const list = await listRevisions(doc.id)
    const H = list.revisions.find((r) => r.hash !== list.current)?.hash
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${doc.id}@${H}`)
      await page.locator('.preview-pane').filter({ hasText: 'Version ONE (AC-19.12).' }).waitFor()
      const { name, bytes } = await download(page, 'download-md')
      assert.equal(name, 'pinned.md')
      assert.equal(bytes.toString('utf8'), '# Pinned\n\nVersion ONE (AC-19.12).\n')
    } finally { await context.close() }
  })

  it('AC-19.13 keyboard: Enter opens, arrows move, Enter downloads, Esc closes back to the button', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.weekly, 'Shipped the thing')
      const btn = page.locator(tid('download-menu-btn'))
      await btn.focus()
      await page.keyboard.press('Enter')
      await page.locator(tid('download-menu')).waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'download-md')
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'download-html')
      await page.keyboard.press('ArrowUp')
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'download-md')
      const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')])
      assert.equal(dl.suggestedFilename(), 'Weekly Update.md')
      await btn.focus()
      await page.keyboard.press('Enter')
      await page.locator(tid('download-menu')).waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      await page.locator(tid('download-menu')).waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'download-menu-btn')
    } finally { await context.close() }
  })

  it('AC-19.14 phone and tablet: a "Download" group in the overflow menu, items ≥ 44px on a phone, no download-menu-btn', T, async () => {
    for (const [name, viewport] of [['phone', VIEWPORTS.phone], ['tablet', VIEWPORTS.tablet]]) {
      const { context, page } = await openCtx(browser, { viewport })
      try {
        await openDoc(page, docs.weekly, 'Shipped the thing')
        assert.equal(await page.locator(tid('download-menu-btn')).count(), 0, `${name}: no bar button`)
        const menu = await openMenu(page)
        const group = menu.locator('[role="group"][aria-label="Download"]')
        assert.equal(await group.count(), 1, `${name}: Download group`)
        const ids = await group.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => e.dataset.testid))
        assert.deepEqual(ids, ['download-md', 'download-html', 'download-pdf'])
        if (name === 'phone') {
          for (const id of ids) {
            const box = await menu.locator(tid(id)).boundingBox()
            assert.ok(box.height >= 44, `${id} height ${box.height}`)
          }
        }
        // 00 §2.3 order: Download group, then reader settings, then Library/Home.
        const order = await menu.evaluate((m) => [...m.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid))
        const iDl = order.indexOf('download-md')
        assert.ok(iDl >= 0)
        if (order.includes('reader-settings-btn')) assert.ok(order.indexOf('reader-settings-btn') > iDl, 'reader settings after the Download group')
        if (order.includes('nav-library')) assert.ok(order.indexOf('nav-library') > iDl, 'library after the Download group')
        await menu.locator(tid('download-md')).waitFor({ state: 'visible' })
        const [dl] = await Promise.all([page.waitForEvent('download'), menu.locator(tid('download-md')).click()])
        assert.equal(dl.suggestedFilename(), 'Weekly Update.md')
        await page.screenshot({ path: join(OUT, `ac19-14-${name}.png`) })
      } finally { await context.close() }
    }
  })

  it('AC-19.15 .md, HTML source and PDF issue no request to the backend', T, async () => {
    const { context, page } = await openCtx(browser, { init: () => { window.print = () => { window.__printed = (window.__printed || 0) + 1 } } })
    try {
      await openDoc(page, docs.mermaid, 'Diagram fixture (AC-19.5).')
      await waitDiagrams(page, 2)
      await sleep(500)
      const hits = []
      page.on('request', (r) => { if (r.url().startsWith(API)) hits.push(r.method() + ' ' + new URL(r.url()).pathname) })
      await download(page, 'download-md')
      const menu = await openMenu(page)
      await menu.locator(tid('download-pdf')).click()
      await page.waitForFunction(() => window.__printed === 1)
      await page.goto(`${BASE}/d/${docs.html.slug || docs.html.id}`)
      await page.locator('iframe.html-frame').waitFor({ state: 'visible' })
      await sleep(500)
      hits.length = 0
      await download(page, 'download-html-source')
      await sleep(300)
      // Background polling (sync, views) is not ours: only count requests made between click and file.
      assert.deepEqual(hits.filter((h) => !/\/(views|reactions|meta)$/.test(h) && !/^GET \/paste\/[^/]+$/.test(h)), [])
    } finally { await context.close() }
  })

  it('AC-19.16 a failing .html export shows a "Download failed" error toast, no download, URL unchanged', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.rich, 'Rich fixture (AC-19.8).')
      const url = page.url()
      await page.evaluate(() => {
        // However the exporter copies the preview (cloneNode / importNode), copying it throws.
        const orig = Node.prototype.cloneNode
        Node.prototype.cloneNode = function (deep) {
          if (this instanceof Element && this.classList.contains('preview-pane')) throw new Error('forced export failure')
          return orig.call(this, deep)
        }
        const origImport = Document.prototype.importNode
        Document.prototype.importNode = function (node, deep) {
          if (node instanceof Element && node.classList.contains('preview-pane')) throw new Error('forced export failure')
          return origImport.call(this, node, deep)
        }
      })
      let downloads = 0
      page.on('download', () => downloads++)
      const menu = await openMenu(page)
      await menu.locator(tid('download-html')).click()
      const toast = page.locator(`${tid('app-toast')}[data-kind="error"]`)
      await toast.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await toast.innerText(), /Download failed/)
      await sleep(500)
      assert.equal(downloads, 0)
      assert.equal(page.url(), url)
    } finally { await context.close() }
  })

  it('rule 11: busy state on download-html while working; a second click meanwhile starts no second download', T, async () => {
    const doc = await createDoc({ markdown: '# Busy\n\nBusy fixture (rule 11).\n\n![slow](/slow-image-19.png)\n', filename: 'busy.md', sessionName: uniq('Busy') })
    const png = Buffer.from(pngDataUri(8, 8).split(',')[1], 'base64')
    const { context, page } = await openCtx(browser)
    let slow = false
    await context.route('**/slow-image-19.png', async (r) => { if (slow) await sleep(2500); await r.fulfill({ status: 200, contentType: 'image/png', body: png }) })
    try {
      await openDoc(page, doc, 'Busy fixture (rule 11).')
      slow = true
      const seen = []
      page.on('download', (d) => seen.push(d.suggestedFilename()))
      const menu = await openMenu(page)
      await menu.locator(tid('download-html')).click()
      const btn = page.locator(tid('download-menu-btn'))
      await eventually(async () => assert.equal(await btn.getAttribute('aria-busy'), 'true'))
      await btn.click()
      await page.locator(tid('download-menu')).waitFor({ state: 'visible' })
      const item = page.locator(tid('download-html'))
      assert.equal(await item.getAttribute('aria-busy'), 'true')
      assert.equal(await item.getAttribute('aria-disabled'), 'true')
      // force: Playwright would wait for aria-disabled to clear; a reader's click lands at once.
      await item.click({ force: true })
      await page.waitForEvent('download', { timeout: 15_000 })
      await sleep(1000)
      assert.deepEqual(seen, ['busy.html'], 'one download only')
      assert.notEqual(await btn.getAttribute('aria-busy'), 'true')
    } finally { await context.close() }
  })

  it('edge: a theme switched just before export exports diagrams drawn for the new theme', T, async () => {
    const { context, page } = await openCtx(browser, { theme: 'light' })
    try {
      await openDoc(page, docs.mermaid, 'Diagram fixture (AC-19.5).')
      await waitDiagrams(page, 2)
      const styleOf = (html) => (html.match(/<svg[^>]*>\s*<style>([\s\S]*?)<\/style>/) ?? [])[1]?.replace(/#?mermaid-[\w-]+/g, 'M')
      const before = styleOf(await page.evaluate(() => document.querySelector('.preview-pane .mermaid > svg').outerHTML))
      await page.locator(tid('theme-toggle')).click()
      const html = (await download(page, 'download-html')).bytes.toString('utf8')
      await page.waitForFunction(() => [...document.querySelectorAll('.preview-pane .mermaid')].every((m) => m.dataset.renderedKey === JSON.stringify({ theme: 'dark' })))
      const after = styleOf(await page.evaluate(() => document.querySelector('.preview-pane .mermaid > svg').outerHTML))
      assert.notEqual(before, after, 'the dark drawing differs from the light one')
      assert.equal(styleOf(html), after, 'export carries the dark drawing')
      assert.match(html, /<html lang="en" class="dark"/)
    } finally { await context.close() }
  })

  it('edit and split views export the current (unsaved) editor content; every theme exports', SLOW, async () => {
    const doc = await createDoc({ markdown: MERMAID_SRC, filename: 'edit.md', sessionName: uniq('Edit19') })
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${doc.id}?view=edit`)
      const content = page.locator('.cm-content').first()
      await content.waitFor({ state: 'visible', timeout: 15_000 })
      await content.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nUNSAVED EDIT 19\n')
      const md = (await download(page, 'download-md')).bytes.toString('utf8')
      assert.ok(md.includes('UNSAVED EDIT 19'), 'md has the edit')
      const html = (await download(page, 'download-html')).bytes.toString('utf8')
      assert.ok(html.includes('UNSAVED EDIT 19'), 'html has the edit')
      const { context: c2, page: p2 } = await openExported(html, 'edit-view.html')
      try {
        assert.equal(await p2.evaluate(() => document.querySelectorAll('.mermaid > svg').length), 2, 'diagrams drawn off screen in edit view')
      } finally { await c2.close() }
      await page.locator(tid('view-toggle-split')).click()
      await page.locator('[data-pane="preview"] .preview-pane').waitFor({ state: 'visible' })
      const html2 = (await download(page, 'download-html')).bytes.toString('utf8')
      assert.ok(html2.includes('UNSAVED EDIT 19'), 'split html has the edit')
      // PDF from the edit view prints the read view, then puts the editor back.
      await page.locator(tid('view-toggle-edit')).click()
      await page.evaluate(() => { window.__printView = []; window.print = () => window.__printView.push(new URL(location.href).searchParams.get('view')) })
      const menu = await openMenu(page)
      await menu.locator(tid('download-pdf')).click()
      await page.waitForFunction(() => window.__printView.length === 1, null, { timeout: 15_000 })
      assert.deepEqual(await page.evaluate(() => window.__printView), ['read'])
      await eventually(async () => assert.equal(new URL(page.url()).searchParams.get('view'), 'edit'))
    } finally { await context.close() }
    for (const theme of THEMES) {
      const { context: c, page: p } = await openCtx(browser, { theme })
      try {
        await openDoc(p, docs.rich, 'Rich fixture (AC-19.8).')
        const bg = await p.evaluate(() => getComputedStyle(document.querySelector('.preview-pane')).backgroundColor)
        const html = (await download(p, 'download-html')).bytes.toString('utf8')
        const { context: c2, page: p2 } = await openExported(html, `theme-${theme}.html`)
        try {
          assert.equal(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor), bg, `${theme} background`)
          await p2.screenshot({ path: join(OUT, `theme-${theme}.png`) })
        } finally { await c2.close() }
      } finally { await c.close() }
    }
  })
})
