// #12 Slash menu — acceptance tests in the browser (docs/build/specs/12-slash-menu.md AC-12.1 – 12.18;
// 00 §3.4 Esc layering, §3.6 undo contract). Pure filtering/insertion/[[toc]] logic is unit-tested in
// tests/items/12-slash-menu.test.ts.
//
// Docs are local (editor capability) through the dev `?filePath=` loader. The editor text is read from
// the rendered `.cm-line`s (short docs); the caret is placed with real keys only. Typing uses
// `page.keyboard.type`, i.e. real key input, which is what opens the menu (rule 1).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE } from '../helpers.mjs'
import { runAxe, formatViolations } from '../lib/axe.mjs'

const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'

const CATALOGUE = [
  'h1', 'h2', 'h3', 'bullet', 'numbered', 'task', 'table', 'code', 'mermaid',
  'callout-note', 'callout-tip', 'callout-important', 'callout-warning', 'callout-caution',
  'rag-green', 'rag-amber', 'rag-red', 'divider', 'toc', 'date',
]
const TABLE = '| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |\n|          |          |          |'

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac12-'))
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
function localDocUrl(text, name = `slash-${++fileSeq}.md`) {
  const p = join(tmp, name)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}`
}

async function until(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${message}` })
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function toggle(page, which) {
  const byId = page.locator(tid(`view-toggle-${which}`)).first()
  if (await byId.count()) return byId
  const label = which === 'edit' ? 'Edit' : 'Preview'
  return page.locator(`header button:has-text("${label}")`).first()
}
const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()

async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await (await toggle(page, 'edit')).click()
  await editorContent(page).waitFor({ state: 'visible', timeout: 20_000 })
}
async function toRead(page) {
  await (await toggle(page, 'read')).click()
  await page.locator('.preview-pane').first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    if (!ed) return null
    return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')
  })
}
async function waitEditorText(page, pred, message, timeout = 5000) {
  let seen
  try {
    await until(async () => { seen = await editorText(page); return seen !== null && pred(seen) }, { timeout, message })
  } catch (e) {
    throw new assert.AssertionError({ message: `${e.message}\n  editor text: ${JSON.stringify(seen)}` })
  }
  return seen
}
const expectText = (page, want, what) => waitEditorText(page, (t) => t === want, `${what}: ${JSON.stringify(want)}`)

/** Open `text` locally, switch to Edit, caret at the doc end. */
async function editLocal(page, text, name) {
  await page.goto(localDocUrl(text, name))
  await until(async () => {
    try { await toEdit(page) } catch { return false }
    return (await editorText(page)) === text
  }, { timeout: 20_000, interval: 200, message: `the doc in the editor: ${JSON.stringify(text)}` })
  await editorContent(page).focus()
  await page.keyboard.press(`${MOD}+End`)
}

const menu = (page) => page.locator(`${tid('slash-menu')}:visible`)
const menuOpen = async (page) => (await menu(page).count()) > 0
const items = (page) => page.locator(`${tid('slash-menu')}:visible ${tid('slash-menu-item')}`)
const commands = (page) => items(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-command')))
const highlighted = (page) => page.locator(`${tid('slash-menu')}:visible ${tid('slash-menu-item')}[aria-selected="true"]`)
const domSelection = (page) => page.evaluate(() => window.getSelection()?.toString() ?? '')
const focusInEditor = (page) => page.evaluate(() => !!document.activeElement?.closest?.('.cm-content'))

async function waitMenu(page) {
  await menu(page).first().waitFor({ state: 'visible', timeout: 5000 })
}
/** No menu now, nor shortly after (it would paint within a frame). */
async function expectNoMenu(page, what) {
  await page.waitForTimeout(250)
  assert.equal(await menuOpen(page), false, `${what}: no slash-menu`)
}
async function firstHighlighted(page, id, what) {
  await until(async () => (await commands(page))[0] === id, { timeout: 3000, message: `${what}: ${id} first` })
  assert.equal(await highlighted(page).count(), 1, `${what}: one highlighted item`)
  assert.equal(await highlighted(page).getAttribute('data-command'), id, `${what}: ${id} highlighted`)
}

async function previewHas(page, fn, arg, message, timeout = 10_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout })
  } catch {
    const html = await page.evaluate(() => document.querySelector('.preview-pane')?.innerHTML.slice(0, 800) ?? '(no .preview-pane)')
    assert.fail(`${message}\n  preview: ${html}`)
  }
}

describe('#12 slash menu', () => {
  it('AC-12.1 `/` in an empty doc opens the full catalogue, first item selected', T, async () => {
    const { context, page, errors } = await open()
    try {
      await editLocal(page, '')
      await page.keyboard.type('/')
      await waitMenu(page)
      assert.deepEqual(await commands(page), CATALOGUE)
      assert.equal(await items(page).first().getAttribute('aria-selected'), 'true')
      assert.equal(await highlighted(page).count(), 1)
      // each item shows its label + a one-line hint
      const first = await items(page).first().innerText()
      assert.match(first, /Heading 1/)
      assert.match(first, /#/)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-12.2 no menu after `https:`; menu after a space', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'see https:')
      await page.keyboard.type('/')
      await expectText(page, 'see https:/', 'the slash is typed')
      await expectNoMenu(page, 'after a colon')
      await page.keyboard.type('/a/b')
      await expectNoMenu(page, 'inside a URL')

      await editLocal(page, 'foo ')
      await page.keyboard.type('/')
      await waitMenu(page)
    } finally { await context.close() }
  })

  it('AC-12.3 no menu in fenced code, unclosed inline code, front matter, or an HTML doc', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# T\n\n```\ncode \n```')
      // caret to the end of the "code " line
      await page.keyboard.press(`${MOD}+End`)
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('End')
      await page.keyboard.type('/')
      await expectText(page, '# T\n\n```\ncode /\n```', 'slash typed in code')
      await expectNoMenu(page, 'fenced code')

      await editLocal(page, 'x `a ')
      await page.keyboard.type('/')
      await expectText(page, 'x `a /', 'slash typed in inline code')
      await expectNoMenu(page, 'unclosed inline code')

      await editLocal(page, '---\ntitle: x \n---\n\n# Body')
      await page.keyboard.press(`${MOD}+Home`)
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('End')
      await page.keyboard.type('/')
      await expectText(page, '---\ntitle: x /\n---\n\n# Body', 'slash typed in front matter')
      await expectNoMenu(page, 'front matter')

      await editLocal(page, '<p>Hello </p>', `slash-${++fileSeq}.html`)
      await page.keyboard.press(`${MOD}+End`)
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
      await page.keyboard.type('/')
      await expectText(page, '<p>Hello /</p>', 'slash typed in the HTML doc')
      await expectNoMenu(page, 'HTML doc')
    } finally { await context.close() }
  })

  it('AC-12.4 `tab` → table first and highlighted; `warn` → callout-warning first', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '# T\n\n')
      await page.keyboard.type('/tab')
      await waitMenu(page)
      await firstHighlighted(page, 'table', '/tab')
      await page.keyboard.press('Escape')
      await expectNoMenu(page, 'after Esc')
      await page.keyboard.press('Enter')
      await page.keyboard.type('/warn')
      await waitMenu(page)
      await firstHighlighted(page, 'callout-warning', '/warn')
    } finally { await context.close() }
  })

  it('AC-12.5 + AC-12.6 /table + Enter inserts the table with `Column 1` selected; one undo → `/table`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '')
      await page.keyboard.type('/table')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await expectText(page, TABLE, 'the catalogue table')
      assert.equal(await domSelection(page), 'Column 1')
      assert.equal(await menuOpen(page), false, 'menu closed after commit')

      await page.keyboard.press(`${MOD}+z`)
      await expectText(page, '/table', 'AC-12.6 one undo')
      await expectNoMenu(page, 'after the undo')
      // redo re-applies it in one step. `Shift+Z` (capital): Playwright's `Shift+z` sends key "z", which CodeMirror
      // reads as Mod+Z (undo) whenever there is something to undo; a real keyboard sends "Z".
      await page.keyboard.press(`${MOD}+Shift+Z`)
      await expectText(page, TABLE, 'redo')
      await page.keyboard.press(`${MOD}+z`)
      await expectText(page, '/table', 'undo again')

      await page.keyboard.press(`${MOD}+Shift+Z`)
      await expectText(page, TABLE, 'redo')
      await toRead(page)
      await previewHas(page, () => {
        const t = document.querySelector('.preview-pane table')
        return t && t.querySelectorAll('thead th').length === 3 && t.querySelectorAll('tbody tr').length === 2
      }, null, 'a 3-column table with 2 body rows')
    } finally { await context.close() }
  })

  it('AC-12.7 no match shows `slash-menu-empty`; Esc closes and keeps `/xyz`', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'A\n\n')
      await page.keyboard.type('/xyz')
      const empty = page.locator(`${tid('slash-menu-empty')}:visible`)
      await empty.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal((await empty.innerText()).trim(), 'No matching blocks')
      await page.keyboard.press('Escape')
      await expectNoMenu(page, 'after Esc')
      await expectText(page, 'A\n\n/xyz', 'Esc leaves the doc as typed')
      // Enter with no match closes and performs a normal Enter
      await page.keyboard.type(' /qq')
      await page.locator(`${tid('slash-menu-empty')}:visible`).waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press('Enter')
      await expectText(page, 'A\n\n/xyz /qq\n', 'Enter with no match → newline')
      await expectNoMenu(page, 'after Enter with no match')
    } finally { await context.close() }
  })

  it('AC-12.8 ↓ wraps to the first item; clicking an item inserts it and the editor keeps focus', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'A\n\n')
      await page.keyboard.type('/')
      await waitMenu(page)
      for (let i = 0; i < CATALOGUE.length - 1; i++) await page.keyboard.press('ArrowDown')
      assert.equal(await highlighted(page).getAttribute('data-command'), CATALOGUE.at(-1))
      await page.keyboard.press('ArrowDown')
      assert.equal(await highlighted(page).getAttribute('data-command'), CATALOGUE[0], '↓ past the last wraps to the first')
      await page.keyboard.press('ArrowUp')
      assert.equal(await highlighted(page).getAttribute('data-command'), CATALOGUE.at(-1), '↑ from the first wraps to the last')

      // hover highlights
      await items(page).filter({ has: page.locator('text=Heading 2') }).first().hover()
      assert.equal(await highlighted(page).getAttribute('data-command'), 'h2')

      await page.locator(`${tid('slash-menu')}:visible ${tid('slash-menu-item')}[data-command="h3"]`).click()
      await expectText(page, 'A\n\n### ', 'clicked item inserted')
      assert.equal(await focusInEditor(page), true, 'the editor keeps focus')
      await page.keyboard.type('Typed')
      await expectText(page, 'A\n\n### Typed', 'typing continues in the doc')
    } finally { await context.close() }
  })

  it('AC-12.9 /code → language step: `py` + Enter → ```python fence, caret inside; Esc → `/code` unchanged', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '')
      await page.keyboard.type('/code')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      const input = page.locator(`${tid('slash-menu-lang-input')}:visible`)
      await input.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await input.getAttribute('placeholder'), 'Language')
      assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'the language input is focused')
      assert.equal(await editorText(page), '/code', 'doc untouched until a language is chosen')
      const first = page.locator(`${tid('slash-menu-lang-option')}:visible`).first()
      assert.equal(await first.getAttribute('data-lang'), '')
      assert.match(await first.innerText(), /Plain text/)
      await page.keyboard.type('py')
      await page.keyboard.press('Enter')
      await expectText(page, '```python\n\n```', 'python fence')
      assert.equal(await focusInEditor(page), true)
      await page.keyboard.type('x = 1')
      await expectText(page, '```python\nx = 1\n```', 'caret on the empty line')
      // still one undo step back to `/code`
      await page.keyboard.press(`${MOD}+z`)
      await expectText(page, '```python\n\n```', 'undo the typing')
      await page.keyboard.press(`${MOD}+z`)
      await expectText(page, '/code', 'one undo for the insertion')

      await editLocal(page, '')
      await page.keyboard.type('/code')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await input.waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press('Escape')
      await expectNoMenu(page, 'after Esc in the language step')
      await expectText(page, '/code', 'Esc cancels the whole insertion')
      assert.equal(await focusInEditor(page), true, 'focus back in the editor')
      await page.keyboard.type('!')
      await expectText(page, '/code!', 'caret where it was')
    } finally { await context.close() }
  })

  it('AC-12.10 /mermaid renders a diagram; `Start` is selected', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '')
      await page.keyboard.type('/mermaid')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await waitEditorText(page, (t) => t.startsWith('```mermaid\nflowchart TD'), 'mermaid fence')
      assert.equal(await domSelection(page), 'Start')
      await toRead(page)
      await previewHas(page, () => !!document.querySelector('.preview-pane .mermaid svg'), null, 'a rendered mermaid svg', 20_000)
    } finally { await context.close() }
  })

  it('AC-12.11 each callout: `> [!TYPE]` then the caret on the `> ` line', T, async () => {
    const { context, page } = await open()
    try {
      for (const [q, type] of [['note', 'NOTE'], ['tip', 'TIP'], ['important', 'IMPORTANT'], ['warn', 'WARNING'], ['caution', 'CAUTION']]) {
        await editLocal(page, '')
        await page.keyboard.type(`/${q}`)
        await waitMenu(page)
        assert.equal(await highlighted(page).getAttribute('data-command'), `callout-${type.toLowerCase()}`)
        await page.keyboard.press('Enter')
        await expectText(page, `> [!${type}]\n> `, `${type} callout`)
        await page.keyboard.type('Body')
        await expectText(page, `> [!${type}]\n> Body`, `${type}: caret on the > line`)
      }
    } finally { await context.close() }
  })

  it('AC-12.12 `Status: /rag` → `:rag-green[On track]` with `On track` selected; renders a green badge', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'Status: ')
      await page.keyboard.type('/rag')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await expectText(page, 'Status: :rag-green[On track]', 'rag inserted')
      assert.equal(await domSelection(page), 'On track')
      await page.keyboard.type('Done')
      await expectText(page, 'Status: :rag-green[Done]', 'label replaced')
      await toRead(page)
      await previewHas(page, () => {
        const b = document.querySelector('.preview-pane [data-testid="rag-badge"][data-rag="green"]')
        return b && b.textContent.includes('Done')
      }, null, 'a green rag-badge reading Done')
    } finally { await context.close() }
  })

  it('AC-12.13 text before /h2 stays on its line; /divider gets a blank line (hr, not an H2)', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'Intro text ')
      await page.keyboard.type('/h2')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await expectText(page, 'Intro text\n## ', 'heading on a new line')
      await page.keyboard.type('X')
      await expectText(page, 'Intro text\n## X', 'caret after `## `')

      await editLocal(page, 'Intro text ')
      await page.keyboard.type('/divider')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await expectText(page, 'Intro text\n\n---\n', 'blank line before the divider')
      await toRead(page)
      await previewHas(page, () => {
        const p = document.querySelector('.preview-pane')
        return p && [...p.querySelectorAll('p')].some((e) => e.textContent.includes('Intro text')) && p.querySelector('hr') && !p.querySelector('h2')
      }, null, 'a paragraph and an hr, no h2')
    } finally { await context.close() }
  })

  it('AC-12.14 /date → today’s local date', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, 'Due ')
      await page.keyboard.type('/date')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      const today = await page.evaluate(() => {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })
      await expectText(page, `Due ${today}`, 'the local date')
    } finally { await context.close() }
  })

  it('AC-12.15 [[toc]] renders an inline TOC of H2/H3 with #3 ids; in code it stays literal', T, async () => {
    const { context, page } = await open()
    try {
      await page.goto(localDocUrl('# Doc\n\n[[toc]]\n\n## A\n\nx\n\n### B\n\ny\n\n## C\n\n`[[toc]]`\n'))
      await previewHas(page, () => document.querySelectorAll('.preview-pane [data-testid="inline-toc"]').length === 1, null, 'one inline-toc', 20_000)
      const hrefs = await page.locator(`.preview-pane ${tid('inline-toc-link')}`).evaluateAll((as) => as.map((a) => a.getAttribute('href')))
      assert.deepEqual(hrefs, ['#a', '#b', '#c'])
      const nested = await page.locator(`.preview-pane ${tid('inline-toc-link')}[href="#b"]`).evaluate((a) => a.closest('li').parentElement.closest('li')?.querySelector('a')?.getAttribute('href'))
      assert.equal(nested, '#a', 'B nested under A')
      assert.equal(await page.locator('.preview-pane code', { hasText: '[[toc]]' }).count(), 1, '`[[toc]]` in code is literal')
      // a link jumps to the heading
      await page.locator(`.preview-pane ${tid('inline-toc-link')}[href="#c"]`).click()
      await until(() => page.evaluate(() => {
        const h = document.getElementById('c')
        if (!h) return false
        const r = h.getBoundingClientRect()
        return r.top >= 0 && r.top < window.innerHeight
      }), { timeout: 5000, message: 'heading C in view' })
    } finally { await context.close() }
  })

  it('AC-12.16 at 390×844 the menu lies inside the viewport', T, async () => {
    const { context, page } = await open({ viewport: { width: 390, height: 844 } })
    try {
      await editLocal(page, 'A long first line that wraps on a phone screen for sure ')
      await page.keyboard.type('/')
      await waitMenu(page)
      const box = await menu(page).first().boundingBox()
      assert.ok(box, 'menu has a box')
      assert.ok(box.x >= 0 && box.y >= 0, `menu top-left inside: ${JSON.stringify(box)}`)
      assert.ok(box.x + box.width <= 390 && box.y + box.height <= 844, `menu bottom-right inside: ${JSON.stringify(box)}`)
      assert.ok(box.height <= 321, `max height 320: ${box.height}`)
    } finally { await context.close() }
  })

  it('AC-12.17 listbox / option roles and aria-activedescendant follow the highlight', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '')
      await page.keyboard.type('/')
      await waitMenu(page)
      assert.equal(await menu(page).getAttribute('role'), 'listbox')
      assert.equal(await menu(page).getAttribute('aria-label'), 'Insert block')
      const roles = await items(page).evaluateAll((els) => els.map((e) => e.getAttribute('role')))
      assert.ok(roles.every((r) => r === 'option'), `all options: ${roles}`)
      const check = async (what) => {
        const id = await highlighted(page).getAttribute('id')
        assert.ok(id, `${what}: highlighted item has an id`)
        assert.equal(await editorContent(page).getAttribute('aria-activedescendant'), id, `${what}: aria-activedescendant`)
      }
      await check('initial')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await check('after ↓↓')
      const ids = await items(page).evaluateAll((els) => els.map((e) => e.id))
      assert.equal(new Set(ids).size, ids.length, 'unique ids')
      const res = await runAxe(page, { include: tid('slash-menu') })
      assert.deepEqual(res.violations ?? res, [], formatViolations(res.violations ?? res))
      await page.keyboard.press('Escape')
      await expectNoMenu(page, 'after Esc')
      assert.equal(await editorContent(page).getAttribute('aria-activedescendant'), null, 'cleared on close')
    } finally { await context.close() }
  })

  it('AC-12.18 Enter in a list item commits the menu item, no new bullet', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '- first\n- second ')
      await page.keyboard.type('/rag')
      await waitMenu(page)
      await page.keyboard.press('Enter')
      await expectText(page, '- first\n- second :rag-green[On track]', 'inserted, no new bullet')
      // Tab commits too (beats #9 indent)
      await page.keyboard.press('End')
      await page.keyboard.type(' /date')
      await waitMenu(page)
      await page.keyboard.press('Tab')
      await waitEditorText(page, (t) => /^- first\n- second :rag-green\[On track\] \d{4}-\d\d-\d\d$/.test(t), 'Tab commits, no indent')
    } finally { await context.close() }
  })

  it('rule 9 closes: whitespace, backspace past the slash, caret leaving, blur — doc as typed', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '')
      await page.keyboard.type('/ta')
      await waitMenu(page)
      await page.keyboard.type(' ')
      await expectNoMenu(page, 'after a space')
      await expectText(page, '/ta ', 'space typed')

      await page.keyboard.press('Enter')
      await page.keyboard.type('/t')
      await waitMenu(page)
      await page.keyboard.press('Backspace')
      await waitMenu(page)
      assert.deepEqual(await commands(page), CATALOGUE, 'empty query → full list again')
      await page.keyboard.press('Backspace')
      await expectNoMenu(page, 'slash deleted')

      await page.keyboard.type('x /h')
      await waitMenu(page)
      await page.keyboard.press('ArrowLeft')
      await waitMenu(page)
      await page.keyboard.press('ArrowLeft')
      await expectNoMenu(page, 'caret left the query')
      await expectText(page, '/ta \nx /h', 'doc as typed')

      await page.keyboard.press('End')
      await page.keyboard.type(' /')
      await waitMenu(page)
      await page.evaluate(() => document.activeElement?.blur?.())
      await expectNoMenu(page, 'editor blurred')
      await expectText(page, '/ta \nx /h /', 'blur leaves the doc')
    } finally { await context.close() }
  })

  it('a pasted `/table` opens no menu', T, async () => {
    const { context, page } = await open()
    try {
      await editLocal(page, '')
      await editorContent(page).evaluate((el) => {
        const dt = new DataTransfer()
        dt.setData('text/plain', '/table')
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await expectText(page, '/table', 'pasted')
      await expectNoMenu(page, 'after paste')
    } finally { await context.close() }
  })
})
