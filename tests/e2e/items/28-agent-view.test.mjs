// #28 Human view vs agent view — acceptance tests in the browser
// (docs/build/specs/28-agent-view.md AC-28.1–28.4, 28.8, 28.14–28.19 FE half).
// Parser/strip ACs (28.5–28.7) are unit tests in tests/items/28-agent-view.test.ts;
// raw/REST/MCP ACs are server tests in server/test-items/28-agent-view.test.mjs.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, historyLength } from '../lib/docs.mjs'
import { openCtx, openDoc, colorsOf, contrast, THEMES, VIEWPORTS, tid, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/28')
const T = { timeout: 60_000 }
const SLOW = { timeout: 240_000 }

const MARK = 'Agent view fixture intro (AC-28).'
const SECRET1 = 'Evidence alpha only agents read.'
const SECRET2 = 'SELECT secret_column FROM evidence;'
const SRC = [
  '# Agent fixture', '', MARK, '',
  '## Summary', '', 'Human summary paragraph.', '',
  '<!-- agent -->',
  '## Details', '', SECRET1, '',
  '| Col | Val |', '|---|---|', '| a | 1 |', '',
  '```sql', SECRET2, '```', '',
  '```mermaid', 'graph TD', '  A-->B', '```',
  '<!-- /agent -->', '',
  '## Details', '', 'Visible details paragraph.', '',
  '<!-- agent: Raw SQL -->',
  'Second secret block text.',
  '<!-- /agent -->', '',
  'Closing paragraph.',
].join('\n')
const HIDDEN_HEADING_LINE = SRC.split('\n').indexOf('<!-- agent -->') + 1

const PLAIN = ['# Plain doc', '', 'Plain doc without markers.', '', '## A', '', 'Text A.'].join('\n')

const TITLE_SRC = ['<!-- agent -->', '# Hidden Title', '', 'Agent-only intro words.', '<!-- /agent -->', '', '# Visible', '', 'Title doc body text.'].join('\n')

let browser
const docs = {}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.main = await createDoc({ markdown: SRC, filename: 'agent.md', sessionName: uniq('Agent view'), mode: 'publish' })
  docs.plain = await createDoc({ markdown: PLAIN, filename: 'plain.md', sessionName: uniq('Plain'), mode: 'publish' })
  docs.title = await createDoc({ markdown: TITLE_SRC, filename: 'title.md', mode: 'publish' })
  docs.html = await createDoc({ markdown: '<!doctype html><html><head><title>H</title></head><body><h1>HTML agent doc</h1><p>Html body text.</p></body></html>', filename: 'page.html', contentType: 'html', sessionName: uniq('Html'), mode: 'publish' })
})
after(async () => { await browser?.close() })

const bodyText = (page) => page.evaluate(() => document.body.innerText)
const urlOf = (page) => new URL(page.url())

describe('#28 human view vs agent view', () => {
  it('AC-28.1 human view: no agent-section DOM, hidden text absent, notice reads "2 agent-only sections hidden"', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      await page.locator(tid('agent-sections-notice')).waitFor({ state: 'visible' })
      assert.equal(await page.locator(tid('agent-section')).count(), 0)
      const text = await bodyText(page)
      assert.ok(!text.includes(SECRET1), 'first section text hidden')
      assert.ok(!text.includes('Second secret block text.'), 'second section text hidden')
      assert.ok(text.includes('Visible details paragraph.'))
      assert.match(await page.locator(tid('agent-sections-notice')).innerText(), /2 agent-only sections hidden/)
      // No DOM at all: not even the marker comments inside the preview.
      const html = await page.locator('.preview-pane').evaluate((el) => el.innerHTML)
      assert.ok(!html.includes(SECRET1) && !/<!--\s*agent/i.test(html))
      // TOC lists the visible "Details" only once.
      const toc = await page.locator(tid('toc-link')).allInnerTexts()
      assert.equal(toc.filter((t) => t.trim() === 'Details').length, 1)
      await page.screenshot({ path: join(SCREENS, 'human.png') })
    } finally { await context.close() }
  })

  it('AC-28.2 Show → ?view=agent without reload; two sections in order; second label "Agent-only · Raw SQL"', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK, '?x=1#summary')
      await page.evaluate(() => { window.__noReload = true })
      const len = await historyLength(page)
      await page.locator(tid('agent-sections-show')).click()
      await page.locator(tid('agent-section')).first().waitFor({ state: 'visible' })
      const u = urlOf(page)
      assert.equal(u.searchParams.get('view'), 'agent')
      assert.equal(u.searchParams.get('x'), '1', 'other params kept')
      assert.equal(u.hash, '#summary', 'fragment kept')
      assert.equal(await page.evaluate(() => window.__noReload), true, 'no reload')
      assert.equal(await historyLength(page), len, 'replaceState')
      const sections = page.locator(tid('agent-section'))
      assert.equal(await sections.count(), 2)
      assert.deepEqual(await sections.evaluateAll((els) => els.map((e) => e.dataset.agentIndex)), ['0', '1'])
      assert.equal((await sections.nth(0).locator(tid('agent-section-label')).innerText()).trim(), 'Agent-only')
      assert.equal((await sections.nth(1).locator(tid('agent-section-label')).innerText()).trim(), 'Agent-only · Raw SQL')
      assert.equal(await page.locator(tid('agent-sections-notice')).count(), 0)
      const banner = page.locator(tid('agent-view-banner'))
      assert.match(await banner.innerText(), /Agent view — showing 2 agent-only sections/)
      assert.ok((await page.locator(tid('agent-raw-link')).getAttribute('href')).endsWith(`/d/${docs.main.slug || docs.main.id}.md`))
      await page.screenshot({ path: join(SCREENS, 'agent.png') })
      // Reader view removes `view`.
      await page.locator(tid('agent-view-exit')).click()
      await eventually(async () => assert.equal(urlOf(page).searchParams.get('view'), null))
      await page.locator(tid('agent-sections-notice')).waitFor({ state: 'visible' })
      assert.equal(await page.locator(tid('agent-section')).count(), 0)
      assert.equal(await page.locator(tid('agent-view-banner')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-28.3 no markers: no notice; ?view=agent banner reads "showing 0 agent-only sections"', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.plain, 'Plain doc without markers.')
      assert.equal(await page.locator(tid('agent-sections-notice')).count(), 0)
      await openDoc(page, docs.plain, 'Plain doc without markers.', '?view=agent')
      await page.locator(tid('agent-view-banner')).waitFor({ state: 'visible' })
      assert.match(await page.locator(tid('agent-view-banner')).innerText(), /showing 0 agent-only sections/)
      assert.equal(urlOf(page).searchParams.get('view'), 'agent')
    } finally { await context.close() }
  })

  it('AC-28.4 agent view renders a table, a code block and a mermaid SVG inside the section', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK, '?view=agent')
      const first = page.locator(tid('agent-section')).first()
      await first.waitFor({ state: 'visible' })
      assert.equal(await first.locator('table').count(), 1)
      assert.ok(await first.locator('pre').count() >= 1)
      assert.match(await first.locator('pre').first().innerText(), /secret_column/)
      await first.locator('.mermaid svg').waitFor({ state: 'attached', timeout: 15_000 })
    } finally { await context.close() }
  })

  it('AC-28.8 a deep link to a heading inside a section switches to ?view=agent#id (replaceState) and scrolls to it', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${docs.main.slug || docs.main.id}`)
      await page.waitForFunction((m) => document.body.innerText.includes(m), MARK)
      const len = await historyLength(page)
      // The hidden "Details" heading is the first one: id `details` (the visible one is `details-1`).
      await page.goto(`${BASE}/d/${docs.main.slug || docs.main.id}#details`)
      await page.locator('#details').waitFor({ state: 'visible', timeout: 15_000 })
      await eventually(async () => assert.equal(urlOf(page).searchParams.get('view'), 'agent'))
      assert.equal(urlOf(page).hash, '#details')
      assert.equal(await historyLength(page), len + 1, 'only the goto adds an entry; the view switch replaces')
      assert.equal(await page.locator('#details').getAttribute('data-line-start'), String(HIDDEN_HEADING_LINE))
      await eventually(async () => {
        const top = await page.locator('#details').evaluate((el) => el.getBoundingClientRect().top)
        assert.ok(top >= 0 && top < 450, `heading top ${top} in view`)
      })
    } finally { await context.close() }
  })

  it('AC-28.14 .md download: human view has no agent text; agent view equals the full source', T, async () => {
    const { context, page } = await openCtx(browser, { acceptDownloads: true })
    const download = async () => {
      const btn = page.locator(tid('download-menu-btn'))
      await btn.waitFor({ state: 'visible' })
      await btn.click()
      const menu = page.locator(tid('download-menu'))
      await menu.waitFor({ state: 'visible' })
      const [dl] = await Promise.all([page.waitForEvent('download'), menu.locator(tid('download-md')).click()])
      return readFileSync(await dl.path(), 'utf8')
    }
    try {
      await openDoc(page, docs.main, MARK)
      const human = await download()
      assert.ok(!human.includes(SECRET1) && !human.includes('Second secret block text.'), 'human download stripped')
      assert.ok(human.includes('Visible details paragraph.'))
      assert.ok(!/<!--\s*agent/i.test(human))
      await openDoc(page, docs.main, MARK, '?view=agent')
      await page.locator(tid('agent-section')).first().waitFor({ state: 'visible' })
      assert.equal(await download(), SRC)
    } finally { await context.close() }
  })

  it('AC-28.15 head link rel=alternate type=text/markdown → /d/<slug>.md; gone on /library', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK)
      const sel = 'head link[rel="alternate"][type="text/markdown"]'
      await eventually(async () => assert.equal(await page.locator(sel).count(), 1))
      const href = await page.locator(sel).getAttribute('href')
      assert.ok(href.endsWith(`/d/${docs.main.slug || docs.main.id}.md`), href)
      assert.ok(href.startsWith(API), `href uses the API origin: ${href}`)
      await page.goto(`${BASE}/library`)
      await eventually(async () => assert.equal(await page.locator(sel).count(), 0))
    } finally { await context.close() }
  })

  it('AC-28.16 HTML doc with ?view=agent: iframe renders, no notice, no banner', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(`${BASE}/d/${docs.html.slug || docs.html.id}?view=agent`)
      const frame = page.locator('iframe.html-frame')
      await frame.waitFor({ state: 'visible', timeout: 15_000 })
      await eventually(async () => assert.match(await page.frameLocator('iframe.html-frame').locator('body').innerText(), /Html body text/))
      assert.equal(await page.locator(tid('agent-sections-notice')).count(), 0)
      assert.equal(await page.locator(tid('agent-view-banner')).count(), 0)
      const res = await fetch(`${API}/d/${docs.html.slug || docs.html.id}.md`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type'), /^text\/plain/)
      assert.match(await res.text(), /HTML agent doc/)
    } finally { await context.close() }
  })

  it('AC-28.17 split view: preview shows agent sections and the editor shows the marker lines', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK, '?view=split')
      await page.locator(tid('split-view')).waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
      await page.locator(`${tid('split-pane-preview')} ${tid('agent-section')}`).first().waitFor({ state: 'attached' })
      assert.equal(await page.locator(`${tid('split-pane-preview')} ${tid('agent-section')}`).count(), 2)
      assert.match(await page.locator(`${tid('split-pane-editor')} .cm-content`).innerText(), /<!-- agent -->/)
      assert.equal(await page.locator(tid('agent-sections-notice')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-28.18 every theme: dashed visible left border on agent-section; notice contrast ≥ 4.5:1', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await openDoc(page, docs.main, MARK)
        await page.locator(tid('agent-sections-notice')).waitFor({ state: 'visible' })
        const c = await colorsOf(page, `[data-testid="agent-sections-notice"]`)
        const ratio = contrast(c.fg, c.bg)
        assert.ok(ratio >= 4.5, `${theme} notice contrast ${ratio.toFixed(2)}`)
        const b = await colorsOf(page, `[data-testid="agent-sections-show"]`)
        assert.ok(contrast(b.fg, b.bg) >= 4.5, `${theme} Show button contrast ${contrast(b.fg, b.bg).toFixed(2)}`)
        await page.locator(tid('agent-sections-show')).click()
        const sec = page.locator(tid('agent-section')).first()
        await sec.waitFor({ state: 'visible' })
        const st = await sec.evaluate((el) => { const s = getComputedStyle(el); return { style: s.borderLeftStyle, width: parseFloat(s.borderLeftWidth), color: s.borderLeftColor, bg: s.backgroundColor } })
        assert.equal(st.style, 'dashed', `${theme} border style`)
        assert.ok(st.width >= 2, `${theme} border width ${st.width}`)
        assert.notEqual(st.color, 'rgba(0, 0, 0, 0)')
        const lab = await colorsOf(page, `[data-testid="agent-section-label"]`)
        assert.ok(contrast(lab.fg, lab.bg) >= 4.5, `${theme} label contrast`)
        await page.screenshot({ path: join(SCREENS, `agent-${theme}.png`) })
      } finally { await context.close() }
    }
  })

  it('pinned revision in agent view: banner shown, no raw link (the raw endpoint serves the latest version)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      const doc = await createDoc({ markdown: SRC, filename: 'pin.md', sessionName: uniq('Pinned'), mode: 'publish', author: 'Alice' })
      await putMarkdown(doc.id, `${SRC}\n\nA later edit.\n`, { author: 'Bob' })
      const list = await listRevisions(doc.id)
      const H = list.revisions.find((r) => r.hash !== list.current).hash
      await page.goto(`${BASE}/d/${doc.id}@${H}?view=agent`)
      await page.locator(tid('agent-view-banner')).waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(await page.locator(tid('agent-raw-link')).count(), 0)
      assert.equal(await page.locator(tid('agent-section')).count(), 2)
      assert.equal(await page.locator('head link[rel="alternate"][type="text/markdown"]').count(), 0)
    } finally { await context.close() }
  })

  it('AC-28.19 document.title comes from the first human-visible H1', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.title, 'Title doc body text.')
      await eventually(async () => assert.equal(await page.title(), 'Visible · md-review'))
      assert.equal((await page.locator(tid('doc-title')).innerText()).trim(), 'Visible')
      // Agent view keeps the human-view title.
      await page.locator(tid('agent-sections-show')).click()
      await page.locator(tid('agent-section')).first().waitFor({ state: 'visible' })
      assert.equal(await page.title(), 'Visible · md-review')
    } finally { await context.close() }
  })

  it('live update while in human view: a new section updates the notice count (edge case)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      const doc = await createDoc({ markdown: '# Live\n\nLive intro words.\n\n<!-- agent -->\nOne.\n<!-- /agent -->\n', filename: 'live.md', sessionName: uniq('Live'), mode: 'publish' })
      await openDoc(page, doc, 'Live intro words.')
      await eventually(async () => assert.match(await page.locator(tid('agent-sections-notice')).innerText(), /1 agent-only section hidden/))
      await putMarkdown(doc.id, '# Live\n\nLive intro words.\n\n<!-- agent -->\nOne.\n<!-- /agent -->\n\n<!-- agent -->\nTwo.\n<!-- /agent -->\n')
      await eventually(async () => assert.match(await page.locator(tid('agent-sections-notice')).innerText(), /2 agent-only sections hidden/), { timeout: 20_000 })
    } finally { await context.close() }
  })

  it('?view=AGENT is unknown → read view and URL rewritten to view=read; ?view=agent&embed=1 renders read', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.main, MARK, '?view=AGENT')
      await eventually(async () => assert.equal(urlOf(page).searchParams.get('view'), 'read'))
      assert.equal(await page.locator(tid('agent-section')).count(), 0)
      await openDoc(page, docs.main, MARK, '?view=agent&embed=1')
      assert.equal(await page.locator(tid('agent-section')).count(), 0)
      assert.equal(urlOf(page).searchParams.get('view'), 'agent', 'embed ignores and does not rewrite view')
    } finally { await context.close() }
  })

  it('phone 390×844: notice and banner fit without horizontal overflow', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.phone })
    try {
      await openDoc(page, docs.main, MARK)
      await page.locator(tid('agent-sections-notice')).waitFor({ state: 'visible' })
      await page.locator(tid('agent-sections-show')).click()
      await page.locator(tid('agent-view-banner')).waitFor({ state: 'visible' })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}`)
      await page.screenshot({ path: join(SCREENS, 'phone-agent.png') })
    } finally { await context.close() }
  })
})
