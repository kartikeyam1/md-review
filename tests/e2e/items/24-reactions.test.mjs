// Item #24 — reactions, browser half: AC-24.7–24.11, 24.13, 24.14 (+ HTML docs, embed, rapid clicks,
// blocked storage). Server half: server/test-items/24-reactions.test.mjs.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown } from '../lib/docs.mjs'
import { uniq, tid } from './23-lib.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

const T = { timeout: 90_000 }
const DESKTOP = { width: 1400, height: 900 }
const PHONE = { width: 390, height: 844 }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open(url, { viewport = DESKTOP, theme, init, hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch, isMobile: hasTouch })
  if (theme) await context.addInitScript((t) => { try { localStorage.setItem('md-review-theme', t) } catch {} }, theme)
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  await page.goto(url)
  return { context, page }
}
const key = (d) => d.slug || d.id
const reactApi = async (x, body) => {
  const r = await fetch(`${API}/paste/${x}/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}
const summaryApi = async (x) => (await fetch(`${API}/paste/${x}/reactions`)).json()
const btn = (page, code) => page.locator(`${tid('reaction-bar')} ${tid('reaction-btn')}[data-code="${code}"]`)
const rid = () => `qa-${Math.random().toString(36).slice(2, 12)}`

async function waitDoc(page, text) {
  await page.locator('.preview-pane').getByText(text).first().waitFor({ timeout: 15000 })
}

describe('#24 doc reaction bar', () => {
  it('AC-24.7 click 👍 → pressed with count 1, still pressed after reload', T, async () => {
    const d = await createDoc({ markdown: '# Reactions\n\nBody.\n', sessionName: uniq('React') })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'Body.')
      const b = btn(page, '+1')
      await b.waitFor()
      assert.equal(await b.getAttribute('aria-pressed'), 'false')
      assert.equal(await b.locator(tid('reaction-count')).count(), 0, 'no count at 0')
      await b.click()
      assert.equal(await b.getAttribute('aria-pressed'), 'true')
      assert.equal(await b.locator(tid('reaction-count')).innerText(), '1')
      await page.waitForFunction(async ([api, x]) => (await (await fetch(`${api}/paste/${x}/reactions`)).json()).total === 1, [API, d.id], { timeout: 5000 })
      await page.reload()
      await waitDoc(page, 'Body.')
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', `${tid('reaction-bar')} ${tid('reaction-btn')}[data-code="+1"]`, { timeout: 10000 })
      assert.equal(await btn(page, '+1').locator(tid('reaction-count')).innerText(), '1')
      // six buttons in the fixed order
      const codes = await page.locator(`${tid('reaction-bar')} ${tid('reaction-btn')}`).evaluateAll((els) => els.map((e) => e.dataset.code))
      assert.deepEqual(codes, ['+1', 'tada', 'question', 'eyes', 'heart', 'rocket'])
    } finally { await context.close() }
  })

  it('rapid double-click ends matching the server; counts never negative', T, async () => {
    const d = await createDoc({ markdown: '# Rapid\n\nBody.\n' })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'Body.')
      const b = btn(page, 'heart')
      await b.dblclick()
      await b.click()
      await page.waitForTimeout(800)
      const s = await summaryApi(d.id)
      const server = s.doc.find((g) => g.code === 'heart')?.count ?? 0
      const shown = (await b.locator(tid('reaction-count')).count()) ? Number(await b.locator(tid('reaction-count')).innerText()) : 0
      assert.equal(shown, server)
      assert.equal(server, 1, 'three clicks = on')
    } finally { await context.close() }
  })

  it('AC-24.9 reaction-who: "Ana and 2 others"; for one of the anonymous: "You, Ana and 1 other"', T, async () => {
    const d = await createDoc({ markdown: '# Who\n\nBody.\n' })
    const mine = rid()
    await reactApi(d.id, { code: 'rocket', reader_id: rid(), name: 'Ana' })
    await reactApi(d.id, { code: 'rocket', reader_id: rid() })
    await reactApi(d.id, { code: 'rocket', reader_id: mine })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'Body.')
      await btn(page, 'rocket').locator(tid('reaction-count')).waitFor()
      await btn(page, 'rocket').hover()
      const who = page.locator(tid('reaction-who'))
      await who.waitFor()
      assert.equal(await who.innerText(), 'Ana and 2 others')
    } finally { await context.close() }
    const second = await open(`${BASE}/d/${key(d)}`, { init: `try { localStorage.setItem('md-review-reader-id', ${JSON.stringify(mine)}) } catch {}` })
    try {
      await waitDoc(second.page, 'Body.')
      await second.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', `${tid('reaction-bar')} ${tid('reaction-btn')}[data-code="rocket"]`, { timeout: 10000 })
      await btn(second.page, 'rocket').hover()
      const who = second.page.locator(tid('reaction-who'))
      await who.waitFor()
      assert.equal(await who.innerText(), 'You, Ana and 1 other')
    } finally { await second.context.close() }
  })

  it('AC-24.10 a failing request reverts the optimistic state and shows the reaction-failed toast', T, async () => {
    const d = await createDoc({ markdown: '# Fail\n\nBody.\n' })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'Body.')
      await page.route('**/reactions', (route) => (route.request().method() === 'POST' ? route.abort('connectionrefused') : route.continue()))
      const b = btn(page, 'tada')
      await b.click()
      const toast = page.locator(`${tid('app-toast')}[data-toast="reaction-failed"]`)
      await toast.waitFor({ timeout: 5000 })
      assert.equal(await toast.getAttribute('data-kind'), 'error')
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'false', `${tid('reaction-bar')} ${tid('reaction-btn')}[data-code="tada"]`, { timeout: 5000 })
      assert.equal(await b.locator(tid('reaction-count')).count(), 0)
      assert.equal((await summaryApi(d.id)).total, 0)
    } finally { await context.close() }
  })

  it('HTML docs get the doc bar; ?embed=1 and edit view do not', T, async () => {
    const h = await createDoc({ markdown: '<!doctype html><html><body><h2 id="s">Sec</h2><p>Html body</p></body></html>', filename: 'x.html', contentType: 'html' })
    const a = await open(`${BASE}/d/${key(h)}`)
    try {
      await a.page.locator(tid('reaction-bar')).waitFor({ timeout: 15000 })
      assert.equal(await a.page.locator(tid('section-reaction-trigger')).count(), 0)
    } finally { await a.context.close() }
    const d = await createDoc({ markdown: '# Embed\n\n## Part\n\nBody.\n' })
    const e = await open(`${BASE}/d/${key(d)}?embed=1`)
    try {
      await waitDoc(e.page, 'Body.')
      await e.page.waitForTimeout(500)
      assert.equal(await e.page.locator(tid('reaction-bar')).count(), 0)
      assert.equal(await e.page.locator(tid('section-reaction-trigger')).count(), 0)
    } finally { await e.context.close() }
    const v = await open(`${BASE}/d/${key(d)}?view=edit`)
    try {
      await v.page.locator('.cm-content').waitFor({ timeout: 15000 })
      assert.equal(await v.page.locator(tid('reaction-bar')).count(), 0, 'not in the edit view')
    } finally { await v.context.close() }
  })

  it('AC-24.13 dark and Locus themes: ≥ 3:1 button boundary contrast, focusable with a visible focus ring; no serious axe issues', T, async () => {
    const d = await createDoc({ markdown: '# Theme\n\nBody.\n' })
    for (const theme of ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']) {
      const { context, page } = await open(`${BASE}/d/${key(d)}`, { theme })
      try {
        await waitDoc(page, 'Body.')
        const b = btn(page, '+1')
        await b.waitFor()
        const ratio = await b.evaluate((el) => {
          const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.slice(0, 3) }
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
          const border = parse(getComputedStyle(el).borderTopColor)
          let bgEl = el.parentElement
          while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bgEl).backgroundColor)) bgEl = bgEl.parentElement
          const bg = parse(getComputedStyle(bgEl || document.body).backgroundColor)
          const [a, c] = [lum(border), lum(bg)].sort((x, y) => y - x)
          return (a + 0.05) / (c + 0.05)
        })
        assert.ok(ratio >= 3, `${theme}: boundary contrast ${ratio.toFixed(2)}`)
        await b.focus()
        await page.keyboard.press('Shift+Tab')
        await page.keyboard.press('Tab')
        const outline = await b.evaluate((el) => (el === document.activeElement ? getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth : 'not focused'))
        assert.match(outline, /^solid [1-9]/, `${theme}: focus ring (${outline})`)
        const v = await runAxe(page, { include: tid('reaction-bar') })
        assert.equal(v.length, 0, `${theme}: ${formatViolations(v)}`)
      } finally { await context.close() }
    }
  })
})

describe('#24 section reactions', () => {
  it('AC-24.8 phone: tap section-reaction-trigger, pick 👀 → chip with count 1 next to "Rollout plan"', T, async () => {
    const d = await createDoc({ markdown: '# Plan\n\n## Rollout plan\n\nSteps.\n\n## Other\n\nMore.\n' })
    const { context, page } = await open(`${BASE}/d/${key(d)}`, { viewport: PHONE, hasTouch: true })
    try {
      await waitDoc(page, 'Steps.')
      const trigger = page.locator(`#rollout-plan ${tid('section-reaction-trigger')}`)
      assert.ok(await trigger.isVisible(), 'always visible at phone width')
      assert.equal(Number(await trigger.evaluate((el) => getComputedStyle(el).opacity)), 1)
      await trigger.tap()
      const picker = page.locator(tid('reaction-picker'))
      await picker.waitFor()
      assert.equal(await picker.locator(tid('reaction-picker-option')).count(), 6)
      await picker.locator(`${tid('reaction-picker-option')}[data-code="eyes"]`).tap()
      const chip = page.locator(`#rollout-plan ${tid('section-reaction-chip')}[data-code="eyes"]`)
      await chip.waitFor({ timeout: 5000 })
      assert.match(await chip.innerText(), /1/)
      assert.equal(await page.locator(`#other ${tid('section-reaction-chip')}`).count(), 0)
      await page.waitForFunction(async ([api, x]) => {
        const s = await (await fetch(`${api}/paste/${x}/reactions`)).json()
        return s.sections['rollout-plan']?.[0]?.code === 'eyes'
      }, [API, d.id], { timeout: 5000 })
      const box = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, v: innerWidth }))
      assert.ok(box.w <= box.v, 'no horizontal scroll')
    } finally { await context.close() }
  })

  it('AC-24.11 a heading removed in a later revision: its chips disappear, GET still returns the section', T, async () => {
    const d = await createDoc({ markdown: '# Doc\n\n## Old section\n\nA.\n\n## Kept\n\nB.\n' })
    await reactApi(d.id, { code: 'heart', section: 'old-section', reader_id: rid() })
    await reactApi(d.id, { code: 'rocket', section: 'kept', reader_id: rid() })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'A.')
      await page.locator(`#old-section ${tid('section-reaction-chip')}[data-code="heart"]`).waitFor()
      await putMarkdown(d.id, '# Doc\n\n## Kept\n\nB.\n')
      await page.waitForFunction(() => !document.querySelector('#old-section'), null, { timeout: 15000 })
      assert.equal(await page.locator(`${tid('section-reaction-chip')}[data-code="heart"]`).count(), 0)
      await page.locator(`#kept ${tid('section-reaction-chip')}[data-code="rocket"]`).waitFor()
      assert.ok((await summaryApi(d.id)).sections['old-section'], 'server keeps orphan sections')
    } finally { await context.close() }
  })

  it('AC-24.14 desktop keyboard: Tab to the trigger (visible), Enter → picker, Enter on option → chip, Esc → focus back; triple-click selection has no reaction text', T, async () => {
    const d = await createDoc({ markdown: '# Keys\n\nIntro text.\n\n## Rollout plan\n\nSteps.\n' })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'Steps.')
      const trigger = page.locator(`#rollout-plan ${tid('section-reaction-trigger')}`)
      assert.equal(Number(await trigger.evaluate((el) => getComputedStyle(el).opacity)), 0, 'hidden until hover/focus on desktop')
      // Tab from the preview until the trigger has focus.
      await page.locator('.preview-pane').click({ position: { x: 5, y: 5 } })
      let found = false
      for (let i = 0; i < 40 && !found; i++) {
        await page.keyboard.press('Tab')
        found = await trigger.evaluate((el) => el === document.activeElement)
      }
      assert.ok(found, 'the trigger is in the tab order')
      await page.waitForFunction((el) => getComputedStyle(el).opacity === '1', await trigger.elementHandle(), { timeout: 2000 })
      await page.keyboard.press('Enter')
      const picker = page.locator(tid('reaction-picker'))
      await picker.waitFor()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
      await page.keyboard.press('Enter') // first option (👍) has focus
      const chip = page.locator(`#rollout-plan ${tid('section-reaction-chip')}[data-code="+1"]`)
      await chip.waitFor({ timeout: 5000 })
      await page.keyboard.press('Escape')
      await picker.waitFor({ state: 'detached', timeout: 3000 })
      assert.ok(await trigger.evaluate((el) => el === document.activeElement), 'focus back on the trigger')
      // Triple-click the heading text.
      await page.locator('#rollout-plan').click({ clickCount: 3, position: { x: 10, y: 8 } })
      const sel = await page.evaluate(() => getSelection().toString())
      assert.match(sel, /Rollout plan/)
      assert.ok(!/👍|1\s*$|React/.test(sel.replace(/Rollout plan/, '')), `selection: ${JSON.stringify(sel)}`)
      assert.ok(!sel.includes('👍'))
      assert.equal(await page.locator('#rollout-plan').getAttribute('id'), 'rollout-plan', 'id unchanged')
    } finally { await context.close() }
  })

  it('fix: Tab past the last picker option closes it; keyboard focus on a chip shows who reacted', T, async () => {
    const d = await createDoc({ markdown: '# K\n\n## Rollout plan\n\nSteps.\n\nEnd text.\n' })
    await reactApi(d.id, { code: 'eyes', section: 'rollout-plan', reader_id: rid(), name: 'Ana' })
    const { context, page } = await open(`${BASE}/d/${key(d)}`)
    try {
      await waitDoc(page, 'Steps.')
      const chip = page.locator(`#rollout-plan ${tid('section-reaction-chip')}[data-code="eyes"]`)
      await chip.waitFor()
      await chip.focus()
      const who = page.locator(tid('reaction-who'))
      await who.waitFor({ timeout: 3000 })
      assert.equal(await who.innerText(), 'Ana')
      const trigger = page.locator(`#rollout-plan ${tid('section-reaction-trigger')}`)
      await trigger.focus()
      await page.keyboard.press('Enter')
      const picker = page.locator(tid('reaction-picker'))
      await picker.waitFor()
      await page.locator(`${tid('reaction-picker-option')}[data-code="rocket"]`).focus()
      await page.keyboard.press('Tab')
      await picker.waitFor({ state: 'detached', timeout: 3000 })
      assert.ok(await trigger.evaluate((el) => el === document.activeElement), 'back on the trigger')
      // the doc bar: keyboard focus shows who too
      await reactApi(d.id, { code: 'heart', reader_id: rid(), name: 'Ben' })
      await page.reload()
      await waitDoc(page, 'Steps.')
      await btn(page, 'heart').locator(tid('reaction-count')).waitFor()
      await btn(page, 'heart').focus()
      await who.waitFor({ timeout: 3000 })
      assert.equal(await who.innerText(), 'Ben')
    } finally { await context.close() }
  })

  it('localStorage blocked: reactions still work for the page lifetime', T, async () => {
    const d = await createDoc({ markdown: '# Private\n\nBody.\n' })
    const block = `(() => { const t = () => { throw new DOMException('blocked', 'SecurityError') }; Object.defineProperty(window, 'localStorage', { get: t, configurable: true }) })()`
    const { context, page } = await open(`${BASE}/d/${key(d)}`, { init: block })
    try {
      await waitDoc(page, 'Body.')
      await btn(page, 'eyes').click()
      await page.waitForFunction(async ([api, x]) => (await (await fetch(`${api}/paste/${x}/reactions`)).json()).total === 1, [API, d.id], { timeout: 5000 })
      assert.equal(await btn(page, 'eyes').getAttribute('aria-pressed'), 'true')
    } finally { await context.close() }
  })
})
