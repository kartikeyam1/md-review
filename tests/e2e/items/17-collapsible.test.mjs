// #17 Collapsible sections — acceptance tests in the browser
// (docs/build/specs/17-collapsible.md AC-17.1 – 17.14, rules 1–15; 00-cross-cutting.md §2.5, §10.1, §10.3).
// Pure range/level/key logic is unit-tested in tests/items/17-collapsible.test.ts.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDoc, putMarkdown, uniq } from '../lib/docs.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'
import { openCtx, openDoc, docUrl, VIEWPORTS, THEMES, tid, sleep, eventually } from './14-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENS = join(resolve(HERE, '../../..'), '.verify/screens/17')
const T = { timeout: 60_000 }
const SLOW = { timeout: 150_000 }

const MARK = 'Fold fixture intro paragraph (AC-17).'
const filler = (tag, n = 3) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`).join('\n\n')
const DOC = (bExtra = '') => [
  '# T', '', MARK, '',
  '## A', '', 'A para one.', '', 'A para two.', '',
  '### A1', '', 'A1 para.', '', filler('A1 filler', 6), '',
  '## B', '', 'B para.', '', bExtra,
  '> ## Quoted heading', '>', '> quoted body', '',
  '- ## Listed heading', '', '  list body', '',
  filler('B filler', 10), '',
].join('\n')
const DETAILS_DOC = [
  '# Details doc', '', 'Details fixture intro (AC-17.9).', '',
  '## Lead', '', filler('Lead', 12), '',
  '<details><summary>More</summary>', '', 'markdown *body*', '', '### Hidden target', '', 'inside details', '', '</details>', '',
  '## Tail', '', 'tail para', '',
].join('\n')

let browser
const docs = {}

before(async () => {
  browser = await chromium.launch({ headless: true })
  mkdirSync(SCREENS, { recursive: true })
  docs.main = await createDoc({ markdown: DOC(), filename: 'fold.md', sessionName: uniq('Fold'), slug: uniq('fold'), mode: 'publish' })
  docs.details = await createDoc({ markdown: DETAILS_DOC, filename: 'details.md', sessionName: uniq('Details'), mode: 'publish' })
  docs.html = await createDoc({ markdown: '<!doctype html><html><body><h1>Html T</h1><p>x</p><h2>One</h2><p>y</p><h2>Two</h2><p>z</p></body></html>', filename: 'page.html', contentType: 'html', sessionName: uniq('Html'), mode: 'publish' })
  docs.dup = await createDoc({ markdown: '# Dup\n\nDup fixture intro (AC-17 dup).\n\n## Notes\n\nfirst notes body\n\n## Mid\n\nmid body\n\n## Notes\n\nsecond notes body\n\n```mermaid\ngraph TD\n  P-->Q\n```\n\n---\n\nafter rule\n', filename: 'dup.md', sessionName: uniq('Dup'), mode: 'publish' })
  docs.h5 = await createDoc({ markdown: 'H5 only fixture (AC-17 h5).\n\n##### One\n\nbody one\n\n##### Two\n\nbody two\n', filename: 'h5.md', sessionName: uniq('H5'), mode: 'publish' })
  docs.flat = await createDoc({ markdown: '# Only\n\nNo sections here (AC-17 flat).\n\n##### Five\n\nfive body\n', filename: 'flat.md', sessionName: uniq('Flat'), mode: 'publish' })
})
after(async () => { await browser?.close() })

const H = (page, id) => page.locator(`.preview-pane #${id}`)
const toggle = (page, id) => H(page, id).locator(tid('heading-fold-toggle'))
const para = (page, text) => page.locator('.preview-pane > p', { hasText: text })
const stored = (page, key) => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') } catch { return 'THROWS' } }, `md-review-fold:${key}`)

async function ready(page, doc = docs.main, rest = '', marker = MARK) {
  await openDoc(page, doc, marker, rest)
  await page.locator(`.preview-pane ${tid('heading-fold-toggle')}`).first().waitFor({ state: 'attached', timeout: 8000 })
}

async function isHidden(page, locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { attr: el.getAttribute('hidden'), zero: r.height === 0 }
  })
}

describe('#17 collapsible sections', () => {
  it('AC-17.1 toggles on T, A, A1, B only; none in quotes or lists; placed first in the heading', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const ids = await page.locator(`.preview-pane ${tid('heading-fold-toggle')}`).evaluateAll((els) => els.map((e) => e.closest('h1,h2,h3,h4').id))
      assert.deepEqual(ids, ['t', 'a', 'a1', 'b'])
      const s = await toggle(page, 'a').evaluate((b) => ({
        first: b.parentElement.firstElementChild === b, tag: b.tagName, type: b.type,
        expanded: b.getAttribute('aria-expanded'), name: b.getAttribute('aria-label') || b.textContent,
        controls: b.getAttribute('aria-controls'), us: getComputedStyle(b).userSelect,
      }))
      assert.equal(s.first, true)
      assert.equal(s.tag + s.type, 'BUTTONbutton')
      assert.equal(s.expanded, 'true')
      assert.equal(s.name, 'Fold section A')
      assert.equal(s.us, 'none')
      // heading ids / TOC text unaffected
      const toc = (await page.locator(tid('toc-link')).allTextContents()).map((t) => t.trim())
      assert.deepEqual(toc, ['A', 'A1', 'B', 'Quoted heading', 'Listed heading'])
    } finally { await context.close() }
  })

  it('AC-17.2 / AC-17.3 folding A hides its blocks (hidden=until-found), B stays; next block ≤ 48px below', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const textLeft = () => H(page, 'a').evaluate((h) => {
        const w = document.createTreeWalker(h, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('button,[data-testid]:not([data-testid="preview-pane"])') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
        const t = w.nextNode()
        const r = document.createRange(); r.selectNodeContents(t)
        return r.getBoundingClientRect().left
      })
      const hBox0 = await textLeft()
      await H(page, 'a').hover()
      await toggle(page, 'a').click()
      for (const loc of [para(page, 'A para one.'), para(page, 'A para two.'), H(page, 'a1'), para(page, 'A1 para.')]) {
        const s = await isHidden(page, loc)
        assert.equal(s.attr, 'until-found')
        assert.equal(s.zero, true)
      }
      assert.equal(await para(page, 'B para.').isVisible(), true)
      assert.equal(await H(page, 'b').isVisible(), true)
      assert.equal(await toggle(page, 'a').getAttribute('aria-expanded'), 'false')
      assert.equal(await toggle(page, 'a').getAttribute('aria-label'), 'Unfold section A')
      assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true')
      assert.equal(await H(page, 'a').locator(tid('heading-fold-ellipsis')).isVisible(), true)
      const gap = await page.evaluate(() => document.querySelector('.preview-pane #b').getBoundingClientRect().top - document.querySelector('.preview-pane #a').getBoundingClientRect().bottom)
      assert.ok(gap <= 48, `B top is ${gap}px below A`)
      // rule 6: heading text does not shift horizontally
      const hBox1 = await textLeft()
      assert.equal(hBox1, hBox0)
      // the ellipsis unfolds
      await H(page, 'a').locator(tid('heading-fold-ellipsis')).click()
      assert.equal(await para(page, 'A para one.').isVisible(), true)
      assert.equal(await H(page, 'a').locator(tid('heading-fold-ellipsis')).count(), 0)
      await page.screenshot({ path: join(SCREENS, 'desktop.png') })
    } finally { await context.close() }
  })

  it('rule 7: clicking the heading text does not fold', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await H(page, 'a').click({ position: { x: 60, y: 10 } })
      await sleep(150)
      assert.equal(await H(page, 'a').getAttribute('data-folded'), null)
      assert.equal(await para(page, 'A para one.').isVisible(), true)
    } finally { await context.close() }
  })

  it('AC-17.4 nested folds are independent', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a1').click({ force: true })
      await toggle(page, 'a').click({ force: true })
      await toggle(page, 'a').click({ force: true })
      assert.equal(await H(page, 'a1').isVisible(), true)
      assert.equal(await para(page, 'A1 para.').isVisible(), false)
      assert.equal(await H(page, 'a1').getAttribute('data-folded'), 'true')
      assert.equal(await para(page, 'A para one.').isVisible(), true)
    } finally { await context.close() }
  })

  it('AC-17.5 collapse all → outline; expand all → everything (desktop rail)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      const panel = page.locator(tid('toc-panel'))
      await panel.locator(tid('fold-collapse-all')).click()
      assert.equal(await H(page, 't').isVisible(), true)
      assert.equal(await para(page, MARK).isVisible(), true)
      assert.equal(await H(page, 'a').isVisible(), true)
      assert.equal(await H(page, 'b').isVisible(), true)
      assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true')
      assert.equal(await H(page, 'b').getAttribute('data-folded'), 'true')
      assert.equal(await H(page, 'a1').isVisible(), false)
      await panel.locator(tid('fold-expand-all')).click()
      for (const t of ['A para one.', 'A1 para.', 'B para.']) assert.equal(await para(page, t).isVisible(), true)
      assert.equal(await page.locator('.preview-pane [hidden]').count(), 0)
      assert.deepEqual(await stored(page, docs.main.id), [])
    } finally { await context.close() }
  })

  it('AC-17.5 / rule 8 collapse/expand all reachable at tablet and phone (drawer)', T, async () => {
    for (const vp of ['tablet', 'phone']) {
      const { context, page } = await openCtx(browser, { viewport: VIEWPORTS[vp], touch: true })
      try {
        await ready(page)
        await page.locator(tid('toc-toggle')).click()
        const drawer = page.locator(tid('toc-drawer'))
        await drawer.waitFor({ state: 'visible' })
        await drawer.locator(tid('fold-collapse-all')).click()
        await eventually(async () => assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true'))
        if (await drawer.isVisible()) {
          await drawer.locator(tid('fold-expand-all')).click()
        } else {
          await page.locator(tid('toc-toggle')).click()
          await page.locator(`${tid('toc-drawer')} ${tid('fold-expand-all')}`).click()
        }
        await eventually(async () => assert.equal(await H(page, 'a').getAttribute('data-folded'), null))
        await page.screenshot({ path: join(SCREENS, `drawer-${vp}.png`) })
      } finally { await context.close() }
    }
  })

  it('rule 8: no collapse/expand buttons without foldable headings / TOC, or for HTML docs', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.flat, 'No sections here')
      await sleep(300)
      assert.equal(await page.locator(tid('fold-collapse-all')).count(), 0)
      assert.equal(await page.locator(tid('fold-expand-all')).count(), 0)
    } finally { await context.close() }
  })

  it('AC-17.6 folds persist across reload, not into a fresh context', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      assert.deepEqual(await stored(page, docs.main.id), ['a'])
      await page.reload()
      await ready(page)
      await eventually(async () => assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true'))
      assert.equal(await para(page, 'A para one.').isVisible(), false)
    } finally { await context.close() }
    const fresh = await openCtx(browser)
    try {
      await ready(fresh.page)
      assert.equal(await H(fresh.page, 'a').getAttribute('data-folded'), null)
    } finally { await fresh.context.close() }
  })

  it('AC-17.7 a folded section stays folded when live content changes', SLOW, async () => {
    const doc = await createDoc({ markdown: DOC(), filename: 'fold-live.md', sessionName: uniq('Fold live'), mode: 'publish' })
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, doc)
      await toggle(page, 'a').click({ force: true })
      await putMarkdown(doc.id, DOC('Brand new B paragraph from sync.\n'))
      await para(page, 'Brand new B paragraph from sync.').waitFor({ state: 'visible', timeout: 20000 })
      await eventually(async () => assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true'))
      assert.equal(await para(page, 'A para one.').isVisible(), false)
    } finally { await context.close() }
  })

  it('AC-17.8 deep link /d/<slug>#a1 unfolds A, shows A1 and drops "a" from storage', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      assert.deepEqual(await stored(page, docs.main.id), ['a'])
      await page.goto('about:blank')
      await page.goto(docUrl(docs.main, '#a1'))
      await page.locator('.preview-pane #a1').waitFor({ state: 'visible', timeout: 10000 })
      await eventually(async () => {
        assert.equal(await H(page, 'a').getAttribute('data-folded'), null)
        assert.equal(await H(page, 'a1').isVisible(), true)
        const top = await H(page, 'a1').evaluate((h) => h.getBoundingClientRect().top)
        assert.ok(top >= 0 && top < 900, `A1 in viewport (${top})`)
      })
      assert.ok(!(await stored(page, docs.main.id)).includes('a'))
    } finally { await context.close() }
  })

  it('AC-17.8 a TOC link click into a folded section unfolds it (same fragment too)', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      await page.locator(`${tid('toc-panel')} ${tid('toc-link')}`, { hasText: 'A1' }).click()
      await eventually(async () => assert.equal(await H(page, 'a1').isVisible(), true))
      const top = await H(page, 'a1').evaluate((h) => h.getBoundingClientRect().top)
      assert.ok(top >= 0 && top < 300, `A1 near the top (${top})`)
      // fold again and click the same link (fragment unchanged)
      await toggle(page, 'a').click({ force: true })
      await page.locator(`${tid('toc-panel')} ${tid('toc-link')}`, { hasText: 'A1' }).click()
      await eventually(async () => assert.equal(await H(page, 'a1').isVisible(), true))
      // Back/Forward: fold, go to #b, back to #a1
      await toggle(page, 'a').click({ force: true })
      await page.locator(`${tid('toc-panel')} ${tid('toc-link')}`, { hasText: /^B$/ }).click()
      await page.goBack()
      await eventually(async () => assert.equal(await H(page, 'a1').isVisible(), true))
      assert.deepEqual(page.__errors, [])
    } finally { await context.close() }
  })

  it('deep link to a missing id: no crash, nothing unfolds', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'b').click({ force: true })
      await page.goto('about:blank')
      await page.goto(docUrl(docs.main, '#does-not-exist'))
      await ready(page)
      await eventually(async () => assert.equal(await H(page, 'b').getAttribute('data-folded'), 'true'))
      assert.deepEqual(page.__errors, [])
    } finally { await context.close() }
  })

  it('AC-17.9 deep link into a closed <details> opens it and shows the heading', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(docUrl(docs.details, '#hidden-target'))
      await page.locator('.preview-pane details').waitFor({ state: 'attached', timeout: 10000 })
      await eventually(async () => {
        assert.equal(await page.locator('.preview-pane details').evaluate((d) => d.open), true)
        assert.equal(await H(page, 'hidden-target').isVisible(), true)
        const top = await H(page, 'hidden-target').evaluate((h) => h.getBoundingClientRect().top)
        assert.ok(top >= 0 && top < 900, `in view (${top})`)
      })
    } finally { await context.close() }
  })

  it('AC-17.10 keyboard: Tab reaches toggles, Enter folds, Space unfolds, ring visible; always visible on touch', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await page.mouse.move(1, 1)
      await page.locator('body').focus()
      let reached = false
      for (let i = 0; i < 80 && !reached; i++) {
        await page.keyboard.press('Tab')
        reached = await page.evaluate(() => document.activeElement?.closest?.('h2')?.id === 'a' && document.activeElement.dataset.testid === 'heading-fold-toggle')
      }
      assert.ok(reached, 'Tab reaches the A toggle')
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { o: s.outlineStyle, w: parseFloat(s.outlineWidth), op: Number(s.opacity) } })
      assert.ok(ring.o !== 'none' && ring.w >= 1, 'focus ring')
      assert.ok(ring.op > 0.5, 'focused toggle visible')
      await page.keyboard.press('Enter')
      assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true')
      await page.keyboard.press('Space')
      assert.equal(await H(page, 'a').getAttribute('data-folded'), null)
      const box = await toggle(page, 'a').boundingBox()
      assert.ok(box.width >= 24 && box.height >= 24, `hit area ${box.width}x${box.height}`)
    } finally { await context.close() }
    const touch = await openCtx(browser, { viewport: VIEWPORTS.phone, touch: true })
    try {
      await ready(touch.page)
      const s = await toggle(touch.page, 'a').evaluate((b) => ({ op: Number(getComputedStyle(b).opacity), vis: getComputedStyle(b).visibility, r: b.getBoundingClientRect() }))
      assert.ok(s.op > 0 && s.vis === 'visible', `visible on touch (${s.op})`)
      assert.ok(s.r.width >= 44 && s.r.height >= 44, `touch hit area ${s.r.width}x${s.r.height}`)
      assert.ok(s.r.left >= 0, 'toggle inside the viewport on phone')
      await touch.page.screenshot({ path: join(SCREENS, 'phone.png') })
    } finally { await touch.context.close() }
  })

  it('AC-17.11 print shows folded content and closed details, hides toggles; screen state kept', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      await page.emulateMedia({ media: 'print' })
      const h = await para(page, 'A para one.').evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(h > 0, 'folded para prints')
      const shown = await page.locator(`.preview-pane ${tid('heading-fold-toggle')}, .preview-pane ${tid('heading-fold-ellipsis')}`).evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)
      assert.equal(shown, 0)
      await page.emulateMedia({ media: 'screen' })
      assert.equal(await para(page, 'A para one.').isVisible(), false)
      assert.deepEqual(await stored(page, docs.main.id), ['a'])
    } finally { await context.close() }
    const d = await openCtx(browser)
    try {
      await openDoc(d.page, docs.details, 'Details fixture intro')
      await d.page.emulateMedia({ media: 'print' })
      const h = await d.page.locator('.preview-pane details p', { hasText: 'inside details' }).evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(h > 0, 'closed details body prints')
      assert.equal(await d.page.locator('.preview-pane details').evaluate((x) => x.open), false, 'print does not change details state')
    } finally { await d.context.close() }
  })

  it('AC-17.12 <details> is a styled box with a rotating chevron; native marker hidden', SLOW, async () => {
    for (const theme of THEMES) {
      const { context, page } = await openCtx(browser, { theme })
      try {
        await openDoc(page, docs.details, 'Details fixture intro')
        const det = page.locator('.preview-pane details')
        const sum = det.locator('summary')
        const s = await det.evaluate((d) => {
          const cs = getComputedStyle(d)
          const ss = getComputedStyle(d.querySelector('summary'))
          const before = getComputedStyle(d.querySelector('summary'), '::before')
          return { bw: parseFloat(cs.borderTopWidth), bl: parseFloat(cs.borderLeftWidth), radius: parseFloat(cs.borderTopLeftRadius), open: d.open, cursor: ss.cursor, weight: ss.fontWeight, list: ss.listStyleType, display: ss.display, chevron: before.content, rot: before.transform }
        })
        assert.equal(s.open, false)
        assert.equal(s.bw, 1, `${theme}: 1px box`)
        assert.equal(s.bl, s.bw, `${theme}: no edge stripe`)
        assert.ok(s.radius >= (theme.startsWith('locus') ? 8 : 6), `${theme}: radius ${s.radius}`)
        assert.equal(s.cursor, 'pointer')
        assert.ok(Number(s.weight) >= 600)
        assert.ok(s.list === 'none' || s.display !== 'list-item', 'native marker replaced')
        assert.ok(s.chevron && s.chevron !== 'none', 'chevron')
        await sum.click()
        assert.equal(await det.evaluate((d) => d.open), true)
        const rot = await det.evaluate((d) => getComputedStyle(d.querySelector('summary'), '::before').transform)
        assert.notEqual(rot, s.rot, `${theme}: chevron rotates`)
        assert.match(await det.locator('em').textContent(), /body/)
        await page.screenshot({ path: join(SCREENS, `details-${theme}.png`), clip: await det.boundingBox() })
        if (theme === 'light') {
          await sum.focus()
          await page.keyboard.press('Enter')
          assert.equal(await det.evaluate((d) => d.open), false, 'Enter toggles natively')
        }
      } finally { await context.close() }
    }
  })

  it('AC-17.13 localStorage throwing: folding still works, no error shown', T, async () => {
    const { context, page } = await openCtx(browser, { storage: 'throw' })
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true')
      await page.locator(`${tid('toc-panel')} ${tid('fold-expand-all')}`).click()
      assert.equal(await H(page, 'a').getAttribute('data-folded'), null)
      assert.equal(await page.locator(`${tid('app-toast')}[data-kind="error"]`).count(), 0)
      assert.deepEqual(page.__errors.filter((e) => /fold/i.test(e)), [])
    } finally { await context.close() }
  })

  it('AC-17.14 HTML documents get no fold controls', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await page.goto(docUrl(docs.html))
      await page.locator('iframe.html-frame').waitFor({ state: 'attached', timeout: 10000 })
      await sleep(500)
      for (const id of ['heading-fold-toggle', 'fold-collapse-all', 'fold-expand-all']) assert.equal(await page.locator(tid(id)).count(), 0, id)
    } finally { await context.close() }
  })

  it('rule 4 find-in-page: beforematch on a folded block unfolds its section', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      await para(page, 'A para two.').evaluate((el) => el.dispatchEvent(new Event('beforematch', { bubbles: true })))
      await eventually(async () => assert.equal(await H(page, 'a').getAttribute('data-folded'), null))
    } finally { await context.close() }
  })

  it('rule 14: scrolling to a comment inside a folded section unfolds it', T, async () => {
    const doc = await createDoc({ markdown: DOC(), filename: 'fold-review.md', sessionName: uniq('Fold review'), mode: 'review' })
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, doc)
      await para(page, 'A para two.').click({ clickCount: 3 })
      const bar = page.locator('.selection-action-bar .action-btn')
      await bar.waitFor({ state: 'visible', timeout: 4000 })
      await bar.click()
      await page.locator('.popover-input').fill('Comment inside A')
      await page.locator('.popover .btn-primary').click()
      await page.locator('.comment-card').first().waitFor({ state: 'visible' })
      await toggle(page, 'a').click({ force: true })
      assert.equal(await para(page, 'A para two.').isVisible(), false)
      await page.locator('.comment-card').first().click()
      await eventually(async () => assert.equal(await para(page, 'A para two.').isVisible(), true))
    } finally { await context.close() }
  })

  it('fix round: duplicate heading texts fold independently; a mermaid diagram folded then unfolded renders; folded <hr> takes no space (GitHub)', T, async () => {
    const { context, page } = await openCtx(browser, { theme: 'github-light' })
    try {
      await openDoc(page, docs.dup, 'Dup fixture intro')
      await page.locator('.preview-pane .mermaid svg').waitFor({ state: 'attached', timeout: 20000 })
      await toggle(page, 'notes-1').click({ force: true })
      assert.equal(await para(page, 'first notes body').isVisible(), true)
      assert.equal(await para(page, 'second notes body').isVisible(), false)
      const hr = await page.locator('.preview-pane > hr').evaluate((el) => el.getBoundingClientRect().height)
      assert.equal(hr, 0, 'folded hr has no height')
      await toggle(page, 'notes-1').click({ force: true })
      const svg = await page.locator('.preview-pane .mermaid svg').boundingBox()
      assert.ok(svg && svg.height > 20, 'diagram visible after unfold')
    } finally { await context.close() }
  })

  it('fix round: a doc with only H5 headings has no fold controls', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await openDoc(page, docs.h5, 'H5 only fixture')
      await sleep(300)
      assert.equal(await page.locator(tid('heading-fold-toggle')).count(), 0)
    } finally { await context.close() }
  })

  it('fix round (QA): Edit → Read with a #fragment in the URL keeps a fold the reader made', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page, docs.main, '#a1')
      await toggle(page, 'a').click({ force: true })
      assert.deepEqual(await stored(page, docs.main.id), ['a'])
      await page.locator(tid('view-toggle-edit')).click()
      await page.locator('.cm-content').waitFor({ state: 'visible', timeout: 15000 })
      await page.locator(tid('view-toggle-read')).click()
      await ready(page)
      await sleep(300)
      assert.equal(await H(page, 'a').getAttribute('data-folded'), 'true')
      assert.deepEqual(await stored(page, docs.main.id), ['a'])
    } finally { await context.close() }
  })

  it('fix round: the ellipsis adds no text to the heading; tablet toggles are not clipped', T, async () => {
    const { context, page } = await openCtx(browser, { viewport: VIEWPORTS.tablet })
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      assert.equal((await H(page, 'a').textContent()).includes('⋯'), false)
      assert.equal(await H(page, 'a').locator(tid('heading-fold-ellipsis')).isVisible(), true)
      const r = await toggle(page, 'b').evaluate((b) => { const r = b.getBoundingClientRect(); const pane = document.querySelector('.preview-pane').getBoundingClientRect(); return { l: r.left, pl: pane.left } })
      assert.ok(r.l >= r.pl, `toggle inside the pane (${r.l} >= ${r.pl})`)
    } finally { await context.close() }
  })

  it('a11y: no serious axe violations with a folded section', T, async () => {
    const { context, page } = await openCtx(browser)
    try {
      await ready(page)
      await toggle(page, 'a').click({ force: true })
      const v = await runAxe(page, { include: ['.preview-pane', '[data-testid="toc-panel"]'] })
      assert.equal(v.length, 0, formatViolations(v))
    } finally { await context.close() }
  })
})
