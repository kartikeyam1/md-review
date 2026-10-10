// #14 Copy button + language label on code blocks — acceptance tests
// (docs/build/specs/14-code-copy.md AC-14.1 – AC-14.13; 00-cross-cutting.md §2.5, §3.1, §4.4, §4.5, §10.1).
// Label extraction and wrapper markup are unit-tested in tests/items/14-code-copy.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDoc, putMarkdown, uniq } from '../lib/docs.mjs'
import { openCtx, openDoc, clipLog, colorsOf, contrast, THEMES, VIEWPORTS, tid, sleep, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/14')
const T = { timeout: 60_000 }
const SLOW = { timeout: 120_000 }

const MARK = 'Code copy fixture intro (AC-14).'
const LONG = 'x'.repeat(300)
const SRC = [
  '# Code copy', '', MARK, '',
  '```bash', 'echo "a <b> & c"', '\tindented', '```', '',
  '```typescript', 'const greet = (name: string): string => `hi ${name}`', 'export default greet', '```', '',
  '```ts', 'let a = 1', '```', '',
  '```Terraform', 'resource "x" "y" {}', '```', '',
  '```json {linenos}', '{ "a": 1 }', '```', '',
  '```', 'no info string', '```', '',
  '```mermaid', 'graph TD', '  A-->B', '```', '',
  'Indented block follows:', '',
  '    four space indented', '      six space line', '',
  '```text', LONG, '```', '',
  '```<img>', 'escaped label', '```', '',
  'End of fixture.',
].join('\n')

let browser
const docs = {}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.main = await createDoc({ markdown: SRC, filename: 'code.md', sessionName: uniq('Code copy'), mode: 'publish' })
  docs.review = await createDoc({ markdown: SRC, filename: 'code-review.md', sessionName: uniq('Code review'), mode: 'review' })
})
after(async () => { await browser?.close() })

const block = (page, n) => page.locator(`.preview-pane ${tid('code-block')}`).nth(n)
const copyBtn = (page, n) => block(page, n).locator(tid('code-copy-btn'))

async function ready(page, doc = docs.main, opts = {}) {
  await openDoc(page, doc, MARK)
  await page.locator(`.preview-pane ${tid('code-copy-btn')}`).first().waitFor({ state: 'attached', timeout: 8000 })
  if (opts.hover !== false) await block(page, 0).hover()
}

describe('#14 code copy', () => {
  it('AC-14.1 copies the exact fenced content (no trailing newline, tabs and <&> kept)', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page)
      await copyBtn(page, 0).click()
      await eventually(async () => assert.deepEqual(await clipLog(page), ['echo "a <b> & c"\n\tindented']))
    } finally { await context.close() }
  })

  it('AC-14.1 (real clipboard) the system clipboard receives the same text', T, async () => {
    const { context, page } = await openCtx(browser, { permissions: ['clipboard-read', 'clipboard-write'] })
    try {
      await ready(page)
      await copyBtn(page, 0).click()
      await eventually(async () => assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'echo "a <b> & c"\n\tindented'))
    } finally { await context.close() }
  })

  it('AC-14.2 highlighted code copies without markup, label or "Copy"', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page)
      assert.ok(await block(page, 1).locator('pre code span').count() > 0, 'typescript block is highlighted')
      await block(page, 1).hover()
      await copyBtn(page, 1).click()
      const [text] = await eventually(async () => { const l = await clipLog(page); assert.equal(l.length, 1); return l })
      assert.equal(text, 'const greet = (name: string): string => `hi ${name}`\nexport default greet')
      for (const bad of ['<span', 'hljs', 'Copy', 'typescript']) assert.ok(!text.includes(bad), `no ${bad}`)
    } finally { await context.close() }
  })

  it('AC-14.3 language labels: ts, terraform, json, none for a bare fence; label text escaped', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const label = (n) => block(page, n).locator(tid('code-lang-label'))
      assert.equal((await label(2).textContent()).trim(), 'ts')
      assert.equal((await label(3).textContent()).trim(), 'terraform')
      assert.equal((await label(4).textContent()).trim(), 'json')
      assert.equal(await label(5).count(), 0, 'no label without an info string')
      assert.equal(await copyBtn(page, 5).count(), 1, 'bare fence still has a copy button')
      // block 6 = indented, 7 = text/LONG, 8 = <img>
      assert.equal((await label(8).textContent()).trim(), '<img>')
      assert.equal(await page.locator('.preview-pane img').count(), 0, 'no <img> element from the info string')
      // toolbar order: label then button
      const order = await block(page, 2).locator(tid('code-toolbar')).evaluate((tb) =>
        [...tb.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid))
      assert.deepEqual(order.filter((t) => t === 'code-lang-label' || t === 'code-copy-btn'), ['code-lang-label', 'code-copy-btn'])
      // aria-label names the language
      assert.equal(await copyBtn(page, 2).getAttribute('aria-label'), 'Copy ts code')
      assert.equal(await copyBtn(page, 5).getAttribute('aria-label'), 'Copy code')
      assert.equal(await copyBtn(page, 2).evaluate((b) => b.tagName + ':' + b.type), 'BUTTON:button')
    } finally { await context.close() }
  })

  it('AC-14.4 "Copied" state + live region, then back to idle after ~2 s', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page)
      const btn = copyBtn(page, 0)
      assert.equal(await btn.getAttribute('data-state'), 'idle')
      assert.match((await btn.textContent()).trim(), /^Copy$/)
      const status = page.locator(`.preview-pane ${tid('code-copy-status')}, ${tid('code-copy-status')}`)
      assert.equal(await status.count(), 1, 'one live region')
      assert.equal(await status.getAttribute('aria-live'), 'polite')
      const t0 = Date.now()
      await btn.click()
      await page.waitForFunction((el) => el.dataset.state === 'copied', await btn.elementHandle(), { timeout: 1000 })
      assert.ok(Date.now() - t0 < 1000)
      assert.match((await btn.textContent()).trim(), /^Copied$/)
      await eventually(async () => assert.equal((await status.textContent()).trim(), 'Copied to clipboard'), { timeout: 1000 })
      await page.waitForFunction((el) => el.dataset.state === 'idle', await btn.elementHandle(), { timeout: 4000 })
      const dt = Date.now() - t0
      assert.ok(dt >= 1700 && dt <= 2800, `reverted after ${dt} ms`)
      assert.match((await btn.textContent()).trim(), /^Copy$/)
    } finally { await context.close() }
  })

  it('AC-14.4 a second click during "Copied" re-copies and restarts the timer', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page)
      const btn = copyBtn(page, 0)
      await btn.click()
      await sleep(1200)
      const t1 = Date.now()
      await btn.click()
      await eventually(async () => assert.equal((await clipLog(page)).length, 2))
      await sleep(1100) // 2.3 s after the first click: still copied
      assert.equal(await btn.getAttribute('data-state'), 'copied')
      await page.waitForFunction((el) => el.dataset.state === 'idle', await btn.elementHandle(), { timeout: 4000 })
      const dt = Date.now() - t1
      assert.ok(dt >= 1700 && dt <= 2800, `restarted timer: ${dt} ms`)
    } finally { await context.close() }
  })

  it('AC-14.5 both copy paths failing shows "Copy failed"', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'deny' })
    try {
      await ready(page)
      const btn = copyBtn(page, 0)
      await btn.click()
      await page.waitForFunction((el) => el.dataset.state === 'failed', await btn.elementHandle(), { timeout: 2000 })
      assert.match((await btn.textContent()).trim(), /^Copy failed$/)
      assert.equal(await page.locator(tid('app-toast')).count(), 0, 'not a toast (00 §3.1)')
      await page.waitForFunction((el) => el.dataset.state === 'idle', await btn.elementHandle(), { timeout: 4000 })
    } finally { await context.close() }
  })

  it('AC-14.6 keyboard: Tab to the button, Enter and Space copy, focus stays', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page, docs.main, { hover: false })
      await page.mouse.move(1, 1)
      // Tab from the body until the first copy button is focused.
      await page.locator('body').focus()
      let reached = false
      for (let i = 0; i < 60 && !reached; i++) {
        await page.keyboard.press('Tab')
        reached = await page.evaluate(() => document.activeElement?.dataset?.testid === 'code-copy-btn')
      }
      assert.ok(reached, 'a copy button is in the tab order')
      const visible = await page.evaluate(() => {
        const b = document.activeElement
        return { op: getComputedStyle(b).opacity, outline: getComputedStyle(b).outlineStyle, shadow: getComputedStyle(b).boxShadow }
      })
      assert.equal(Number(visible.op), 1, 'focused copy button is visible')
      assert.ok(visible.outline !== 'none' || visible.shadow !== 'none', 'visible focus ring')
      await page.keyboard.press('Enter')
      await eventually(async () => assert.equal((await clipLog(page)).length, 1))
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'code-copy-btn')
      await page.keyboard.press('Space')
      await eventually(async () => assert.equal((await clipLog(page)).length, 2))
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'code-copy-btn')
      assert.equal((await clipLog(page))[1], 'echo "a <b> & c"\n\tindented')
    } finally { await context.close() }
  })

  it('AC-14.6 focus stays on the button when the execCommand fallback runs', T, async () => {
    const { context, page } = await openCtx(browser, {
      init: () => {
        window.__clip = []
        try { navigator.clipboard.writeText = () => Promise.reject(new Error('nope')) } catch { /* */ }
        const orig = document.execCommand.bind(document)
        document.execCommand = (cmd, ...a) => { if (cmd === 'copy') { window.__clip.push(document.activeElement?.value ?? ''); return true } return orig(cmd, ...a) }
      },
    })
    try {
      await ready(page)
      await copyBtn(page, 0).focus()
      await page.keyboard.press('Enter')
      await eventually(async () => assert.deepEqual(await clipLog(page), ['echo "a <b> & c"\n\tindented']))
      assert.equal(await copyBtn(page, 0).getAttribute('data-state'), 'copied')
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'code-copy-btn')
    } finally { await context.close() }
  })

  it('AC-14.7 desktop: hidden until hover/focus, label always visible; hit area >= 32px', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.main, { hover: false })
      await page.mouse.move(1, 1)
      await sleep(300)
      const op = (n) => copyBtn(page, n).evaluate((b) => Number(getComputedStyle(b).opacity))
      assert.equal(await op(2), 0, 'idle copy button hidden by opacity')
      assert.equal(await block(page, 2).locator(tid('code-lang-label')).evaluate((l) => Number(getComputedStyle(l).opacity)), 1)
      await block(page, 2).hover()
      await eventually(async () => assert.equal(await op(2), 1))
      const box = await copyBtn(page, 2).boundingBox()
      assert.ok(box.width >= 32 && box.height >= 32, `hit area ${box.width}x${box.height}`)
      assert.equal(await copyBtn(page, 2).getAttribute('tabindex'), null, 'stays in tab order (no tabindex=-1)')
    } finally { await context.close() }
  })

  it('AC-14.7 phone (hover: none): always visible, 44px hit area', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await ready(page, docs.main, { hover: false })
      assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true)
      const o = await copyBtn(page, 2).evaluate((b) => Number(getComputedStyle(b).opacity))
      assert.equal(o, 1)
      const box = await copyBtn(page, 2).boundingBox()
      assert.ok(box.width >= 44 && box.height >= 44, `hit area ${box.width}x${box.height}`)
      await page.screenshot({ path: join(SCREENS, 'phone.png'), fullPage: false })
    } finally { await context.close() }
  })

  it('AC-14.8 pre keeps data-line-*, wrapper has none; triple-click selects code without "Copy" (review mode)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.review)
      const attrs = await block(page, 0).evaluate((w) => ({
        wrapper: [...w.attributes].map((a) => a.name).filter((n) => n.startsWith('data-line')),
        pre: w.querySelector('pre')?.getAttribute('data-line-start'),
        preInToolbar: !!w.querySelector('[data-testid="code-toolbar"] pre'),
        userSelect: getComputedStyle(w.querySelector('[data-testid="code-toolbar"]')).userSelect,
      }))
      assert.deepEqual(attrs.wrapper, [])
      assert.notEqual(attrs.pre, null)
      assert.equal(attrs.preInToolbar, false)
      assert.equal(attrs.userSelect, 'none')
      await block(page, 0).locator('pre code').click({ clickCount: 3 })
      const sel = await page.evaluate(() => window.getSelection().toString())
      assert.ok(sel.includes('echo'), 'selection has the code')
      assert.ok(!/Copy|bash/.test(sel.replace('echo', '')), `no toolbar text in selection: ${JSON.stringify(sel)}`)
      await page.locator('.selection-action-bar, .popover').first().waitFor({ state: 'visible', timeout: 4000 })
    } finally { await context.close() }
  })

  it('rule 9: clicking copy opens no selection bar and keeps an existing comment highlight', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page, docs.review)
      // A highlighted block stays highlighted across a copy click.
      await page.evaluate(() => document.querySelector('.preview-pane pre')?.classList.add('comment-highlight'))
      await block(page, 0).hover()
      await copyBtn(page, 0).click()
      await eventually(async () => assert.equal((await clipLog(page)).length, 1))
      assert.equal(await page.evaluate(() => window.getSelection().isCollapsed), true)
      assert.equal(await page.locator('.selection-action-bar:visible').count(), 0)
      assert.equal(await page.evaluate(() => document.querySelector('.preview-pane pre')?.classList.contains('comment-highlight')), true)
    } finally { await context.close() }
  })

  it('rule 9 (review fix): a drag-selection from the code ending over the toolbar still raises the comment bar', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.review)
      const code = await block(page, 0).locator('pre code').boundingBox()
      const tb = await block(page, 0).locator(tid('code-toolbar')).boundingBox()
      await page.mouse.move(code.x + 60, code.y + code.height - 4)
      await page.mouse.down()
      await page.mouse.move(tb.x + 20, tb.y + tb.height / 2, { steps: 8 })
      await page.mouse.up()
      assert.ok((await page.evaluate(() => window.getSelection().toString())).length > 0, 'text selected')
      await page.locator('.selection-action-bar').waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-14.9 label and button text >= 4.5:1 against the toolbar in all six themes', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        await block(page, 0).hover()
        await sleep(250)
        for (const id of ['code-lang-label', 'code-copy-btn']) {
          const c = await colorsOf(page, `.preview-pane ${tid('code-block')} ${tid(id)}`)
          assert.ok(c, `${theme}: ${id} exists`)
          const ratio = contrast(c.fg, c.bg)
          assert.ok(ratio >= 4.5, `${theme}: ${id} contrast ${ratio.toFixed(2)} (fg ${c.fg.map(Math.round)}, bg ${c.bg.map(Math.round)})`)
        }
        await page.screenshot({ path: join(SCREENS, `theme-${theme}.png`), clip: await block(page, 0).boundingBox() })
      } finally { await context.close() }
    }
  })

  it('AC-14.10 print: no toolbar, a 300-char line wraps inside the page', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await page.emulateMedia({ media: 'print' })
      const shown = await page.locator(`.preview-pane ${tid('code-toolbar')}`).evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)
      assert.equal(shown, 0)
      const fit = await block(page, 7).locator('pre').evaluate((pre) => ({ sw: pre.scrollWidth, cw: pre.clientWidth, ws: getComputedStyle(pre).whiteSpace, h: pre.getBoundingClientRect().height }))
      assert.ok(fit.sw <= fit.cw + 1, `print pre does not overflow (${fit.sw} > ${fit.cw})`)
      assert.ok(fit.h > 40, 'long line wrapped onto several lines')
      const pdf = await page.pdf({ format: 'A4' })
      assert.ok(pdf.length > 1000)
    } finally { await context.close() }
  })

  it('AC-14.11 mermaid blocks get no copy button', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await page.locator('.preview-pane .mermaid').first().waitFor({ state: 'attached' })
      assert.equal(await page.locator(`.preview-pane .mermaid ${tid('code-copy-btn')}`).count(), 0)
      assert.equal(await page.locator('.preview-pane .mermaid').evaluate((m) => !!m.closest('[data-testid="code-block"]')), false)
      // 10 blocks: 9 fences without mermaid... bash, ts-long, ts, Terraform, json, bare, indented, text, <img> = 9
      assert.equal(await page.locator(`.preview-pane ${tid('code-copy-btn')}`).count(), 9)
    } finally { await context.close() }
  })

  it('AC-14.12 indented block copies without the stripped 4-space indent', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page)
      assert.equal(await block(page, 6).locator(tid('code-lang-label')).count(), 0)
      await block(page, 6).hover()
      await copyBtn(page, 6).click()
      await eventually(async () => assert.deepEqual(await clipLog(page), ['four space indented\n  six space line']))
    } finally { await context.close() }
  })

  it('rule 12: toolbar does not overlap the first code line; long lines scroll inside <pre>', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const g = await block(page, 7).evaluate((w) => {
        const tb = w.querySelector('[data-testid="code-toolbar"]').getBoundingClientRect()
        const pre = w.querySelector('pre')
        const code = pre.querySelector('code')
        const r = document.createRange()
        r.selectNodeContents(code)
        const first = r.getClientRects()[0]
        return { tbBottom: tb.bottom, tbLeft: tb.left, codeTop: first.top, sw: pre.scrollWidth, cw: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX }
      })
      assert.ok(g.tbBottom <= g.codeTop + 0.5, `toolbar bottom ${g.tbBottom} <= first line top ${g.codeTop}`)
      assert.ok(g.sw > g.cw, 'long line overflows the pre')
      assert.ok(['auto', 'scroll'].includes(g.overflowX))
      const tbBefore = await block(page, 7).locator(tid('code-toolbar')).boundingBox()
      await block(page, 7).locator('pre').evaluate((pre) => { pre.scrollLeft = 400 })
      const tbAfter = await block(page, 7).locator(tid('code-toolbar')).boundingBox()
      assert.equal(Math.round(tbAfter.x), Math.round(tbBefore.x), 'toolbar does not scroll with the code')
    } finally { await context.close() }
  })

  it('AC-14.13 re-rendered blocks have working buttons; old references are harmless', SLOW, async () => {
    const doc = await createDoc({ markdown: `# Live\n\n${MARK}\n\n\`\`\`sh\nfirst\n\`\`\`\n`, filename: 'live.md', sessionName: uniq('Live'), mode: 'publish' })
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page, doc)
      const old = await copyBtn(page, 0).elementHandle()
      await putMarkdown(doc.id, `# Live\n\n${MARK}\n\n\`\`\`sh\nfirst\n\`\`\`\n\n\`\`\`py\nsecond block\n\`\`\`\n`)
      await page.locator(`.preview-pane ${tid('code-block')}`).nth(1).waitFor({ state: 'attached', timeout: 20000 })
      await block(page, 1).hover()
      await copyBtn(page, 1).click()
      await eventually(async () => assert.deepEqual(await clipLog(page), ['second block']))
      // The detached old button: clicking it must not throw or copy.
      await old.evaluate((b) => b.click())
      await sleep(200)
      assert.equal((await clipLog(page)).length <= 2, true)
      assert.deepEqual(page.__errors, [])
    } finally { await context.close() }
  })
})
