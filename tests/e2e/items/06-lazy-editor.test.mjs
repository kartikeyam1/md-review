// #6 Lazy-load the editor — frozen acceptance tests (docs/build/specs/06-lazy-editor.md).
//
// Runs on vite dev (scripts/verify.sh), where there are no chunks: the editor
// arrives as separate module requests — /src/components/EditorPane.vue and the
// pre-bundled deps /node_modules/.vite/deps/@codemirror_*.js, codemirror.js.
// The AC's request pattern /codemirror|EditorPane/i matches all of them, so
// "an editor-chunk request" here means "a request whose URL matches it".
// The production build (hashed chunks, marker strings in the chunk bodies) is
// covered by 06-lazy-editor-build.test.mjs and tests/items/06-lazy-editor.test.ts.
//
// Views are switched with #2's `view-toggle-*` testids. Until #2 lands, today's
// header Edit / Preview buttons are used instead, so a red run fails on the #6
// behaviour (CodeMirror loaded eagerly), not on missing #2 UI.
//
// To make the transient states observable, some tests HOLD the EditorPane
// module request (page.route) until they have looked at the placeholder, then
// release it; AC-06.6 answers it with a 404.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq, waitForDoc } from '../lib/docs.mjs'

const FIXTURE = fileURLToPath(new URL('../fixture.md', import.meta.url))
const FILE_URL = `${BASE}/?filePath=${encodeURIComponent(FIXTURE)}`

/** AC pattern for "an editor-chunk request". */
const EDITOR_RE = /codemirror|EditorPane/i
/** The EditorPane module / chunk itself (dev: /src/components/EditorPane.vue, build: /assets/EditorPane-<hash>.js). */
const EDITOR_PANE_PATH = /EditorPane/i

/** Per-test cap: a missing feature must fail, never hang the gate. */
const T = { timeout: 60_000 }

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

/** Fresh context (no cache, no persisted drafts). */
async function open({ viewport = { width: 1400, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const rec = recordRequests(page)
  return { context, page, rec }
}

/**
 * Every request the page makes (all resource types), attached before goto.
 *   all()      every URL, in order, duplicates kept
 *   editor()   the URLs matching EDITOR_RE, duplicates kept
 *   quiet()    resolves once nothing has been in flight for `idle` ms
 */
function recordRequests(page) {
  const all = []
  const inflight = new Set()
  let lastChange = Date.now()
  page.on('request', (r) => { all.push(r.url()); inflight.add(r); lastChange = Date.now() })
  const done = (r) => { inflight.delete(r); lastChange = Date.now() }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  return {
    all: () => [...all],
    editor: () => all.filter((u) => EDITOR_RE.test(u)),
    pendingEditor: () => [...inflight].filter((r) => EDITOR_RE.test(r.url())).length,
    async quiet({ idle = 400, timeout = 10_000 } = {}) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (inflight.size === 0 && Date.now() - lastChange >= idle) return
        await new Promise((r) => setTimeout(r, 50))
      }
    },
  }
}

const list = (urls) => urls.map((u) => { try { const x = new URL(u); return x.pathname + x.search } catch { return u } }).join('\n  ')

/** The view-toggle segment (#2), or today's header Edit / Preview button before #2. */
async function toggle(page, which) {
  const byId = page.locator(`[data-testid="view-toggle-${which}"]`).first()
  if (await byId.count()) return byId
  const label = which === 'edit' ? 'Edit' : 'Preview'
  return page.locator(`header button:has-text("${label}")`).first()
}

/** A plain markdown doc (no fenced code, so CodeMirror never lazy-loads a language mode). */
function plainDoc(title, marker, paragraphs = 60) {
  const body = Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i + 1} of ${title}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`)
  return [`# ${title}`, '', marker, '', ...body.flatMap((p) => [p, ''])].join('\n')
}

/** Hold the EditorPane request until release(); every later request passes straight through. */
async function holdEditorChunk(page) {
  let release
  const gate = new Promise((r) => { release = r })
  let held = 0
  await page.route((u) => EDITOR_PANE_PATH.test(u.pathname), async (route) => {
    held++
    await gate
    await route.continue().catch(() => {})
  })
  return { release: () => release(), held: () => held }
}

const visibleEditor = (page) => page.locator('.cm-editor:visible').first()

async function waitEditorMounted(page, { timeout = 20_000 } = {}) {
  await visibleEditor(page).waitFor({ state: 'visible', timeout })
  await page.locator('.cm-editor:visible .cm-content').first().waitFor({ state: 'visible', timeout })
}

/** Scroll every scrollable thing (document and inner panes) to the bottom, the way a reader would. */
async function scrollWholePage(page) {
  await page.mouse.move(700, 600)
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 900)
    await page.waitForTimeout(40)
  }
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight)
    for (const el of document.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight
    }
  })
}

// ── AC-06.1 ────────────────────────────────────────────────────────────────
describe('#6 lazy editor — read view never loads the editor', () => {
  it('AC-06.1 a shared doc opened in read view and left idle 5 s makes no /codemirror|EditorPane/i request', T, async () => {
    const doc = await createDoc({ markdown: plainDoc('Idle read', 'Idle read marker (AC-06.1).'), filename: 'idle.md', sessionName: uniq('Idle read') })
    const { context, page, rec } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, 'Idle read marker (AC-06.1).')
      // Precondition: this reader is an editor (the toggle exists), so "no editor
      // request" is not just "there is no editor for this reader".
      await (await toggle(page, 'edit')).waitFor({ state: 'visible', timeout: 10_000 })
      // The AC's idle window: no input at all, the pointer never moved.
      await page.waitForTimeout(5000)
      await rec.quiet()
      assert.deepEqual(rec.editor(), [], `read view requested editor modules:\n  ${list(rec.editor())}`)
      assert.equal(await page.locator('.cm-editor').count(), 0, 'no editor DOM in read view')
    } finally { await context.close() }
  })

  // ── AC-06.2 ──────────────────────────────────────────────────────────────
  it('AC-06.2 clicking Edit requests the editor, shows editor-loading until .cm-editor appears, then the doc text', T, async () => {
    const marker = 'Load on click marker (AC-06.2).'
    const doc = await createDoc({ markdown: plainDoc('Click to edit', marker), filename: 'click.md', sessionName: uniq('Click to edit') })
    const { context, page, rec } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, marker)
      await rec.quiet()
      assert.deepEqual(rec.editor(), [], `precondition (AC-06.1): no editor request before the click:\n  ${list(rec.editor())}`)

      const hold = await holdEditorChunk(page)
      // Sample, every frame, whether the placeholder / a visible editor is on screen.
      await page.evaluate(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        window.__lazyStates = []
        const tick = () => {
          const l = vis(document.querySelector('[data-testid="editor-loading"]'))
          const e = [...document.querySelectorAll('.cm-editor')].some(vis)
          const s = (l ? 'L' : '') + (e ? 'E' : '') || 'N'
          if (window.__lazyStates.at(-1) !== s) window.__lazyStates.push(s)
          if (!window.__lazyStop) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })

      const edit = await toggle(page, 'edit')
      await edit.click()

      const loading = page.locator('[data-testid="editor-loading"]')
      await loading.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await loading.getAttribute('aria-busy'), 'true', 'editor-loading has aria-busy="true"')
      assert.match(await loading.innerText(), /Loading editor(…|\.\.\.)/, 'placeholder text')
      assert.equal(await page.locator('.cm-editor:visible').count(), 0, 'no editor while the chunk is held')
      const editTestid = page.locator('[data-testid="view-toggle-edit"]')
      if (await editTestid.count()) {
        assert.equal(await editTestid.getAttribute('aria-pressed'), 'true', 'rule 3: the toggle already shows Edit as pressed while loading')
      }
      assert.ok(rec.editor().length > 0, 'the click requested the editor')

      hold.release()
      await waitEditorMounted(page)
      await loading.waitFor({ state: 'hidden', timeout: 5000 })
      const states = await page.evaluate(() => { window.__lazyStop = true; return window.__lazyStates })
      // Drop frames before the placeholder first showed; from then on the
      // placeholder must stay until a visible editor exists: no blank frame.
      const fromL = states.slice(states.indexOf('L'))
      const firstE = fromL.findIndex((s) => s.includes('E'))
      assert.ok(states.includes('L') && firstE > 0, `placeholder then editor, got ${states.join(' → ')}`)
      assert.ok(!fromL.slice(0, firstE).includes('N'), `editor-loading stayed visible until .cm-editor appeared, got ${states.join(' → ')}`)

      const text = await page.locator('.cm-editor:visible .cm-content').first().innerText()
      assert.ok(text.includes(marker), `.cm-content shows the doc text, got: ${text.slice(0, 200)}`)
      assert.ok(text.includes('Paragraph 1 of Click to edit.'), '.cm-content shows the doc body')
    } finally { await context.close() }
  })
})

// ── AC-06.3 ────────────────────────────────────────────────────────────────
describe('#6 lazy editor — viewers and non-doc pages never load the editor', () => {
  let doc, oldHash
  before(async () => {
    const md = (v) => plainDoc('Viewer doc', `Viewer body v${v} (AC-06.3).`, 80)
    doc = await createDoc({ markdown: md(1), filename: 'viewer.md', sessionName: uniq('Viewer doc'), author: 'Alice' })
    await putMarkdown(doc.id, md(2), { author: 'Bob' })
    const revs = await listRevisions(doc.id)
    oldHash = revs.revisions.find((r) => r.hash !== revs.current)?.hash
    assert.match(oldHash ?? '', /^[0-9a-f]{32}$/, 'an older revision exists')
  })

  async function expectNoEditor(path, ready) {
    const { context, page, rec } = await open()
    try {
      await page.goto(`${BASE}${path}`)
      await ready(page)
      await rec.quiet()
      await scrollWholePage(page)
      await rec.quiet()
      assert.deepEqual(rec.editor(), [], `${path} requested editor modules:\n  ${list(rec.editor())}`)
      assert.equal(await page.locator('.cm-editor').count(), 0, `${path}: no editor DOM`)
    } finally { await context.close() }
  }

  it('AC-06.3 a viewer (pinned revision /d/<id>@<hash>) scrolling the whole doc makes no editor request', T, async () => {
    await expectNoEditor(`/d/${doc.id}@${oldHash}`, (p) => waitForDoc(p, 'Viewer body v1 (AC-06.3).'))
  })

  it('AC-06.3 ?embed=1 scrolling the whole doc makes no editor request', T, async () => {
    await expectNoEditor(`/d/${doc.id}?embed=1`, (p) => waitForDoc(p, 'Viewer body v2 (AC-06.3).'))
  })

  it('AC-06.3 the landing page / makes no editor request', T, async () => {
    await expectNoEditor('/', async (p) => {
      await p.waitForLoadState('load')
      await p.locator('#app *').first().waitFor({ state: 'attached', timeout: 10_000 })
    })
  })

  it('AC-06.3 the library /library makes no editor request', T, async () => {
    await expectNoEditor('/library', async (p) => {
      await p.waitForLoadState('load')
      await p.locator('#app *').first().waitFor({ state: 'attached', timeout: 10_000 })
    })
  })
})

// ── AC-06.4 ────────────────────────────────────────────────────────────────
describe('#6 lazy editor — ?view=edit', () => {
  it('AC-06.4 an editor opening /d/<id>?view=edit gets the editor without any interaction, and it is editable', T, async () => {
    const marker = 'Deep link edit marker (AC-06.4).'
    const doc = await createDoc({ markdown: plainDoc('Deep edit', marker, 10), filename: 'deep.md', sessionName: uniq('Deep edit') })
    const { context, page, rec } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}?view=edit`)
      await waitEditorMounted(page)
      assert.ok(rec.editor().length > 0, 'the editor was requested')
      const content = page.locator('.cm-editor:visible .cm-content').first()
      assert.equal(await content.getAttribute('contenteditable'), 'true', '.cm-content is contenteditable')
      assert.ok((await content.innerText()).includes(marker), 'editor shows the doc')
      await content.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' TYPED-06.4')
      await page.waitForFunction(() => document.querySelector('.cm-editor .cm-content')?.textContent.includes('TYPED-06.4'), null, { timeout: 3000 })
    } finally { await context.close() }
  })
})

// ── AC-06.5 ────────────────────────────────────────────────────────────────
describe('#6 lazy editor — intent prefetch', () => {
  it('AC-06.5 hovering view-toggle-edit fetches the editor once; the click afterwards fetches nothing more', T, async () => {
    const marker = 'Hover prefetch marker (AC-06.5).'
    const doc = await createDoc({ markdown: plainDoc('Hover', marker, 10), filename: 'hover.md', sessionName: uniq('Hover') })
    const { context, page, rec } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, marker)
      await rec.quiet()
      assert.deepEqual(rec.editor(), [], `precondition: no editor request before the hover:\n  ${list(rec.editor())}`)

      const edit = await toggle(page, 'edit')
      await edit.hover()
      // Wait for the prefetch to be requested and to settle.
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (rec.editor().length === 0 || rec.pendingEditor() > 0)) await page.waitForTimeout(50)
      await rec.quiet()
      const afterHover = rec.editor()
      assert.ok(afterHover.length > 0, 'hover (no click) requested the editor')
      const dupes = afterHover.filter((u, i) => afterHover.indexOf(u) !== i)
      assert.deepEqual(dupes, [], `each editor module requested once on hover:\n  ${list(afterHover)}`)
      const paneModule = afterHover.filter((u) => EDITOR_PANE_PATH.test(new URL(u).pathname) && !/[?&]type=style/.test(u))
      assert.equal(paneModule.length, 1, `exactly one EditorPane chunk/module request:\n  ${list(afterHover)}`)

      await edit.click()
      await waitEditorMounted(page)
      await rec.quiet()
      const afterClick = rec.editor()
      assert.deepEqual(afterClick, afterHover, `the click made no further editor request:\n  ${list(afterClick.slice(afterHover.length))}`)
    } finally { await context.close() }
  })
})

// ── AC-06.6 ────────────────────────────────────────────────────────────────
describe('#6 lazy editor — load failure', () => {
  it('AC-06.6 a 404 for the editor chunk shows editor-load-error + retry, read view still works, retry mounts after un-blocking', T, async () => {
    const marker = 'Load failure marker (AC-06.6).'
    const doc = await createDoc({ markdown: plainDoc('Failure', marker, 10), filename: 'fail.md', sessionName: uniq('Failure') })
    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${doc.id}`)
      await waitForDoc(page, marker)
      const readText = await page.locator('.preview-pane').first().innerText()

      const blocked = (u) => EDITOR_PANE_PATH.test(u.pathname)
      const notFound = (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found (AC-06.6)' })
      await page.route(blocked, notFound)

      await (await toggle(page, 'edit')).click()
      const err = page.locator('[data-testid="editor-load-error"]')
      await err.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await err.innerText(), /Couldn['’]t load the editor/, 'error message')
      await page.locator('[data-testid="editor-load-retry"]').waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await page.locator('.cm-editor:visible').count(), 0, 'no editor mounted')

      await (await toggle(page, 'read')).click()
      const pane = page.locator('.preview-pane').first()
      await pane.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await pane.innerText(), readText, 'the rendered doc text is unchanged')
      assert.equal(await err.isVisible(), false, 'the error is not shown in read view')

      // Back to edit while still blocked: the error (and retry) again.
      await (await toggle(page, 'edit')).click()
      await err.waitFor({ state: 'visible', timeout: 15_000 })
      const retry = page.locator('[data-testid="editor-load-retry"]')
      await retry.waitFor({ state: 'visible', timeout: 5000 })

      await page.unroute(blocked, notFound)
      await retry.click()
      await waitEditorMounted(page)
      const text = await page.locator('.cm-editor:visible .cm-content').first().innerText()
      assert.ok(text.includes(marker), 'the retried editor shows the doc')
      assert.equal(await err.isVisible(), false, 'error gone after a successful retry')
    } finally { await context.close() }
  })
})

// ── AC-06.9 / rule 5 ───────────────────────────────────────────────────────
describe('#6 lazy editor — warm path', () => {
  /** Click the edit toggle in-page and time until a visible .cm-editor exists (ms), plus whether it is the marked instance. */
  const timeEditSwitch = (page) => page.evaluate(() => new Promise((resolveP) => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const btn = document.querySelector('[data-testid="view-toggle-edit"]') ||
      [...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Edit')
    const t0 = performance.now()
    btn.click()
    const tick = () => {
      const e = [...document.querySelectorAll('.cm-editor')].find(vis)
      if (e) return resolveP({ ms: performance.now() - t0, same: e.__mdrKeep === true })
      if (performance.now() - t0 > 5000) return resolveP({ ms: Infinity, same: false })
      requestAnimationFrame(tick)
    }
    tick()
  }))

  async function toRead(page) {
    await (await toggle(page, 'read')).click()
    await page.locator('.preview-pane').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => ![...document.querySelectorAll('.cm-editor')].some((el) => el.getClientRects().length > 0), null, { timeout: 5000 })
  }

  async function warmEditor() {
    const marker = 'Warm path marker (AC-06.9).'
    const doc = await createDoc({ markdown: plainDoc('Warm', marker, 10), filename: 'warm.md', sessionName: uniq('Warm') })
    const o = await open()
    await o.page.goto(`${BASE}/d/${doc.id}`)
    await waitForDoc(o.page, marker)
    await (await toggle(o.page, 'edit')).click()
    await waitEditorMounted(o.page)
    await o.rec.quiet()
    return o
  }

  it('AC-06.9 edit → read → edit: the second switch makes no editor request and shows .cm-editor within 100 ms', T, async () => {
    const { context, page, rec } = await warmEditor()
    try {
      const before = rec.editor()
      const times = []
      // The second switch, then two more identical round trips; the median
      // keeps one scheduler hiccup on a loaded box from deciding the result.
      for (let i = 0; i < 3; i++) {
        await toRead(page)
        const { ms } = await timeEditSwitch(page)
        times.push(Math.round(ms))
        await rec.quiet({ idle: 200 })
      }
      assert.deepEqual(rec.editor(), before, `no editor request on the warm switch:\n  ${list(rec.editor().slice(before.length))}`)
      const median = [...times].sort((a, b) => a - b)[1]
      assert.ok(Number.isFinite(times[0]), 'the editor came back')
      assert.ok(median <= 100, `warm read → edit shows .cm-editor within 100 ms (times ${times.join(', ')} ms, median ${median})`)
    } finally { await context.close() }
  })

  it('AC-06.9 / rule 5 the editor instance is kept alive (hidden, not unmounted) across read ↔ edit', T, async () => {
    const { context, page } = await warmEditor()
    try {
      await page.evaluate(() => { document.querySelector('.cm-editor').__mdrKeep = true })
      await toRead(page)
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.cm-editor')].some((e) => e.__mdrKeep === true)),
        'the editor DOM still exists (hidden) in read view')
      const { same } = await timeEditSwitch(page)
      assert.equal(same, true, 'the same editor instance is shown again (not re-created)')
    } finally { await context.close() }
  })
})

// ── AC-06.10 ───────────────────────────────────────────────────────────────
describe('#6 lazy editor — editor behaviour unchanged once mounted', () => {
  async function serverMarkdown(id) {
    const res = await fetch(`${API}/paste/${id}/markdown`)
    return (await res.json()).markdown
  }

  async function waitServerHas(id, text, timeout) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if ((await serverMarkdown(id)).includes(text)) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  /** Is the .cm-line containing `text` inside the window and inside every scrolling ancestor? */
  const lineInView = (page, text) => page.evaluate((t) => {
    const line = [...document.querySelectorAll('.cm-editor .cm-line')].find((l) => l.textContent.includes(t))
    if (!line) return false
    const r = line.getBoundingClientRect()
    if (r.height === 0 || r.bottom <= 0 || r.top >= innerHeight) return false
    for (let p = line.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY
      if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') {
        const pr = p.getBoundingClientRect()
        if (r.bottom <= pr.top || r.top >= pr.bottom) return false
      }
    }
    return true
  }, text)

  it('AC-06.10 after the lazy mount: typing autosaves, Ctrl+S saves at once, and a comment\'s scroll-to scrolls the editor (review doc)', T, async () => {
    const lines = ['# Scroll doc', '']
    for (let i = 1; lines.length < 240; i++) lines.push(`Filler line ${i} (AC-06.10).`, '')
    const FAR = 'FAR TARGET LINE AC-06.10'
    lines[160] = FAR
    const markdown = lines.join('\n')
    const res = await fetch(`${API}/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown, filename: 'scroll.md', sessionName: uniq('Scroll doc'), mode: 'review', sharedAt: new Date().toISOString(),
        comments: [{ id: 'c-far-0610', startLine: 160, endLine: 161, selectedText: FAR, body: 'Far comment 06.10', category: 'suggestion', createdAt: Date.now(), replies: [] }],
      }),
    })
    assert.ok(res.ok, `POST /paste ${res.status}`)
    const { id } = await res.json()

    const { context, page } = await open()
    try {
      await page.goto(`${BASE}/d/${id}`)
      await waitForDoc(page, 'Filler line 1 (AC-06.10).')
      await (await toggle(page, 'edit')).click()
      await waitEditorMounted(page)
      const content = page.locator('.cm-editor:visible .cm-content').first()

      // Typing → idle autosave reaches the server.
      await content.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nAUTOSAVED 06.10')
      assert.ok(await waitServerHas(id, 'AUTOSAVED 06.10', 10_000), 'autosave reached the server')

      // Ctrl+S flushes at once — well before the ~2 s idle autosave would.
      await page.keyboard.type('\n\nCTRL-S 06.10')
      await page.keyboard.press('Control+s')
      assert.ok(await waitServerHas(id, 'CTRL-S 06.10', 1500), 'Ctrl+S saved immediately')

      // Comment "scroll to" in edit view moves the editor to the comment's line.
      await page.keyboard.press('Control+Home')
      await page.waitForFunction((t) => {
        const l = [...document.querySelectorAll('.cm-editor .cm-line')].find((x) => x.textContent.includes(t))
        if (!l) return true
        const r = l.getBoundingClientRect()
        return r.top >= innerHeight || r.bottom <= 0
      }, FAR, { timeout: 5000 })
      assert.equal(await lineInView(page, FAR), false, 'precondition: the far line is off screen')
      await page.locator('.comment-card', { hasText: 'Far comment 06.10' }).first().click()
      const deadline = Date.now() + 3000
      let inView = false
      while (Date.now() < deadline && !(inView = await lineInView(page, FAR))) await page.waitForTimeout(50)
      assert.ok(inView, 'clicking the comment scrolled the editor to its line')
    } finally { await context.close() }
  })
})

// ── AC-06.11 ───────────────────────────────────────────────────────────────
describe('#6 lazy editor — typing while the editor loads', () => {
  it('AC-06.11 ?filePath= fixture: keys typed after the editor mounts land in the doc, keys typed while loading corrupt nothing', T, async () => {
    const original = readFileSync(FIXTURE, 'utf-8')
    const DURING = 'qzqzqz'
    const AFTER = '\n\nAFTER-MOUNT-06.11'
    // Tall viewport: the whole 55-line fixture is rendered, so .cm-line text is the whole doc.
    const { context, page } = await open({ viewport: { width: 1400, height: 2200 } })
    try {
      await page.goto(FILE_URL)
      await waitForDoc(page, 'This is a paragraph for testing inline comments.')
      const hold = await holdEditorChunk(page)

      await (await toggle(page, 'edit')).click()
      await page.locator('[data-testid="editor-loading"]').waitFor({ state: 'visible', timeout: 10_000 })
      await page.keyboard.type(DURING)

      hold.release()
      await waitEditorMounted(page)
      // Rule 3: focus moves into the editor once it mounts (no click needed).
      await page.waitForFunction(() => !!document.activeElement?.closest('.cm-editor'), null, { timeout: 3000 })
        .catch(() => assert.fail('focus did not move into the editor after it mounted'))
      await page.keyboard.press('Control+End')
      await page.keyboard.type(AFTER)

      await page.waitForFunction((t) => document.querySelector('.cm-editor .cm-content')?.textContent.includes(t), AFTER.trim(), { timeout: 3000 })
        .catch(() => {})
      const { text, gaps } = await page.evaluate(() => ({
        text: [...document.querySelectorAll('.cm-editor .cm-content .cm-line')].map((l) => l.textContent).join('\n'),
        gaps: document.querySelectorAll('.cm-editor .cm-gap').length,
      }))
      assert.equal(gaps, 0, 'the whole doc is rendered (no virtualised gaps)')
      assert.ok(text.includes(AFTER.trim()), 'keys typed after mount are in the doc')
      // Keys typed during loading may be dropped or kept, but only whole and contiguous.
      assert.equal(text.replace(DURING, ''), original + AFTER, 'the doc is the fixture plus what was typed — nothing corrupted')
    } finally { await context.close() }
  })
})
