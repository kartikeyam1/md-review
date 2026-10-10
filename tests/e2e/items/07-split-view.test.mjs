// #7 Side-by-side edit + preview with synced scrolling — acceptance tests
// (docs/build/specs/07-split-view.md, 00 §1.3 view resolution, §10.3 storage keys,
// §10.4 bridge messages, §12 the 960px split breakpoint).
//
// Editor positions are read from CodeMirror's own line-number gutter: the first
// gutter element that is still (partly) visible below the scroller's top edge
// is the first visible line. Scrolling the editor to a given line uses the
// uniform line height of the fixtures (short lines, no wrapping).
//
// The HTML preview is an opaque-origin sandboxed iframe; Playwright can still
// evaluate inside it, which is how the iframe's scroll ratio is read and set.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, API } from '../helpers.mjs'
import { createDoc, listRevisions, uniq } from '../lib/docs.mjs'

const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const SYNC_WAIT = 300
const ED = `${tid('split-pane-editor')} .cm-scroller`
const PV = `${tid('split-pane-preview')} .preview-pane`

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac07-'))
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

let fileSeq = 0
function localDocUrl(text, query = '') {
  const p = join(tmp, `split-${++fileSeq}.md`)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}${query}`
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

/** Waits for split view with a live editor and a preview showing `marker`. */
async function waitSplit(page, marker) {
  await page.locator(tid('split-view')).waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
  if (marker) await page.locator(PV).filter({ hasText: marker }).first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function openLocalSplit(page, text, marker) {
  await page.goto(localDocUrl(text, '&view=split'))
  await waitSplit(page, marker)
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** 300 source lines, `## Section N` on every 20th line, one-line paragraphs on the even lines between. */
function sectionsFixture(lines = 300) {
  const out = []
  for (let i = 0; i < lines; i++) {
    if (i % 20 === 0) out.push(`## Section ${i / 20} at line ${i}`)
    else if (i % 2 === 1) out.push('')
    else out.push(`Paragraph on source line ${i} with a few words of filler text.`)
  }
  return out.join('\n') + '\n'
}

function htmlFixture(paras = 150) {
  const body = Array.from({ length: paras }, (_, i) => `<p>HTML paragraph ${i} with enough text to take a line.</p>`).join('\n')
  return `<!doctype html>\n<html>\n<head><title>Tall</title></head>\n<body>\n<h1>Tall HTML doc</h1>\n${body}\n</body>\n</html>\n`
}

// ── editor / preview geometry ───────────────────────────────────────────────

/** Scrolls the split editor so source line `line` (0-indexed) is the first visible line. */
async function scrollEditorToLine(page, line) {
  await page.evaluate(({ sel, line }) => {
    const sc = document.querySelector(sel)
    sc.scrollTop = 0
    const first = sc.querySelector('.cm-content .cm-line')
    const top0 = first.getBoundingClientRect().top - sc.getBoundingClientRect().top
    const lh = first.getBoundingClientRect().height
    sc.scrollTop = top0 + line * lh
  }, { sel: ED, line })
  // CodeMirror draws the newly visible lines (and their gutter) on the next frame.
  await until(async () => (await editorFirstLine(page)) !== null, { message: 'editor lines drawn' })
}

/** First visible editor line (0-indexed), from the line-number gutter. */
async function editorFirstLine(page) {
  return page.evaluate((sel) => {
    const sc = document.querySelector(sel)
    const top = sc.getBoundingClientRect().top
    const els = [...sc.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
      .filter((e) => /^\d+$/.test(e.textContent.trim()))
      .map((e) => ({ n: Number(e.textContent.trim()), r: e.getBoundingClientRect() }))
      .filter((e) => e.r.height > 0 && e.r.bottom > top + 1)
      .sort((a, b) => a.r.top - b.r.top)
    return els.length ? els[0].n - 1 : null
  }, ED)
}

const metrics = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null
}, sel)

const setScroll = (page, sel, top) => page.evaluate(({ s, top }) => {
  const el = document.querySelector(s)
  el.scrollTop = top === 'bottom' ? el.scrollHeight : top
}, { s: sel, top })

/** px between the deepest preview block containing `line` and the preview's top edge (0 when it spans the edge). */
async function previewBlockOffset(page, line) {
  return page.evaluate(({ sel, line }) => {
    const pv = document.querySelector(sel)
    const els = [...pv.querySelectorAll('[data-line-start]')].filter((e) => {
      const s = Number(e.dataset.lineStart); const en = Number(e.dataset.lineEnd)
      return s <= line && line < en
    })
    if (!els.length) return null
    const depth = (e) => { let d = 0; for (let p = e; p && p !== pv; p = p.parentElement) d++; return d }
    els.sort((a, b) => depth(b) - depth(a))
    const r = els[0].getBoundingClientRect()
    const top = pv.getBoundingClientRect().top
    if (r.top <= top && r.bottom >= top) return 0
    return r.top - top
  }, { sel: PV, line })
}

const htmlFrame = async (page) => (await page.locator(`${tid('split-pane-preview')} iframe`).elementHandle()).contentFrame()

async function frameRatio(page) {
  const f = await htmlFrame(page)
  return f.evaluate(() => {
    const el = document.scrollingElement || document.documentElement
    const max = el.scrollHeight - innerHeight
    return max > 0 ? el.scrollTop / max : 0
  })
}

async function waitFrameReady(page, marker) {
  await until(async () => {
    const f = await htmlFrame(page).catch(() => null)
    if (!f) return false
    return f.evaluate((m) => document.body?.textContent.includes(m) && document.readyState === 'complete', marker).catch(() => false)
  }, { timeout: 15_000, message: 'html preview loaded' })
}

const pressed = (page, id) => page.locator(tid(id)).getAttribute('aria-pressed')

// ── tests ───────────────────────────────────────────────────────────────────

describe('#7 split view', () => {
  it('AC-07.1 ?view=split at 1400×900: split-view, editor, divider and preview side by side; split toggle pressed', T, async () => {
    const { context, page, errors } = await open()
    try {
      await openLocalSplit(page, '# Split one\n\nBody for AC-07.1.\n', 'Body for AC-07.1.')
      const boxes = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
        return [id, r ? { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height } : null]
      })), ['split-view', 'split-pane-editor', 'split-divider', 'split-pane-preview'])
      for (const [id, b] of Object.entries(boxes)) assert.ok(b && b.width > 0 && b.height > 0, `${id} visible: ${JSON.stringify(b)}`)
      assert.ok(boxes['split-pane-editor'].right <= boxes['split-divider'].left + 1, 'editor left of the divider')
      assert.ok(boxes['split-divider'].right <= boxes['split-pane-preview'].left + 1, 'preview right of the divider')
      assert.ok(Math.abs(boxes['split-pane-editor'].top - boxes['split-pane-preview'].top) < 2, 'same row')
      assert.ok(await page.locator(`${tid('split-pane-editor')} .cm-content`).isVisible())
      assert.equal(await pressed(page, 'view-toggle-split'), 'true')
      assert.equal(await pressed(page, 'view-toggle-edit'), 'false')
      assert.equal(await page.evaluate(() => document.querySelector('.app').dataset.view), 'split')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-07.2 Read → Split via the toggle: ?view=split, history.length unchanged, both panes visible', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl('# Split two\n\nBody for AC-07.2.\n'))
      await page.locator('.preview-pane').filter({ hasText: 'Body for AC-07.2.' }).first().waitFor({ state: 'visible', timeout: 15_000 })
      const len = await page.evaluate(() => history.length)
      await page.locator(tid('view-toggle-split')).click()
      await waitSplit(page, 'Body for AC-07.2.')
      const q = await page.evaluate(() => new URLSearchParams(location.search).get('view'))
      assert.equal(q, 'split')
      assert.equal(await page.evaluate(() => history.length), len, 'replaceState, no new entry')
      assert.ok(await page.locator(tid('split-pane-editor')).isVisible())
      assert.ok(await page.locator(tid('split-pane-preview')).isVisible())
    } finally { await context.close() }
  })

  it('AC-07.3 typing ZEBRA123 at the end of the editor shows in the preview within 1s', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, '# Split three\n\nBody for AC-07.3.\n', 'Body for AC-07.3.')
      await page.locator(`${tid('split-pane-editor')} .cm-content`).click()
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.type('\nZEBRA123')
      await page.locator(PV).filter({ hasText: 'ZEBRA123' }).first().waitFor({ state: 'visible', timeout: 1000 })
    } finally { await context.close() }
  })

  it('AC-07.4 divider: drag −200px, clamp at 240px, ratio survives reload, double-click resets 50/50', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, '# Split four\n\nBody for AC-07.4.\n', 'Body for AC-07.4.')
      const width = () => page.locator(tid('split-pane-editor')).evaluate((e) => e.getBoundingClientRect().width)
      const div = page.locator(tid('split-divider'))
      const drag = async (dx) => {
        const b = await div.boundingBox()
        const x = b.x + b.width / 2; const y = b.y + b.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + dx / 2, y, { steps: 4 })
        await page.mouse.move(x + dx, y, { steps: 4 })
        await page.mouse.up()
      }
      const w0 = await width()
      await drag(-200)
      const w1 = await width()
      assert.ok(Math.abs((w0 - w1) - 200) <= 10, `editor narrowed by 200±10: ${w0} → ${w1}`)
      await drag(-2000)
      const w2 = await width()
      assert.ok(w2 >= 240 - 0.5, `editor ≥ 240px: ${w2}`)
      assert.ok(w2 < w1, 'the drag moved it further')
      const previewW = await page.locator(tid('split-pane-preview')).evaluate((e) => e.getBoundingClientRect().width)
      await drag(4000)
      const pw = await page.locator(tid('split-pane-preview')).evaluate((e) => e.getBoundingClientRect().width)
      assert.ok(pw >= 240 - 0.5, `preview ≥ 240px: ${pw} (was ${previewW})`)
      await drag(-((await width()) - w1))
      const before = await width()
      await page.reload()
      await waitSplit(page, 'Body for AC-07.4.')
      const after = await width()
      assert.ok(Math.abs(after - before) <= 3, `ratio restored: ${before} vs ${after}`)
      await div.dblclick()
      const ew = await width()
      const pw2 = await page.locator(tid('split-pane-preview')).evaluate((e) => e.getBoundingClientRect().width)
      assert.ok(Math.abs(ew - pw2) / (ew + pw2) <= 0.01, `50/50 ±1%: ${ew} / ${pw2}`)
    } finally { await context.close() }
  })

  it('AC-07.5 the divider is a keyboard separator: ArrowRight ×2 → aria-valuenow +10', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, '# Split five\n\nBody for AC-07.5.\n', 'Body for AC-07.5.')
      const div = page.locator(tid('split-divider'))
      assert.equal(await div.getAttribute('role'), 'separator')
      assert.equal(await div.getAttribute('aria-orientation'), 'vertical')
      assert.equal(await div.getAttribute('tabindex'), '0')
      assert.ok(await div.getAttribute('aria-valuemin'))
      assert.ok(await div.getAttribute('aria-valuemax'))
      assert.ok(await div.getAttribute('aria-label') || await div.getAttribute('aria-labelledby'), 'accessible name')
      await div.focus()
      const v0 = Number(await div.getAttribute('aria-valuenow'))
      assert.equal(v0, 50)
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      assert.equal(Number(await div.getAttribute('aria-valuenow')), v0 + 10)
      await page.keyboard.press('ArrowLeft')
      assert.equal(Number(await div.getAttribute('aria-valuenow')), v0 + 5)
      await page.keyboard.press('Home')
      assert.equal(await div.getAttribute('aria-valuenow'), String(Math.round(Number(await div.getAttribute('aria-valuemin')))))
      await page.keyboard.press('End')
      assert.equal(await div.getAttribute('aria-valuenow'), String(Math.round(Number(await div.getAttribute('aria-valuemax')))))
    } finally { await context.close() }
  })

  it('AC-07.5 (Tab order) forward Tab reaches the divider without leaving through the editor', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, '# Tab order\n\nBody for the Tab-order check.\n', 'Body for the Tab-order check.')
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
      let reached = false
      for (let i = 0; i < 40 && !reached; i++) {
        await page.keyboard.press('Tab')
        reached = await page.evaluate(() => document.activeElement?.dataset?.testid === 'split-divider')
        if (await page.evaluate(() => !!document.activeElement?.closest('.cm-content'))) break
      }
      assert.ok(reached, 'the divider is reached by Tab before the editor captures it')
      const v0 = Number(await page.locator(tid('split-divider')).getAttribute('aria-valuenow'))
      await page.keyboard.press('ArrowLeft')
      assert.equal(Number(await page.locator(tid('split-divider')).getAttribute('aria-valuenow')), v0 - 5)
    } finally { await context.close() }
  })

  it('AC-07.6 editor scrolled to line 140 → the preview block for line 140 sits at the preview top (±48px) within 300ms', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, sectionsFixture(), 'Section 0 at line 0')
      await scrollEditorToLine(page, 140)
      { const fl = await editorFirstLine(page); assert.equal(fl, 140, `precondition: editor first line 140, got ${fl}`) }
      await page.waitForTimeout(SYNC_WAIT)
      const off = await previewBlockOffset(page, 140)
      assert.ok(off !== null && Math.abs(off) <= 48, `preview block for line 140 at ${off}px from the top edge`)
    } finally { await context.close() }
  })

  it('AC-07.7 preview scrolled to the heading at line 200 → editor first visible line 200±2 within 300ms', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, sectionsFixture(), 'Section 0 at line 0')
      await page.evaluate((sel) => {
        const pv = document.querySelector(sel)
        const h = pv.querySelector('[data-line-start="200"]')
        pv.scrollTop += h.getBoundingClientRect().top - pv.getBoundingClientRect().top
      }, PV)
      await page.waitForTimeout(SYNC_WAIT)
      const first = await editorFirstLine(page)
      assert.ok(first !== null && Math.abs(first - 200) <= 2, `editor first line ${first}`)
    } finally { await context.close() }
  })

  it('AC-07.8 bottom ↔ bottom and top ↔ top in both directions', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, sectionsFixture(), 'Section 0 at line 0')
      const atBottom = (m) => m.top + m.client >= m.height - 2
      await setScroll(page, ED, 'bottom')
      await page.waitForTimeout(SYNC_WAIT)
      assert.ok(atBottom(await metrics(page, PV)), `preview at bottom after editor bottom: ${JSON.stringify(await metrics(page, PV))}`)
      await setScroll(page, ED, 0)
      await page.waitForTimeout(SYNC_WAIT)
      assert.ok((await metrics(page, PV)).top <= 2, 'preview at top after editor top')
      await setScroll(page, PV, 'bottom')
      await page.waitForTimeout(SYNC_WAIT)
      assert.ok(atBottom(await metrics(page, ED)), `editor at bottom after preview bottom: ${JSON.stringify(await metrics(page, ED))}`)
      await setScroll(page, PV, 0)
      await page.waitForTimeout(SYNC_WAIT)
      assert.ok((await metrics(page, ED)).top <= 2, 'editor at top after preview top')
    } finally { await context.close() }
  })

  it('AC-07.9 sync off: scrolling the editor leaves the preview alone; still off after reload', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, sectionsFixture(), 'Section 0 at line 0')
      assert.equal(await pressed(page, 'split-sync-toggle'), 'true', 'sync defaults to on')
      await page.locator(tid('split-sync-toggle')).click()
      assert.equal(await pressed(page, 'split-sync-toggle'), 'false')
      assert.equal(await page.evaluate(() => localStorage.getItem('md-review-split-sync')), '0')
      const before = (await metrics(page, PV)).top
      await scrollEditorToLine(page, 150)
      await page.waitForTimeout(SYNC_WAIT + 200)
      assert.equal((await metrics(page, PV)).top, before, 'preview scrollTop unchanged')
      await page.reload()
      await waitSplit(page, 'Section 0 at line 0')
      assert.equal(await pressed(page, 'split-sync-toggle'), 'false', 'still off after reload')
    } finally { await context.close() }
  })

  it('AC-07.10 HTML doc: editor at 50% → iframe ratio 0.5±0.05; iframe at bottom → editor at bottom', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: htmlFixture(), filename: 'tall.html', contentType: 'html', sessionName: uniq('Split HTML') })
      await page.goto(`${BASE}/d/${doc.id}?view=split`)
      await waitSplit(page)
      await waitFrameReady(page, 'HTML paragraph 149')
      await page.evaluate((sel) => { const sc = document.querySelector(sel); sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2 }, ED)
      const r = await until(async () => { const v = await frameRatio(page); return Math.abs(v - 0.5) <= 0.05 ? v : false }, { timeout: 1500, message: 'iframe ratio ≈ 0.5' })
      assert.ok(Math.abs(r - 0.5) <= 0.05)
      const f = await htmlFrame(page)
      await f.evaluate(() => { const el = document.scrollingElement || document.documentElement; el.scrollTop = el.scrollHeight })
      await until(async () => { const m = await metrics(page, ED); return m.top + m.client >= m.height - 2 }, { timeout: 1500, message: 'editor at its bottom' })
    } finally { await context.close() }
  })

  it('AC-07.11 HTML doc: typing 10 chars with the preview mid-way reloads ≤ 2 times and does not reset it to the top', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: htmlFixture(), filename: 'tall.html', contentType: 'html', sessionName: uniq('Split HTML type') })
      await page.goto(`${BASE}/d/${doc.id}?view=split`)
      await waitSplit(page)
      await waitFrameReady(page, 'HTML paragraph 149')
      const f = await htmlFrame(page)
      await f.evaluate(() => { const el = document.scrollingElement || document.documentElement; el.scrollTop = (el.scrollHeight - innerHeight) / 2 })
      await until(async () => (await metrics(page, ED)).top > 50, { timeout: 1500, message: 'editor followed the iframe' })
      await page.evaluate(() => {
        window.__frameLoads = 0
        document.querySelector('[data-testid="split-pane-preview"] iframe').addEventListener('load', () => { window.__frameLoads++ })
      })
      // Put the caret on a line in the middle of the visible editor (no scroll), at its end.
      const line = await page.evaluate((sel) => {
        const sc = document.querySelector(sel)
        const r = sc.getBoundingClientRect()
        const mid = r.top + r.height / 2
        const l = [...sc.querySelectorAll('.cm-line')].find((e) => { const b = e.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid })
        const b = l.getBoundingClientRect()
        return { x: b.left + 4, y: b.top + b.height / 2 }
      }, ED)
      await page.mouse.click(line.x, line.y)
      await page.keyboard.press('End')
      await page.keyboard.type('abcdefghij', { delay: 25 })
      await until(() => page.evaluate(() => window.__frameLoads >= 1), { timeout: 3000, message: 'debounced reload' })
      await page.waitForTimeout(900)
      const loads = await page.evaluate(() => window.__frameLoads)
      assert.ok(loads <= 2, `iframe reloaded ${loads} times`)
      await waitFrameReady(page, 'HTML paragraph 149')
      const top = await (await htmlFrame(page)).evaluate(() => (document.scrollingElement || document.documentElement).scrollTop)
      assert.ok(top > 0, `iframe not reset to the top (scrollTop ${top})`)
    } finally { await context.close() }
  })

  it('AC-07.12 markdown, sync off, preview at 2000px: typing keeps it within ±50px', T, async () => {
    const { context, page } = await open()
    try {
      await openLocalSplit(page, sectionsFixture(), 'Section 0 at line 0')
      await page.locator(tid('split-sync-toggle')).click()
      assert.equal(await pressed(page, 'split-sync-toggle'), 'false')
      await setScroll(page, PV, 2000)
      assert.equal((await metrics(page, PV)).top, 2000, 'precondition: preview at 2000')
      await page.locator(`${tid('split-pane-editor')} .cm-line`).nth(2).click()
      await page.keyboard.press('End')
      await page.keyboard.type(' typed words here', { delay: 20 })
      await page.locator(PV).filter({ hasText: 'typed words here' }).first().waitFor({ timeout: 2000 })
      await page.waitForTimeout(200)
      const top = (await metrics(page, PV)).top
      assert.ok(Math.abs(top - 2000) <= 50, `preview scrollTop ${top}`)
    } finally { await context.close() }
  })

  for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    it(`AC-07.13 ${viewport.width}×${viewport.height}: tabs, one pane at a time, no horizontal scroll`, T, async () => {
      const { context, page } = await open({ viewport })
      try {
        await page.goto(localDocUrl('# Narrow split\n\nBody for AC-07.13 narrow.\n', '&view=split'))
        await page.locator(tid('split-tabs')).waitFor({ state: 'visible', timeout: 15_000 })
        await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
        assert.ok(!(await page.locator(tid('split-pane-preview')).isVisible()), 'preview hidden on the Edit tab')
        assert.ok(!(await page.locator(tid('split-divider')).isVisible()), 'no divider in tabs mode')
        assert.equal(await page.locator(tid('split-tab-edit')).getAttribute('aria-selected'), 'true')
        await page.locator(tid('split-tab-preview')).click()
        await page.locator(PV).filter({ hasText: 'Body for AC-07.13 narrow.' }).first().waitFor({ state: 'visible', timeout: 5000 })
        assert.ok(!(await page.locator(tid('split-pane-editor')).isVisible()), 'editor hidden on the Preview tab')
        assert.equal(await page.locator(tid('split-tab-preview')).getAttribute('aria-selected'), 'true')
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('view')), 'split')
        const hs = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        assert.ok(hs <= 0, `no horizontal page scroll (${hs}px)`)
      } finally { await context.close() }
    })
  }

  it('AC-07.14 narrow split: typing, Preview tab, Edit tab, Ctrl/Cmd+Z undoes the typing (editor not remounted)', T, async () => {
    const { context, page } = await open({ viewport: { width: 820, height: 1180 } })
    try {
      const text = '# Undo tabs\n\nBody for AC-07.14.\n'
      await page.goto(localDocUrl(text, '&view=split'))
      const cm = page.locator(`${tid('split-pane-editor')} .cm-content`)
      await cm.waitFor({ state: 'visible', timeout: 20_000 })
      await cm.click()
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.type('KEEPTABS')
      await until(async () => (await cm.textContent()).includes('KEEPTABS'), { message: 'typed' })
      await page.evaluate(() => { window.__cmNode = document.querySelector('[data-testid="split-pane-editor"] .cm-editor') })
      await page.locator(tid('split-tab-preview')).click()
      await page.locator(PV).filter({ hasText: 'KEEPTABS' }).first().waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(tid('split-tab-edit')).click()
      await cm.waitFor({ state: 'visible', timeout: 5000 })
      assert.ok(await page.evaluate(() => window.__cmNode === document.querySelector('[data-testid="split-pane-editor"] .cm-editor')), 'same editor DOM (not remounted)')
      // Clicking the Edit tab puts the caret back in the editor: no extra click before Ctrl/Cmd+Z.
      await until(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="split-pane-editor"] .cm-content')), { message: 'editor focused after the Edit tab' })
      await page.keyboard.press(`${MOD}+z`)
      await until(async () => !(await cm.textContent()).includes('KEEPTABS'), { message: 'KEEPTABS undone' })
    } finally { await context.close() }
  })

  it('rule 5 + DECISIONS #7: narrow split with sync on, the Preview tab opens where the editor was', T, async () => {
    const { context, page } = await open({ viewport: { width: 820, height: 1180 } })
    try {
      await page.goto(localDocUrl(sectionsFixture(), '&view=split'))
      await page.locator(`${tid('split-pane-editor')} .cm-content`).waitFor({ state: 'visible', timeout: 20_000 })
      await scrollEditorToLine(page, 140)
      await page.locator(tid('split-tab-preview')).click()
      await page.locator(PV).first().waitFor({ state: 'visible', timeout: 5000 })
      await page.waitForTimeout(SYNC_WAIT)
      const off = await previewBlockOffset(page, 140)
      assert.ok(off !== null && Math.abs(off) <= 48, `preview block for line 140 at ${off}px`)
      await page.locator(tid('split-tab-edit')).click()
      await page.waitForTimeout(SYNC_WAIT)
      const first = await editorFirstLine(page)
      assert.ok(first !== null && Math.abs(first - 140) <= 2, `editor back at line ${first}`)
    } finally { await context.close() }
  })

  it('AC-07.15 front-matter doc: editor line 4 at the top → preview h1 (data-line-start=4) at the top edge ±48px', T, async () => {
    const { context, page } = await open()
    try {
      const fm = '---\na: 1\nb: 2\n---\n# Title\n\n' + sectionsFixture(200)
      await openLocalSplit(page, fm, 'Section 0 at line 0')
      const h1 = page.locator(`${PV} h1[data-line-start="4"]`)
      assert.equal(await h1.count(), 1, 'h1 carries the absolute line 4')
      await scrollEditorToLine(page, 4)
      assert.equal(await editorFirstLine(page), 4, 'precondition: editor first line 4')
      await page.waitForTimeout(SYNC_WAIT)
      const off = await page.evaluate((sel) => {
        const pv = document.querySelector(sel)
        return pv.querySelector('h1[data-line-start="4"]').getBoundingClientRect().top - pv.getBoundingClientRect().top
      }, PV)
      assert.ok(Math.abs(off) <= 48, `h1 ${off}px from the preview top`)
    } finally { await context.close() }
  })

  it('rule 13: a comment card in the sidebar scrolls both panes to its line', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: sectionsFixture(), mode: 'review', sessionName: uniq('Split comments') })
      const res = await fetch(`${API}/paste/${doc.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startLine: 200, endLine: 201, selectedText: 'Section 10 at line 200', body: 'Check this heading', category: 'question' }),
      })
      assert.equal(res.status, 201)
      await page.goto(`${BASE}/d/${doc.id}?view=split`)
      await waitSplit(page, 'Section 0 at line 0')
      await page.locator('.comment-card').filter({ hasText: 'Check this heading' }).click()
      await until(async () => {
        const line = await page.evaluate((sel) => {
          const sc = document.querySelector(sel); const r = sc.getBoundingClientRect()
          return [...sc.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].some((e) => {
            const b = e.getBoundingClientRect(); return e.textContent.trim() === '201' && b.top >= r.top && b.bottom <= r.bottom
          })
        }, ED)
        const block = await page.evaluate((sel) => {
          const pv = document.querySelector(sel); const r = pv.getBoundingClientRect()
          const h = pv.querySelector('[data-line-start="200"]').getBoundingClientRect()
          return h.top >= r.top && h.bottom <= r.bottom
        }, PV)
        return line && block
      }, { timeout: 3000, message: 'line 200 visible in the editor and the preview' })
    } finally { await context.close() }
  })

  it('AC-07.16 a viewer opening ?view=split gets Read, no split toggle, URL view=read', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Viewer split\n\nViewer body AC-07.16.\n', protected: true, sessionName: uniq('Viewer split') })
      await page.goto(`${BASE}/d/${doc.id}?view=split`)
      await page.locator('.preview-pane').filter({ hasText: 'Viewer body AC-07.16.' }).first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
      assert.equal(await page.evaluate(() => document.querySelector('.app').dataset.view), 'read')
      assert.equal(await page.locator(tid('view-toggle-split')).count(), 0)
      assert.equal(await page.locator(tid('split-view')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-07.16 (pinned revision) is read-only: ?view=split → Read, view=read', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Pinned split\n\nPinned body AC-07.16.\n', sessionName: uniq('Pinned split') })
      const list = await listRevisions(doc.id)
      await page.goto(`${BASE}/d/${doc.id}@${list.revisions[0].hash}?view=split`)
      await page.locator('.preview-pane').filter({ hasText: 'Pinned body AC-07.16.' }).first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'read', null, { timeout: 5000 })
      assert.equal(await page.locator(tid('split-view')).count(), 0)
      assert.equal(await page.locator('.cm-editor').count(), 0)
    } finally { await context.close() }
  })

  it('AC-07.17 review-mode doc in split: selecting text in the preview raises the comment action bar', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Review split\n\nSelect this sentence for AC-07.17.\n', mode: 'review', sessionName: uniq('Review split') })
      await page.goto(`${BASE}/d/${doc.id}?view=split`)
      await waitSplit(page, 'Select this sentence for AC-07.17.')
      const p = page.locator(`${PV} p`).filter({ hasText: 'Select this sentence' }).first()
      await p.click({ clickCount: 3 })
      await page.locator('.selection-action-bar .action-btn').first().waitFor({ state: 'visible', timeout: 5000 })
    } finally { await context.close() }
  })
})
