// #8 scope add (docs/build/DECISIONS.md "Scope add (orchestrator)"): two
// pre-existing sync bugs that #8 owns because it owns useSync's remote-change
// handling.
//
//  1. MAJOR — a 412 conflict must survive a reload or close+reopen. Before the
//     fix the reloaded page showed "Unsaved changes" and the next autosave PUT
//     carried the collaborator's hash as If-Match, silently overwriting them.
//     The conflict travels with the persisted draft: its base is the server copy
//     the local edits were based on, never the latest server copy.
//  2. minor — with saves failing, typing and reloading within ~300 ms must not
//     lose the text (the local draft is flushed when the page goes away).
//
// Same conventions as 08-undo-redo.test.mjs: a throwaway backend (E2E_API_URL),
// remote writers simulated with a server PUT, views switched with #2's
// view-toggle testids or the pre-#2 header buttons.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, uniq, waitForDoc } from '../lib/docs.mjs'

const T = { timeout: 90_000 }
const POLL_WAIT = 15_000
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  return context
}

async function newPage(context) {
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return page
}

async function serverMarkdown(id) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(id)}/markdown`)
  assert.equal(res.status, 200, 'GET /paste/:id/markdown')
  return (await res.json()).markdown
}

async function toggle(page, which) {
  const byId = page.locator(tid(`view-toggle-${which}`)).first()
  if (await byId.count()) return byId
  const label = which === 'edit' ? 'Edit' : 'Preview'
  return page.locator(`header button:has-text("${label}")`).first()
}

async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await (await toggle(page, 'edit')).click()
  await page.locator('.cm-editor:visible .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
}

async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    if (!ed) return null
    return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')
  })
}

/** Text on screen in either view (editor or rendered read view). */
async function screenText(page) {
  return page.evaluate(() => [...document.querySelectorAll('.preview-pane, .cm-content')].map((e) => e.textContent).join('\n'))
}

async function caretToEnd(page) {
  await page.locator('.cm-editor:visible .cm-content').first().click()
  await page.keyboard.press(`${MOD}+End`)
}

const saveState = async (page) => ((await page.locator(tid('save-state')).first().textContent().catch(() => '')) ?? '').trim()

/** Every PUT/PATCH to /paste/:id/markdown with its If-Match header. */
function recordWrites(page) {
  const writes = []
  page.on('request', (r) => {
    if (!['PUT', 'PATCH'].includes(r.method())) return
    let path
    try { path = new URL(r.url()).pathname } catch { return }
    if (/\/paste\/[^/]+\/markdown\/?$/.test(path)) writes.push({ at: Date.now(), method: r.method(), ifMatch: r.headers()['if-match'] ?? null })
  })
  return writes
}

/**
 * Drive one tab into a 412 conflict: type local edits, let a collaborator write
 * the doc meanwhile, and have the autosave hit the server with the old hash.
 * The tab's polls are held back (aborted) while this happens, so the conflict
 * comes from the 412 path, not from a poll noticing the change first.
 */
async function intoConflict(context, { id, base, theirs }) {
  const page = await newPage(context)
  let holdPolls = false
  const pollUrl = (url) => new URL(url).pathname.endsWith(`/paste/${id}`)
  const holdHandler = (route) => {
    if (holdPolls && route.request().method() === 'GET') return route.abort()
    return route.fallback()
  }
  await page.route(pollUrl, holdHandler)
  const writes = recordWrites(page)
  await page.goto(`${BASE}/d/${id}`)
  await waitForDoc(page, 'Body line.')
  await toEdit(page)
  holdPolls = true
  await caretToEnd(page)
  await page.keyboard.type(' MINE')
  await putMarkdown(id, theirs)
  const bar = page.locator(tid('conflict-bar'))
  await bar.waitFor({ state: 'visible', timeout: POLL_WAIT })
  assert.ok(writes.length >= 1, 'precondition: the conflict came from an autosave (412)')
  assert.equal(await serverMarkdown(id), theirs, 'precondition: the 412 did not overwrite the server')
  assert.equal(await editorText(page), base + ' MINE', 'precondition: the local edits are on screen')
  // Let the 500 ms draft debounce run so the conflicted draft is persisted.
  await page.waitForTimeout(800)
  await page.unroute(pollUrl, holdHandler)
  return page
}

/** After a reload / reopen: the conflict is still shown and nothing is written for 6 s (> autosave + a poll). */
async function expectConflictKept(page, { id, base, theirs }, what) {
  const writes = recordWrites(page)
  const bar = page.locator(tid('conflict-bar'))
  await bar.waitFor({ state: 'visible', timeout: POLL_WAIT })
  await toEdit(page)
  assert.equal(await editorText(page), base + ' MINE', `${what}: the local edits are restored`)
  const state = await saveState(page)
  assert.doesNotMatch(state, /Unsaved/i, `${what}: save-state is not plain "Unsaved changes": "${state}"`)
  await page.waitForTimeout(6000)
  assert.equal(await serverMarkdown(id), theirs, `${what}: the collaborator's text is not overwritten`)
  assert.deepEqual(writes, [], `${what}: no PUT is sent while the conflict is unresolved`)
  assert.ok(await bar.isVisible(), `${what}: the conflict bar is still shown`)
  return bar
}

describe('#8 scope add — a 412 conflict survives reload and reopen', () => {
  it('reload keeps the conflict; "Keep my version" then overwrites deliberately', T, async () => {
    const base = '# Conflict\n\nBody line.'
    const theirs = '# Conflict\n\nBody line THEIRS.\n\nAdded by a collaborator.'
    const { id } = await createDoc({ markdown: base, sessionName: uniq('Conflict') })
    const context = await newContext()
    try {
      const page = await intoConflict(context, { id, base, theirs })
      await page.reload()
      const bar = await expectConflictKept(page, { id, base, theirs }, 'after reload')

      // The conflict is still resolvable either way after the reload.
      await bar.locator('button:has-text("Keep my version")').click()
      await bar.waitFor({ state: 'hidden', timeout: 5000 })
      const deadline = Date.now() + 8000
      while ((await serverMarkdown(id)) !== base + ' MINE' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
      assert.equal(await serverMarkdown(id), base + ' MINE', '"Keep my version" writes the local edits')
    } finally { await context.close() }
  })

  it('reload, then close + reopen keeps the conflict; "Use server version" adopts the collaborator text', T, async () => {
    const base = '# Reopen\n\nBody line.'
    const theirs = '# Reopen\n\nBody line, rewritten by THEM.'
    const { id } = await createDoc({ markdown: base, sessionName: uniq('Reopen') })
    const context = await newContext()
    try {
      const first = await intoConflict(context, { id, base, theirs })
      // Reload once (the conflict is re-derived from the draft), let that page
      // persist its draft again, then close the tab and open the doc anew.
      await first.reload()
      await first.locator(tid('conflict-bar')).waitFor({ state: 'visible', timeout: POLL_WAIT })
      await first.waitForTimeout(800)
      await first.close({ runBeforeUnload: false })
      const page = await newPage(context)
      await page.goto(`${BASE}/d/${id}`)
      const bar = await expectConflictKept(page, { id, base, theirs }, 'after close + reopen')

      await bar.locator('button:has-text("Use server version")').click()
      await bar.waitFor({ state: 'hidden', timeout: 5000 })
      assert.equal(await editorText(page), theirs, '"Use server version" shows the collaborator text')
      await page.waitForTimeout(3000)
      assert.equal(await serverMarkdown(id), theirs, 'and nothing is written over it')
    } finally { await context.close() }
  })

  it('a second remote change after the reload keeps the conflict (the base stays the pre-conflict copy)', T, async () => {
    const base = '# Twice\n\nBody line.'
    const theirs = '# Twice\n\nBody line THEIRS 1.'
    const theirs2 = '# Twice\n\nBody line THEIRS 2.'
    const { id } = await createDoc({ markdown: base, sessionName: uniq('Twice') })
    const context = await newContext()
    try {
      const page = await intoConflict(context, { id, base, theirs })
      await page.reload()
      await page.locator(tid('conflict-bar')).waitFor({ state: 'visible', timeout: POLL_WAIT })
      await putMarkdown(id, theirs2)
      await page.waitForTimeout(800)
      await page.reload()
      await expectConflictKept(page, { id, base, theirs: theirs2 }, 'after a second remote change and reload')
    } finally { await context.close() }
  })
})

describe('#8 scope add — the local draft is flushed when the page goes away', () => {
  it('with saves failing, text typed < 300 ms before a reload is restored', T, async () => {
    const base = '# Flush\n\nBody line.'
    const { id } = await createDoc({ markdown: base, sessionName: uniq('Flush') })
    const context = await newContext()
    try {
      const page = await newPage(context)
      // Every content save fails (the server is "down" for writes).
      await page.route((url) => /\/paste\/[^/]+\/markdown\/?$/.test(new URL(url).pathname), (route) =>
        ['PUT', 'PATCH'].includes(route.request().method()) ? route.fulfill({ status: 503, body: 'down' }) : route.fallback())
      await page.goto(`${BASE}/d/${id}`)
      await waitForDoc(page, 'Body line.')
      await toEdit(page)
      await caretToEnd(page)
      // First edit: let it hit the failing autosave so the page is in the "error" state.
      await page.keyboard.type(' ONE')
      await page.locator(`${tid('save-state')}.error`).first().waitFor({ state: 'visible', timeout: 10_000 })

      await page.keyboard.type(' QUICK')
      await page.waitForTimeout(100)
      await page.reload()
      await waitForDoc(page, 'Body line.').catch(() => {})
      const deadline = Date.now() + 10_000
      let text = ''
      while (Date.now() < deadline && !(text = await screenText(page)).includes('QUICK')) await new Promise((r) => setTimeout(r, 200))
      assert.ok(text.includes('Body line. ONE QUICK'), `the text typed just before the reload is restored, got: ${JSON.stringify(text.slice(0, 200))}`)
    } finally { await context.close() }
  })

  it('a local (never-shared) doc: text typed < 300 ms before a reload is restored', T, async () => {
    const context = await newContext()
    try {
      const page = await newPage(context)
      await page.goto(`${BASE}/`)
      const blank = page.locator('button:has-text("Start blank")').first()
      await blank.waitFor({ state: 'visible', timeout: 10_000 })
      await blank.click()
      await toEdit(page)
      await caretToEnd(page)
      await page.keyboard.type('LOCALFLUSH')
      await page.waitForTimeout(100)
      await page.reload()
      const deadline = Date.now() + 10_000
      let text = ''
      while (Date.now() < deadline && !(text = await screenText(page)).includes('LOCALFLUSH')) await new Promise((r) => setTimeout(r, 200))
      assert.ok(text.includes('LOCALFLUSH'), `the local draft typed just before the reload is restored, got: ${JSON.stringify(text.slice(0, 200))}`)
    } finally { await context.close() }
  })
})
