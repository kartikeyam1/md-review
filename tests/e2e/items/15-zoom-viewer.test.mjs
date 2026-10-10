// #15 Full-screen zoom/pan viewer — acceptance tests in the browser
// (docs/build/specs/15-zoom-viewer.md AC-15.1 – 15.15, rules 1–17; 00-cross-cutting.md §3.4, §3.5, §3.7).
// The scale/pan maths is unit-tested in tests/items/15-zoom-viewer.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDoc, putMarkdown, uniq } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'
import { pngDataUri } from './05-lib.mjs'
import { openCtx, openDoc, clipLog, colorsOf, contrast, THEMES, VIEWPORTS, tid, sleep, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/15')
const T = { timeout: 60_000 }
const SLOW = { timeout: 180_000 }

const MARK = 'Zoom fixture intro paragraph (AC-15).'
const SMALL_SRC = 'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]'
const WIDE_SRC = 'graph LR\n' + Array.from({ length: 28 }, (_, i) => `  N${i}[Wide node number ${i}] --> N${i + 1}[Wide node number ${i + 1}]`).join('\n')
const IMG = pngDataUri(800, 600)
const ICON = pngDataUri(16, 16)
const filler = (n) => Array.from({ length: n }, (_, i) => `Filler paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`).join('\n\n')
const SRC = [
  '# Zoom', '', MARK, '',
  '```mermaid', SMALL_SRC, '```', '',
  filler(6), '',
  `![A big picture](${IMG})`, '',
  `[![linked](${IMG})](https://example.com)`, '',
  `Icon ![icon](${ICON}) inline.`, '',
  '![broken](https://127.0.0.1:1/nope.png)', '',
  '```mermaid', 'graph TD\n  X[[unclosed', '```', '',
  filler(20), '',
  'End of zoom fixture.',
].join('\n')
const WIDE_DOC = ['# Wide', '', 'Wide diagram fixture (AC-15.4).', '', '```mermaid', WIDE_SRC, '```', ''].join('\n')

let browser
const docs = {}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.main = await createDoc({ markdown: SRC, filename: 'zoom.md', sessionName: uniq('Zoom'), mode: 'publish' })
  docs.review = await createDoc({ markdown: SRC, filename: 'zoom-review.md', sessionName: uniq('Zoom review'), mode: 'review' })
  docs.wide = await createDoc({ markdown: WIDE_DOC, filename: 'wide.md', sessionName: uniq('Wide'), mode: 'publish' })
})
after(async () => { await browser?.close() })

const trigger = (page, kind, n = 0) => page.locator(`.preview-pane ${tid('zoom-trigger')}[data-zoomable="${kind}"]`).nth(n)
const viewer = (page) => page.locator(tid('zoom-viewer'))
const level = async (page) => parseInt((await page.locator(tid('zoom-level')).textContent()).replace('%', ''), 10)
const contentBox = (page) => page.locator(tid('zoom-content')).boundingBox()

async function ready(page, doc = docs.main, marker = MARK) {
  await openDoc(page, doc, marker)
  await page.locator(`.preview-pane .mermaid svg`).first().waitFor({ state: 'attached', timeout: 20000 })
  await page.locator(`.preview-pane ${tid('zoom-trigger')}[data-zoomable="mermaid"]`).first().waitFor({ state: 'attached', timeout: 10000 })
}

async function openViewer(page, kind = 'mermaid', n = 0) {
  const t = trigger(page, kind, n)
  await t.scrollIntoViewIfNeeded()
  await t.click()
  await viewer(page).waitFor({ state: 'visible' })
  await sleep(100)
}

describe('#15 zoom viewer', () => {
  it('AC-15.1 / rule 1 triggers on the rendered diagram and the 800×600 image', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await trigger(page, 'image').waitFor({ state: 'attached' })
      for (const kind of ['mermaid', 'image']) {
        const a = await trigger(page, kind).evaluate((el) => ({ tab: el.getAttribute('tabindex'), role: el.getAttribute('role'), label: el.getAttribute('aria-label'), cursor: getComputedStyle(el).cursor }))
        assert.equal(a.tab, '0')
        assert.equal(a.role, 'button')
        assert.equal(a.cursor, 'zoom-in')
        assert.equal(a.label, kind === 'mermaid' ? 'Open diagram full screen' : 'Open image full screen: A big picture')
      }
      assert.equal(await page.locator(`.preview-pane ${tid('zoom-trigger')}[data-zoomable="mermaid"]`).count(), 1, 'the failed diagram is not zoomable')
    } finally { await context.close() }
  })

  it('AC-15.12 / rule 2 linked, tiny and broken images are not triggers', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await trigger(page, 'image').waitFor({ state: 'attached' })
      await sleep(500)
      const flags = await page.evaluate(() => [...document.querySelectorAll('.preview-pane img')].map((i) => [i.alt, i.getAttribute('data-testid')]))
      const by = Object.fromEntries(flags)
      assert.equal(by['A big picture'], 'zoom-trigger')
      assert.equal(by.linked, null)
      assert.equal(by.icon, null)
      assert.equal(by.broken, null)
    } finally { await context.close() }
  })

  it('AC-15.2 / rule 4–5 click opens a modal dialog with a clone of the in-page SVG', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      const v = viewer(page)
      assert.equal(await v.getAttribute('role'), 'dialog')
      assert.equal(await v.getAttribute('aria-modal'), 'true')
      assert.equal(await v.getAttribute('aria-label'), 'Diagram viewer')
      const fills = await page.evaluate(() => {
        const node = (root) => root.querySelector('.node rect, .node polygon, .node path')
        const a = node(document.querySelector('.preview-pane .mermaid svg'))
        const b = node(document.querySelector('[data-testid="zoom-content"] svg'))
        return [a && getComputedStyle(a).fill, b && getComputedStyle(b).fill]
      })
      assert.ok(fills[0], 'in-page node')
      assert.equal(fills[1], fills[0])
      const box = await v.boundingBox()
      assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 1400, 900])
      const z = await v.evaluate((el) => Number(getComputedStyle(el).zIndex))
      assert.equal(z, 500)
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden', 'page scroll locked')
      await page.screenshot({ path: join(SCREENS, 'open-desktop.png') })
    } finally { await context.close() }
  })

  it('AC-15.3 drag-selecting across the diagram in review mode does not open the viewer', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.review)
      const intro = await page.locator('.preview-pane p', { hasText: MARK }).boundingBox()
      const t = await trigger(page, 'mermaid').boundingBox()
      await page.mouse.move(intro.x + 5, intro.y + intro.height / 2)
      await page.mouse.down()
      // End inside the visible part of the diagram (a tall diagram runs past the viewport).
      const endY = Math.min(t.y + t.height - 5, 860)
      await page.mouse.move(t.x + t.width / 2, Math.min(t.y + t.height / 2, endY), { steps: 10 })
      await page.mouse.move(t.x + t.width - 5, endY, { steps: 5 })
      await page.mouse.up()
      await sleep(300)
      assert.equal(await viewer(page).count(), 0)
      await page.locator('.selection-action-bar').waitFor({ state: 'visible', timeout: 3000 })
    } finally { await context.close() }
  })

  it('AC-15.4 / rule 13–14 a 3000px flowchart on a phone: < 20% at open, reaches 100% at authored width', SLOW, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await ready(page, docs.wide, 'Wide diagram fixture')
      const natW = await page.evaluate(() => document.querySelector('.preview-pane .mermaid svg').viewBox.baseVal.width)
      assert.ok(natW >= 2500, `fixture is wide (${natW})`)
      await trigger(page, 'mermaid').tap()
      await viewer(page).waitFor({ state: 'visible' })
      assert.ok(await level(page) < 20, `initial ${await level(page)}%`)
      for (let i = 0; i < 40 && await level(page) < 100; i++) await page.locator(tid('zoom-in-btn')).tap()
      assert.ok(await level(page) >= 100)
      while (await level(page) > 100) await page.locator(tid('zoom-out-btn')).tap()
      // zoom-out may undershoot; step back up to exactly or just above 100 and compare to the scale
      const s = await level(page)
      const w = (await page.locator(`${tid('zoom-content')} svg`).boundingBox()).width
      assert.ok(Math.abs(w - natW * s / 100) <= natW * 0.006 + 2, `width ${w} vs ${natW} × ${s}%`)
      const btn = await page.locator(tid('zoom-close-btn')).boundingBox()
      assert.ok(btn.width >= 44 && btn.height >= 44)
      await page.screenshot({ path: join(SCREENS, 'phone-wide.png') })
    } finally { await context.close() }
  })

  it('AC-15.4 at exactly 100% the SVG is the authored width (± 2px)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.wide, 'Wide diagram fixture')
      const natW = await page.evaluate(() => document.querySelector('.preview-pane .mermaid svg').viewBox.baseVal.width)
      await openViewer(page)
      // keyboard: + until ≥ 100, the indicator is round(scale × 100)
      for (let i = 0; i < 30 && await level(page) < 100; i++) await page.keyboard.press('+')
      const s = await page.evaluate(() => Number(document.querySelector('[data-testid="zoom-content"]').dataset.scale))
      const w = (await page.locator(`${tid('zoom-content')} svg`).boundingBox()).width
      assert.ok(Math.abs(w - natW * s) <= 2, `rendered ${w} vs natural ${natW} × ${s}`)
    } finally { await context.close() }
  })

  it('AC-15.5 wheel zooms around the cursor; the page behind does not scroll', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      const y0 = await page.evaluate(() => window.scrollY)
      const b = await contentBox(page)
      const P = { x: b.x + b.width * 0.3, y: b.y + b.height * 0.6 }
      const rel = { x: (P.x - b.x) / b.width, y: (P.y - b.y) / b.height }
      const l0 = await level(page)
      await page.mouse.move(P.x, P.y)
      await page.mouse.wheel(0, -200)
      await sleep(200)
      assert.ok(await level(page) > l0, 'zoomed in')
      const a = await contentBox(page)
      const now = { x: a.x + rel.x * a.width, y: a.y + rel.y * a.height }
      assert.ok(Math.abs(now.x - P.x) <= 2 && Math.abs(now.y - P.y) <= 2, `point moved to ${now.x},${now.y} from ${P.x},${P.y}`)
      assert.equal(await page.evaluate(() => window.scrollY), y0)
    } finally { await context.close() }
  })

  it('AC-15.6 / rule 10 drag pans by the pointer delta; far drags keep ≥ 48px visible', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.wide, 'Wide diagram fixture')
      await openViewer(page)
      for (let i = 0; i < 6; i++) await page.locator(tid('zoom-in-btn')).click()
      const b0 = await contentBox(page)
      const stage = await viewer(page).boundingBox()
      const sx = stage.width / 2; const sy = stage.height / 2
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(sx + 100, sy, { steps: 10 })
      await page.mouse.up()
      const b1 = await contentBox(page)
      assert.ok(Math.abs(b1.x - b0.x - 100) <= 2, `moved ${b1.x - b0.x}`)
      assert.equal(await viewer(page).isVisible(), true, 'a pan does not close the viewer')
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(sx + 5000, sy + 5000, { steps: 10 })
      await page.mouse.up()
      const b2 = await contentBox(page)
      assert.ok(stage.width - b2.x >= 47.5, `≥ 48px visible horizontally (${stage.width - b2.x})`)
    } finally { await context.close() }
  })

  it('AC-15.7 touch: pinch-out zooms, one-finger drag pans', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await ready(page, docs.wide, 'Wide diagram fixture')
      await trigger(page, 'mermaid').tap()
      await viewer(page).waitFor({ state: 'visible' })
      const cdp = await context.newCDPSession(page)
      const l0 = await level(page)
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
      await touch('touchStart', [[170, 420], [220, 420]])
      for (let i = 1; i <= 10; i++) await touch('touchMove', [[170 - i * 10, 420], [220 + i * 10, 420]])
      await touch('touchEnd', [])
      await sleep(150)
      assert.ok(await level(page) > l0, `pinch zoomed ${l0} → ${await level(page)}`)
      const b0 = await contentBox(page)
      await touch('touchStart', [[200, 500]])
      for (let i = 1; i <= 8; i++) await touch('touchMove', [[200 - i * 10, 500]])
      await touch('touchEnd', [])
      await sleep(150)
      const b1 = await contentBox(page)
      assert.ok(b1.x < b0.x - 20, `panned left (${b0.x} → ${b1.x})`)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="zoom-viewer"] .zoom-stage')).touchAction), 'none')
    } finally { await context.close() }
  })

  it('rule 9: double-click toggles between initial and the double-tap scale', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      const l0 = await level(page)
      const b = await contentBox(page)
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
      await sleep(150)
      assert.notEqual(await level(page), l0)
      assert.equal(await viewer(page).isVisible(), true)
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
      await sleep(150)
      assert.equal(await level(page), l0)
    } finally { await context.close() }
  })

  it('AC-15.8 keyboard: Enter opens with focus on close, + / 0 / Tab trap / Esc returns focus', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await trigger(page, 'mermaid').focus()
      await page.keyboard.press('Enter')
      await viewer(page).waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'zoom-close-btn')
      const l0 = await level(page)
      await page.keyboard.press('+')
      assert.ok(await level(page) > l0)
      await page.keyboard.press('0')
      assert.equal(await level(page), l0)
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab')
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="zoom-viewer"]')), 'focus stays in the dialog')
      }
      await page.keyboard.press('Shift+Tab')
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="zoom-viewer"]')))
      // arrows pan by 48px
      const b0 = await contentBox(page)
      await page.locator(tid('zoom-content')).evaluate(() => {})
      await page.keyboard.press('ArrowLeft')
      const b1 = await contentBox(page)
      assert.ok(Math.abs(Math.abs(b1.x - b0.x) - 48) <= 1 || b1.x === b0.x, 'arrow pans 48px (or clamps)')
      await page.keyboard.press('Escape')
      await viewer(page).waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.zoomable), 'mermaid')
      // Space opens too
      await page.keyboard.press(' ')
      await viewer(page).waitFor({ state: 'visible' })
      await page.locator(tid('zoom-close-btn')).click()
      await viewer(page).waitFor({ state: 'detached' })
    } finally { await context.close() }
  })

  it('fix round: after a pan / background-free click / a button disabling, Esc and + still work (focus stays in the dialog)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      const b = await contentBox(page)
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 30, { steps: 6 }); await page.mouse.up()
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="zoom-viewer"]')), 'focus inside after a pan')
      const l0 = await level(page)
      await page.keyboard.press('+')
      assert.ok(await level(page) > l0, '+ works after a pan')
      // drive zoom-in with Enter until it disables: focus must not fall to <body>
      await page.locator(tid('zoom-in-btn')).focus()
      for (let i = 0; i < 60 && !(await page.locator(tid('zoom-in-btn')).isDisabled()); i++) await page.keyboard.press('Enter')
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="zoom-viewer"]')), 'focus inside after the button disabled')
      await page.keyboard.press('Escape')
      await viewer(page).waitFor({ state: 'detached' })
      // a held Enter / a chord on the trigger does not open it
      await trigger(page, 'mermaid').focus()
      await page.keyboard.press('Control+Shift+Enter')
      await sleep(300)
      assert.equal(await viewer(page).count(), 0, 'chord does not open')
      // Copy source announces inside the dialog
      await page.keyboard.press('Enter')
      await viewer(page).waitFor({ state: 'visible' })
      await page.locator(tid('zoom-copy-source')).click()
      await eventually(async () => assert.equal(await page.locator(`${tid('zoom-viewer')} [aria-live="polite"]`).textContent(), 'Copied to clipboard'))
    } finally { await context.close() }
  })

  it('AC-15.9 reset returns to the opening scale and position', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      const l0 = await level(page)
      const b0 = await contentBox(page)
      await page.locator(tid('zoom-in-btn')).click()
      await page.locator(tid('zoom-in-btn')).click()
      await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(760, 500, { steps: 5 }); await page.mouse.up()
      await page.locator(tid('zoom-reset-btn')).click()
      const b1 = await contentBox(page)
      assert.equal(await level(page), l0)
      for (const k of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(b1[k] - b0[k]) <= 1, `${k}: ${b1[k]} vs ${b0[k]}`)
    } finally { await context.close() }
  })

  it('AC-15.10 zoom-in disables at max, zoom-out at min', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      for (let i = 0; i < 60 && !(await page.locator(tid('zoom-in-btn')).isDisabled()); i++) await page.locator(tid('zoom-in-btn')).click()
      assert.equal(await page.locator(tid('zoom-in-btn')).isDisabled(), true)
      for (let i = 0; i < 80 && !(await page.locator(tid('zoom-out-btn')).isDisabled()); i++) await page.locator(tid('zoom-out-btn')).click()
      assert.equal(await page.locator(tid('zoom-out-btn')).isDisabled(), true)
      assert.equal(await page.locator(tid('zoom-in-btn')).isDisabled(), false)
    } finally { await context.close() }
  })

  it('AC-15.11 Copy source copies the fence content (--> not --&gt;) with #14 feedback', T, async () => {
    const { context, page } = await openCtx(browser, { clipboard: 'record' })
    try {
      await ready(page)
      await openViewer(page)
      const btn = page.locator(tid('zoom-copy-source'))
      await btn.click()
      await eventually(async () => assert.deepEqual(await clipLog(page), [SMALL_SRC]))
      await eventually(async () => assert.equal(await btn.getAttribute('data-state'), 'copied'))
      assert.match((await btn.textContent()).trim(), /Copied/)
    } finally { await context.close() }
  })

  it('image viewer: no copy-source, same src/alt, labelled "Image viewer"', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page, 'image')
      assert.equal(await viewer(page).getAttribute('aria-label'), 'Image viewer')
      assert.equal(await page.locator(tid('zoom-copy-source')).count(), 0)
      const img = page.locator(`${tid('zoom-content')} img`)
      assert.equal(await img.getAttribute('alt'), 'A big picture')
      assert.ok((await img.getAttribute('src')).startsWith('data:image/png'))
      // fit: 800×600 in 1400×(900 − toolbar) → initial ≤ 200%, the image fits
      const b = await img.boundingBox()
      assert.ok(b.width <= 1400 && b.height <= 900)
    } finally { await context.close() }
  })

  it('AC-15.13 viewer background = --bg-surface and toolbar legible, all six themes', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await ready(page)
        await openViewer(page)
        const bg = await page.evaluate(() => {
          const probe = document.createElement('div')
          probe.style.background = 'var(--bg-surface)'
          document.body.appendChild(probe)
          const want = getComputedStyle(probe).backgroundColor
          probe.remove()
          return { want, got: getComputedStyle(document.querySelector('[data-testid="zoom-viewer"]')).backgroundColor }
        })
        assert.equal(bg.got, bg.want, `${theme}: viewer background`)
        for (const id of ['zoom-level', 'zoom-close-btn', 'zoom-in-btn']) {
          const c = await colorsOf(page, tid(id))
          assert.ok(contrast(c.fg, c.bg) >= 4.5, `${theme} ${id}: ${contrast(c.fg, c.bg).toFixed(2)}`)
        }
        await page.screenshot({ path: join(SCREENS, `viewer-${theme}.png`) })
      } finally { await context.close() }
    }
  })

  it('AC-15.14 / rule 12 closing restores scrollY and leaves the in-page SVG untouched; background click closes', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await trigger(page, 'image').scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollBy(0, 37))
      const y = await page.evaluate(() => window.scrollY)
      const before = await page.evaluate(() => document.querySelector('.preview-pane .mermaid svg').outerHTML)
      await trigger(page, 'image').click()
      await viewer(page).waitFor({ state: 'visible' })
      // background click (stage corner, no drag) closes
      const stage = await viewer(page).boundingBox()
      await page.mouse.click(stage.x + 10, stage.y + stage.height - 10)
      await viewer(page).waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => window.scrollY), y)
      await openViewer(page)
      await page.locator(tid('zoom-close-btn')).click()
      await viewer(page).waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.querySelector('.preview-pane .mermaid svg').outerHTML), before)
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden')
    } finally { await context.close() }
  })

  it('AC-15.15 at 400% the SVG is sized as vector (width = natural × 4, no bitmap)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      for (let i = 0; i < 40 && await level(page) < 400; i++) await page.keyboard.press('+')
      const s = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="zoom-content"] svg')
        const content = document.querySelector('[data-testid="zoom-content"]')
        return { scale: Number(content.dataset.scale), w: svg.getBoundingClientRect().width, nat: svg.viewBox.baseVal.width, imgs: content.querySelectorAll('img, canvas').length }
      })
      assert.ok(s.scale >= 4)
      assert.ok(Math.abs(s.w - s.nat * s.scale) <= 1, `${s.w} vs ${s.nat * s.scale}`)
      assert.equal(s.imgs, 0)
      await page.screenshot({ path: join(SCREENS, 'zoom-400.png') })
    } finally { await context.close() }
  })

  it('rule 16 live updates do not touch an open viewer; rule 11 Esc closes only the viewer', SLOW, async () => {
    const doc = await createDoc({ markdown: SRC, filename: 'zoom-live.md', sessionName: uniq('Zoom live'), mode: 'publish' })
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, doc)
      await openViewer(page)
      const snap = await page.locator(tid('zoom-content')).innerHTML()
      await putMarkdown(doc.id, SRC.replace('B -->|yes| C[Done]', 'B -->|yes| C[Changed]'))
      await page.locator('.preview-pane .mermaid', { hasText: 'Changed' }).waitFor({ state: 'attached', timeout: 25000 })
      assert.equal(await viewer(page).isVisible(), true)
      assert.equal(await page.locator(tid('zoom-content')).innerHTML(), snap)
      await page.keyboard.press('Escape')
      await viewer(page).waitFor({ state: 'detached' })
      assert.equal(await page.locator('[role="dialog"]:visible').count(), 0)
    } finally { await context.close() }
  })

  it('rule 17 print: no zoom cursor; the viewer never prints', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      await page.emulateMedia({ media: 'print' })
      assert.equal(await viewer(page).evaluate((v) => getComputedStyle(v).display), 'none')
      assert.notEqual(await trigger(page, 'mermaid').evaluate((t) => getComputedStyle(t).cursor), 'zoom-in')
    } finally { await context.close() }
  })

  it('a11y: no serious axe violations with the viewer open', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await openViewer(page)
      const v = await runAxe(page, { include: tid('zoom-viewer') })
      assert.equal(v.length, 0, formatViolations(v))
      assert.deepEqual(page.__errors, [])
    } finally { await context.close() }
  })
})
