// #10 Paste / drop image → upload as attachment — acceptance tests
// (docs/build/specs/10-paste-image.md, 00 §3.1 AppToast, §3.4 Esc, §3.6 undo).
//
// Images are put on a synthetic clipboard / drag payload: a DataTransfer holding File objects,
// dispatched as one ClipboardEvent('paste') or DragEvent('drop') on the visible editor — what a
// real Ctrl/Cmd+V or drop delivers. Uploads go to the throwaway backend (E2E_API_URL); delays
// and failures are injected with page.route on `/paste/*/files`.
//
// Shared docs are protected (#23) and opened with ?edit=<token>, so the upload must carry
// X-Edit-Token (rule 5). The editor's text is read from its rendered `.cm-line`s (short docs).
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { BASE, API } from '../helpers.mjs'
import { createDoc, uniq } from '../lib/docs.mjs'

const T = { timeout: 60_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'
const NAME_RE = /^assets\/\d{8}-\d{6}-[0-9a-f]{6}\.png$/
const ELL = '…'

// ── a real PNG (so the preview can decode it: naturalWidth > 0) ─────────────
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit greyscale
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
const SMALL_PNG = png(8, 8).toString('base64')
const WIDE_PNG = png(2400, 20).toString('base64')

let browser
let tmp
before(async () => {
  browser = await chromium.launch({ headless: true })
  tmp = mkdtempSync(join(tmpdir(), 'md-review-ac10-'))
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
  const uploads = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/paste\/[^/]+\/files$/.test(new URL(r.url()).pathname)) {
      let body = null
      try { body = JSON.parse(r.postData() || 'null') } catch { /* not json */ }
      uploads.push({ url: r.url(), headers: r.headers(), body })
    }
  })
  const creates = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/paste') creates.push(r.url())
  })
  return { context, page, errors, uploads, creates }
}

let fileSeq = 0
function localDocUrl(text) {
  const p = join(tmp, `img-${++fileSeq}.md`)
  writeFileSync(p, text)
  return `${BASE}/?filePath=${encodeURIComponent(p)}`
}

const editorContent = (page) => page.locator('.cm-editor:visible .cm-content').first()

async function toEdit(page) {
  if (await page.locator('.cm-editor:visible .cm-content').count()) return
  await page.locator(tid('view-toggle-edit')).first().click()
  await editorContent(page).waitFor({ state: 'visible', timeout: 20_000 })
}

async function toRead(page) {
  await page.locator(tid('view-toggle-read')).first().click()
  await page.locator('.preview-pane, .html-frame').first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function editorText(page) {
  return page.evaluate(() => {
    const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
    if (!ed) return null
    return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')
  })
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

async function waitEditorText(page, pred, message, timeout = 8000) {
  let seen
  try {
    await until(async () => { seen = await editorText(page); return seen !== null && pred(seen) }, { timeout, message })
  } catch (e) {
    throw new assert.AssertionError({ message: `${e.message}\n  editor text: ${JSON.stringify(seen)}` })
  }
  return seen
}

/** Open a protected shared doc with its edit link, in edit view, caret at the end. */
async function openShared(page, markdown, { contentType } = {}) {
  const doc = await createDoc({ markdown, filename: contentType === 'html' ? 'page.html' : 'doc.md', sessionName: uniq('Img'), contentType, protected: true })
  await page.goto(`${BASE}/d/${doc.id}?edit=${doc.editToken}`)
  await page.locator('.preview-pane, .html-frame, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
  await toEdit(page)
  await caretToEnd(page)
  return doc
}

async function openLocal(page, text) {
  await page.goto(localDocUrl(text))
  await page.locator('.preview-pane, .cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
  await toEdit(page)
  await caretToEnd(page)
}

async function caretToEnd(page) {
  await editorContent(page).click()
  await page.keyboard.press(`${MOD}+End`)
}

/**
 * Paste files (and optional text/plain) into the visible editor. Each file:
 * { name, type, b64 } or { name, type, size } (zero-filled bytes of that size).
 */
async function pasteFiles(page, files, text = '') {
  await editorContent(page).evaluate((el, { files, text }) => {
    const dt = new DataTransfer()
    for (const f of files) {
      const bytes = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : new Uint8Array(f.size)
      dt.items.add(new File([bytes], f.name, { type: f.type }))
    }
    if (text) dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, { files, text })
}

/** Drop files onto the visible editor at the left edge of its last line. */
async function dropFilesOnLastLine(page, files) {
  await editorContent(page).evaluate((el, files) => {
    const lines = el.querySelectorAll('.cm-line')
    const r = lines[lines.length - 1].getBoundingClientRect()
    const dt = new DataTransfer()
    for (const f of files) {
      const bytes = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : new Uint8Array(f.size)
      dt.items.add(new File([bytes], f.name, { type: f.type }))
    }
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + r.height / 2 }
    el.dispatchEvent(new DragEvent('dragenter', opts))
    el.dispatchEvent(new DragEvent('dragover', opts))
    el.dispatchEvent(new DragEvent('drop', opts))
  }, files)
}

const shot = (name = 'shot.png', b64 = SMALL_PNG) => ({ name, type: 'image/png', b64 })

/** Delay every upload response by `ms` (the request still reaches the backend). */
async function delayUploads(page, ms) {
  await page.route(/\/paste\/[^/]+\/files$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const resp = await route.fetch()
    await new Promise((r) => setTimeout(r, ms))
    await route.fulfill({ response: resp })
  })
}

const toasts = (page) => page.locator(`${tid('app-toast')}:visible`)
async function waitToast(page, kind, ...needles) {
  const loc = page.locator(`${tid('app-toast')}[data-kind="${kind}"]`).filter({ hasText: needles[0] })
  await loc.first().waitFor({ state: 'visible', timeout: 8000 })
  const text = await loc.first().textContent()
  for (const n of needles) assert.ok(text.includes(n), `toast text ${JSON.stringify(text)} includes ${JSON.stringify(n)}`)
  return loc.first()
}

const FINAL_RE = (alt) => new RegExp(`!\\[${alt}\\]\\((https?://[^)]+/paste/[^/]+/files/assets/\\d{8}-\\d{6}-[0-9a-f]{6}\\.png)\\)`)

// ── paste ───────────────────────────────────────────────────────────────────
describe('#10 paste image — shared doc', () => {
  it('AC-10.1 a pasted PNG uploads as assets/… (base64, edit token) and becomes ![shot](<absolute url>) at the cursor', T, async () => {
    const { context, page, uploads, errors } = await open()
    try {
      const pre = '# Paste\n\nIntro line\n\n'
      const doc = await openShared(page, pre)
      await pasteFiles(page, [shot()])
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the final image markdown')
      assert.equal(uploads.length, 1, 'exactly one upload request')
      const up = uploads[0]
      assert.match(up.body.name, NAME_RE, 'stored name')
      assert.equal(up.body.encoding, 'base64')
      assert.equal(up.body.content, SMALL_PNG, 'the bytes, base64')
      assert.equal(new URL(up.url).pathname, `/paste/${doc.id}/files`, 'posted to the canonical id')
      assert.equal(up.headers['x-edit-token'], doc.editToken, 'X-Edit-Token sent (rule 5)')
      const url = text.match(FINAL_RE('shot'))[1]
      assert.equal(url, new URL(`/paste/${doc.id}/files/${up.body.name}`, API).href, 'absolute URL on the API origin (rule 6)')
      assert.equal(text, `${pre}![shot](${url})`, 'inserted exactly at the cursor')
      const res = await fetch(url)
      assert.equal(res.status, 200, 'the inserted URL serves the image')
      assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), SMALL_PNG)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })

  it('AC-10.2 with a 2 s upload the placeholder ![Uploading shot…]() is there within 200 ms, then the final markdown', T, async () => {
    const { context, page } = await open()
    try {
      await openShared(page, '# Slow\n\n')
      await delayUploads(page, 2000)
      const t0 = Date.now()
      await pasteFiles(page, [shot()])
      const placeholder = `![Uploading shot${ELL}]()`
      await waitEditorText(page, (t) => t.includes(placeholder), 'the placeholder', 1000)
      assert.ok(Date.now() - t0 < 400, `placeholder shown after ${Date.now() - t0} ms (≤ 200 ms + driver overhead)`)
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the final markdown', 10_000)
      assert.ok(!text.includes('Uploading'), 'no Uploading text left')
    } finally { await context.close() }
  })

  it('AC-10.3 typing above the placeholder during the upload: the final markdown replaces exactly the placeholder', T, async () => {
    const { context, page } = await open()
    try {
      await openShared(page, '# Title\n\nabove\n\n')
      await delayUploads(page, 2000)
      await pasteFiles(page, [shot()])
      await waitEditorText(page, (t) => t.includes(`![Uploading shot${ELL}]()`), 'the placeholder')
      await page.locator('.cm-editor:visible .cm-line', { hasText: 'above' }).first().click()
      await page.keyboard.press('End')
      await page.keyboard.type('XXXXX')
      await waitEditorText(page, (t) => t.includes('aboveXXXXX'), 'typed text')
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the final markdown', 10_000)
      const url = text.match(FINAL_RE('shot'))[1]
      assert.equal(text, `# Title\n\naboveXXXXX\n\n![shot](${url})`)
    } finally { await context.close() }
  })

  it('AC-10.4 a 500 {error:"disk full"} removes the placeholder (doc = pre-paste) and shows an error toast', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Fail\n\n'
      await openShared(page, pre)
      await page.route(/\/paste\/[^/]+\/files$/, (route) => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) })
        : route.continue())
      await pasteFiles(page, [shot()])
      await waitToast(page, 'error', "Couldn't upload shot", 'disk full')
      await waitEditorText(page, (t) => t === pre, 'the pre-paste text')
      // Not in history: undo does not bring the placeholder back.
      await page.keyboard.press(`${MOD}+z`)
      await new Promise((r) => setTimeout(r, 300))
      assert.ok(!(await editorText(page)).includes('Uploading'), 'undo never reveals the placeholder')
    } finally { await context.close() }
  })

  it('AC-10.5 one Ctrl/Cmd+Z after a successful paste returns to the pre-paste text (no placeholder)', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Undo\n\ntext '
      await openShared(page, pre)
      await pasteFiles(page, [shot()])
      await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the final markdown')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'one undo → the pre-paste text')
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(await editorText(page), pre, 'stays at the pre-paste text (nothing re-inserted)')
      // Redo brings the final image back in one step.
      await page.keyboard.press(`${MOD}+Shift+z`)
      await waitEditorText(page, (t) => FINAL_RE('shot').test(t) && !t.includes('Uploading'), 'redo → the final markdown')
    } finally { await context.close() }
  })

  it('AC-10.7 an 11 MB PNG: no request, nothing inserted, error toast "larger than 10 MB"', T, async () => {
    const { context, page, uploads } = await open()
    try {
      const pre = '# Big\n\n'
      await openShared(page, pre)
      await pasteFiles(page, [{ name: 'huge.png', type: 'image/png', size: 11 * 1024 * 1024 }])
      await waitToast(page, 'error', 'larger than 10 MB')
      assert.ok((await toasts(page).allTextContents()).some((t) => t.includes('huge.png')), 'the toast names the file')
      assert.equal(await editorText(page), pre, 'nothing inserted')
      assert.equal(uploads.length, 0, 'no upload request')
    } finally { await context.close() }
  })

  it('AC-10.9 a clipboard with image/png AND text/plain TSV pastes as text (no upload)', T, async () => {
    const { context, page, uploads } = await open()
    try {
      await openShared(page, '# Sheet\n\n')
      await pasteFiles(page, [shot('image.png')], 'a\tb\nc\td')
      const text = await waitEditorText(page, (t) => t.includes('a') && t.includes('d') && t.length > '# Sheet\n\n'.length, 'the text paste')
      await new Promise((r) => setTimeout(r, 500))
      assert.equal(uploads.length, 0, 'no upload')
      assert.ok(!text.includes('!['), 'no image markup')
    } finally { await context.close() }
  })

  it('AC-10.16 an error toast is role=alert, closes with app-toast-close, else disappears after ~8 s', { timeout: 60_000 }, async () => {
    const { context, page } = await open()
    try {
      await openShared(page, '# Toast\n\n')
      await page.route(/\/paste\/[^/]+\/files$/, (route) => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) })
        : route.continue())
      await page.mouse.move(5, 5)
      await pasteFiles(page, [shot()])
      const t1 = await waitToast(page, 'error', "Couldn't upload shot")
      assert.equal(await t1.getAttribute('role'), 'alert')
      await t1.locator(tid('app-toast-close')).click()
      await until(async () => (await page.locator(tid('app-toast')).filter({ hasText: "Couldn't upload" }).count()) === 0, { message: 'toast closed' })

      await editorContent(page).focus()
      await page.mouse.move(5, 5)
      await pasteFiles(page, [shot()])
      await waitToast(page, 'error', "Couldn't upload shot")
      const shownAt = Date.now()
      await new Promise((r) => setTimeout(r, 6000))
      assert.equal(await page.locator(tid('app-toast')).filter({ hasText: "Couldn't upload" }).count(), 1, 'still shown at ~6 s')
      await until(async () => (await page.locator(tid('app-toast')).filter({ hasText: "Couldn't upload" }).count()) === 0, { timeout: 5000, message: 'auto-dismiss at ~8 s' })
      const gone = Date.now() - shownAt
      assert.ok(gone >= 7000 && gone <= 10_500, `dismissed after ${gone} ms`)
    } finally { await context.close() }
  })
})

// ── drop ────────────────────────────────────────────────────────────────────
describe('#10 drop images', () => {
  it('AC-10.6 three dropped images land at the drop position in order, one blank line apart; one undo removes all three', T, async () => {
    const { context, page, uploads } = await open()
    try {
      const pre = '# Drop\n\nintro\n\n'
      await openShared(page, pre)
      await page.keyboard.press(`${MOD}+Home`) // the caret is elsewhere: the drop point decides
      await dropFilesOnLastLine(page, [shot('a.png'), shot('b.png'), shot('c.png')])
      const re = /^# Drop\n\nintro\n\n!\[a\]\((\S+)\)\n\n!\[b\]\((\S+)\)\n\n!\[c\]\((\S+)\)$/
      const text = await waitEditorText(page, (t) => re.test(t), 'three images in drop order', 15_000)
      assert.equal(uploads.length, 3)
      const urls = text.match(re).slice(1)
      assert.equal(new Set(urls).size, 3, 'three distinct uploads')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'one undo removes all three')
    } finally { await context.close() }
  })

  it('AC-10.8 dropping .bmp + .txt + .png: only the PNG uploads; toasts name the unsupported type and the skipped file', T, async () => {
    const { context, page, uploads } = await open()
    try {
      const pre = '# Mixed\n\n'
      await openShared(page, pre)
      await dropFilesOnLastLine(page, [
        { name: 'old.bmp', type: 'image/bmp', b64: SMALL_PNG },
        { name: 'notes.txt', type: 'text/plain', b64: btoa('hello') },
        shot('good.png'),
      ])
      const text = await waitEditorText(page, (t) => FINAL_RE('good').test(t), 'the PNG inserted')
      assert.equal(uploads.length, 1, 'one upload')
      assert.match(uploads[0].body.name, NAME_RE)
      assert.ok(!text.includes('old') && !text.includes('notes'), 'nothing else inserted')
      await waitToast(page, 'error', 'Unsupported image type: old.bmp')
      await waitToast(page, 'info', 'Skipped 1 non-image file(s)')
    } finally { await context.close() }
  })
})

// ── unshared doc ────────────────────────────────────────────────────────────
describe('#10 unshared doc → share first', () => {
  it('AC-10.10 pasting into an unshared doc opens share-required-dialog, sends nothing; Cancel (and Esc) leave the doc unchanged', T, async () => {
    const { context, page, uploads, creates } = await open()
    try {
      const pre = '# Local\n\nbody\n'
      await openLocal(page, pre)
      const before = await editorText(page)
      await pasteFiles(page, [shot()])
      const dialog = page.locator(tid('share-required-dialog'))
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await dialog.textContent(), /Images are stored with the shared document\. Share it to add images\./)
      assert.equal(await editorText(page), before, 'doc unchanged (no placeholder)')
      await page.locator(tid('share-required-cancel')).click()
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
      assert.equal(await editorText(page), before, 'doc unchanged after Cancel')

      await editorContent(page).focus()
      await pasteFiles(page, [shot()])
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(await editorText(page), before, 'doc unchanged after Esc')
      assert.equal(uploads.length, 0, 'no /files request')
      assert.equal(creates.length, 0, 'no share created')
    } finally { await context.close() }
  })

  it('AC-10.11 Share and insert: POST /paste creates the share, the image uploads to the new id, markdown lands at the paste position', T, async () => {
    const { context, page, uploads, creates } = await open()
    try {
      const pre = '# Local share\n\nfirst\n\nlast line'
      await openLocal(page, pre)
      // Caret after "first" (mid-doc): that is the paste position.
      await page.locator('.cm-editor:visible .cm-line', { hasText: 'first' }).first().click()
      await page.keyboard.press('End')
      await pasteFiles(page, [shot()])
      await page.locator(tid('share-required-dialog')).waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(tid('share-required-confirm')).click()
      await until(() => creates.length === 1, { message: 'POST /paste', timeout: 10_000 })
      await until(() => uploads.length === 1, { message: 'the upload', timeout: 10_000 })
      const id = new URL(uploads[0].url).pathname.split('/')[2]
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the final markdown', 15_000)
      const url = text.match(FINAL_RE('shot'))[1]
      assert.equal(text, `# Local share\n\nfirst![shot](${url})\n\nlast line`, 'inserted at the original paste position')
      assert.ok(url.includes(`/paste/${id}/files/`), 'URL on the new doc id')
      assert.ok(uploads[0].headers['x-edit-token'], 'the new doc\'s edit token is sent')
    } finally { await context.close() }
  })
})

// ── viewers and HTML docs ───────────────────────────────────────────────────
describe('#10 rendering', () => {
  it('AC-10.12 a viewer (fresh context) sees the image at desktop and phone width, within the preview width', { timeout: 90_000 }, async () => {
    const { context, page } = await open()
    let doc, url
    try {
      doc = await openShared(page, '# Viewer\n\n')
      await pasteFiles(page, [shot('wide.png', WIDE_PNG)])
      const text = await waitEditorText(page, (t) => FINAL_RE('wide').test(t), 'the final markdown')
      url = text.match(FINAL_RE('wide'))[1]
      await until(async () => {
        const r = await fetch(`${API}/paste/${doc.id}/markdown`)
        return r.ok && (await r.json()).markdown.includes(url)
      }, { timeout: 15_000, message: 'autosave of the image markdown' })
    } finally { await context.close() }

    for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
      const v = await open({ viewport })
      try {
        await v.page.goto(`${BASE}/d/${doc.id}`)
        const img = v.page.locator('.preview-pane img').first()
        await img.waitFor({ state: 'visible', timeout: 20_000 })
        await until(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), { timeout: 10_000, message: 'image decoded' })
        const m = await img.evaluate((el) => {
          const pane = el.closest('.preview-pane')
          const cs = getComputedStyle(pane)
          const content = pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
          return { src: el.getAttribute('src'), natural: el.naturalWidth, width: el.getBoundingClientRect().width, content, pageScroll: document.documentElement.scrollWidth - window.innerWidth }
        })
        assert.equal(m.src, url, `${viewport.width}: src equals the inserted URL`)
        assert.ok(m.natural > 0)
        assert.ok(m.width <= m.content + 0.5, `${viewport.width}: image ${m.width}px within preview content ${m.content}px`)
        assert.ok(m.pageScroll <= 1, `${viewport.width}: no horizontal page scroll`)
      } finally { await v.context.close() }
    }
  })

  it('AC-10.13 an html doc gets <img src="<url>" alt="shot"> and it renders inside the HTML preview iframe', { timeout: 90_000 }, async () => {
    const { context, page } = await open()
    try {
      const pre = '<!doctype html>\n<html><body>\n<p>Hi</p>\n'
      const post = '</body></html>'
      await openShared(page, pre + post, { contentType: 'html' })
      await page.locator('.cm-editor:visible .cm-line', { hasText: '<p>Hi</p>' }).first().click()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      const at = await editorText(page)
      await pasteFiles(page, [shot()])
      const re = /<img src="(https?:\/\/[^"]+\/files\/assets\/\d{8}-\d{6}-[0-9a-f]{6}\.png)" alt="shot">/
      const text = await waitEditorText(page, (t) => re.test(t), 'the <img> tag')
      const url = text.match(re)[1]
      assert.ok(!text.includes('![shot]'), 'no markdown image syntax in an html doc')
      assert.equal(text.replace(text.match(re)[0], ''), at, 'only the tag was inserted')
      await toRead(page)
      const iframe = page.locator('.html-frame').first()
      await iframe.waitFor({ state: 'visible', timeout: 10_000 })
      await until(async () => {
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue
          try {
            const ok = await f.evaluate((u) => [...document.images].some((i) => i.getAttribute('src') === u && i.complete && i.naturalWidth > 0), url)
            if (ok) return true
          } catch { /* frame navigating */ }
        }
        return false
      }, { timeout: 15_000, message: 'the image decoded inside the HTML preview iframe' })
    } finally { await context.close() }
  })
})

// ── undo edge cases (review round) ──────────────────────────────────────────
describe('#10 undo edge cases', () => {
  const OTHER_PNG = png(9, 9).toString('base64')

  /** Delay only the uploads whose bytes are `b64`. */
  async function delayUploadOf(page, b64, ms) {
    await page.route(/\/paste\/[^/]+\/files$/, async (route) => {
      const req = route.request()
      if (req.method() !== 'POST') return route.continue()
      let body = null
      try { body = JSON.parse(req.postData() || 'null') } catch { /* not json */ }
      const resp = await route.fetch()
      if (body?.content === b64) await new Promise((r) => setTimeout(r, ms))
      await route.fulfill({ response: resp })
    })
  }

  it('pasting over a selection: the image replaces it, and one undo restores the selected text', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Sel\n\nhello SEL world'
      await openShared(page, pre)
      await page.keyboard.press('End')
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
      await pasteFiles(page, [shot()])
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the final markdown')
      const url = text.match(FINAL_RE('shot'))[1]
      assert.equal(text, `# Sel\n\nhello ![shot](${url}) world`)
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'one undo → the pre-paste text, selection back')
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(await editorText(page), pre)
    } finally { await context.close() }
  })

  it('a failed upload over a selection puts the selected text back', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Sel fail\n\nhello SEL world'
      await openShared(page, pre)
      await page.route(/\/paste\/[^/]+\/files$/, (route) => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
        : route.continue())
      await page.keyboard.press('End')
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
      await pasteFiles(page, [shot()])
      await waitToast(page, 'error', "Couldn't upload shot", 'boom')
      await waitEditorText(page, (t) => t === pre, 'the pre-paste text')
    } finally { await context.close() }
  })

  it('undo mid-upload (one upload done, one pending): pre-paste text; the late upload inserts nothing; redo brings both images', T, async () => {
    const { context, page, uploads } = await open()
    try {
      const pre = '# Mid\n\n'
      await openShared(page, pre)
      await delayUploadOf(page, OTHER_PNG, 2500)
      const firstDone = page.waitForResponse((r) => r.request().method() === 'POST' && /\/files$/.test(r.url()) && JSON.parse(r.request().postData()).content === SMALL_PNG)
      await pasteFiles(page, [shot('a.png'), { name: 'b.png', type: 'image/png', b64: OTHER_PNG }])
      await waitEditorText(page, (t) => t.includes(`![Uploading b${ELL}]()`), 'placeholders')
      await firstDone
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'undo → pre-paste text')
      await until(() => uploads.length === 2, { message: 'both uploads sent' })
      await new Promise((r) => setTimeout(r, 3000))
      assert.equal(await editorText(page), pre, 'the late upload inserted nothing')
      // Redo: the paste comes back and the finished uploads land (never a stuck placeholder).
      await page.keyboard.press(`${MOD}+y`)
      const re = /^# Mid\n\n!\[a\]\(\S+\)\n\n!\[b\]\(\S+\)$/
      await waitEditorText(page, (t) => re.test(t), 'redo → both images')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'and one undo removes them')
    } finally { await context.close() }
  })

  it('undo then redo while the upload is still running: the image lands when it finishes', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Round trip\n\nhello SEL world'
      await openShared(page, pre)
      await delayUploads(page, 2000)
      await page.keyboard.press('End')
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
      await pasteFiles(page, [shot()])
      await waitEditorText(page, (t) => t.includes(`hello ![Uploading shot${ELL}]() world`), 'the placeholder over the selection')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'undo → pre-paste text (selection back)')
      await page.keyboard.press(`${MOD}+y`)
      await waitEditorText(page, (t) => t.includes(`hello ![Uploading shot${ELL}]() world`), 'redo → the placeholder again')
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t), 'the image lands', 10_000)
      assert.equal(text, `# Round trip\n\nhello ![shot](${text.match(FINAL_RE('shot'))[1]}) world`)
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'one undo → pre-paste text')
    } finally { await context.close() }
  })

  it('undo during the upload, let it finish, then redo: the image is inserted (no orphan placeholder)', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Late redo\n\n'
      await openShared(page, pre)
      await delayUploads(page, 1200)
      await pasteFiles(page, [shot()])
      await waitEditorText(page, (t) => t.includes(`![Uploading shot${ELL}]()`), 'the placeholder')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'undo → pre-paste')
      await new Promise((r) => setTimeout(r, 2000))
      assert.equal(await editorText(page), pre)
      await page.keyboard.press(`${MOD}+y`)
      const text = await waitEditorText(page, (t) => FINAL_RE('shot').test(t) && !t.includes('Uploading'), 'redo → the image')
      assert.equal(text, `${pre}![shot](${text.match(FINAL_RE('shot'))[1]})`)
    } finally { await context.close() }
  })

  it('undo of a single pending upload: placeholder gone, the later success inserts nothing', T, async () => {
    const { context, page } = await open()
    try {
      const pre = '# Pending\n\n'
      await openShared(page, pre)
      await delayUploads(page, 1500)
      await pasteFiles(page, [shot()])
      await waitEditorText(page, (t) => t.includes(`![Uploading shot${ELL}]()`), 'the placeholder')
      await page.keyboard.press(`${MOD}+z`)
      await waitEditorText(page, (t) => t === pre, 'undo → pre-paste text')
      await new Promise((r) => setTimeout(r, 2500))
      assert.equal(await editorText(page), pre, 'nothing inserted on success')
    } finally { await context.close() }
  })
})
