// QA fixes, edit lane (persona-engineer M5, M6, m7, c7, M2-in-History; persona-leader M3, M4).
// Each test reproduces the persona's steps against the throwaway stack.
import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, crc32 } from 'node:zlib'
import { BASE, API } from '../helpers.mjs'
import { createDoc, putMarkdown, listRevisions, uniq } from '../lib/docs.mjs'

const T = { timeout: 90_000 }
const tid = (id) => `[data-testid="${id}"]`
const MOD = 'ControlOrMeta'

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function open(viewport = { width: 1400, height: 900 }, opts = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...opts })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  page.on('dialog', (d) => d.accept().catch(() => {}))
  return { context, page, errors }
}

async function until(fn, { timeout = 8000, interval = 60, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${message}` })
    await new Promise((r) => setTimeout(r, interval))
  }
}

const editor = (page) => page.locator('.cm-editor:visible .cm-content').first()
const editorText = (page) => page.evaluate(() => {
  const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.getClientRects().length > 0)
  return ed ? [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n') : null
})
const serverMd = async (id) => (await (await fetch(`${API}/paste/${id}`)).json()).markdown
const box = (page, sel) => page.locator(sel).first().evaluate((e) => {
  const r = e.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
})

async function openEditor(page, id, view = 'edit') {
  await page.goto(`${BASE}/d/${id}?view=${view}`)
  await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
}
async function caretToEnd(page) {
  await editor(page).click()
  await page.keyboard.press(`${MOD}+End`)
}
async function openHistory(page) {
  await page.locator(tid('header-overflow-btn')).click()
  await page.locator(tid('menu-history')).click()
  const modal = page.locator(tid('revisions-modal'))
  await modal.waitFor({ state: 'visible', timeout: 10_000 })
  await until(() => page.evaluate(() => {
    const m = document.querySelector('[data-testid="revisions-modal"]')
    return !!m && !/loading/i.test(m.querySelector('.rev-status')?.textContent ?? '')
  }), { message: 'history loaded' })
  return modal
}
const uiPut = (id, markdown) => fetch(`${API}/paste/${id}/markdown`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-MdReview-Client': 'ui' }, body: JSON.stringify({ markdown }),
})

describe('QA M5 — Ctrl+B / Ctrl+I toggle off after typing', () => {
  it('bold on, type, bold off, type → `a **bb** cc` (no `****` litter); on+off on a bullet leaves it clean', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Toggle\n\n', sessionName: uniq('Toggle') })
      await openEditor(page, doc.id)
      await caretToEnd(page)
      await page.keyboard.type('a ')
      await page.keyboard.press(`${MOD}+b`)
      await page.keyboard.type('bb')
      await page.keyboard.press(`${MOD}+b`)
      await page.keyboard.type(' cc')
      await until(async () => (await editorText(page))?.endsWith('a **bb** cc'), { message: `bold span, got ${JSON.stringify(await editorText(page))}` })
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.type('- one')
      await page.keyboard.press('Enter') // continues with an empty `- ` item
      await page.keyboard.press(`${MOD}+i`)
      await page.keyboard.press(`${MOD}+i`)
      await page.keyboard.press('Enter') // the item is still empty, so Enter ends the list
      const text = await editorText(page)
      assert.ok(!/\*\*$|- \*/m.test(text) && !text.includes('****'), `no empty markers left: ${JSON.stringify(text)}`)
      assert.ok(text.endsWith('- one\n'), `Enter on the clean empty bullet ended the list: ${JSON.stringify(text)}`)
    } finally { await context.close() }
  })
})

describe('QA M6 — the losing side of a conflict stays recoverable', () => {
  it('"Keep my version": the overwritten server copy is its own revision in History and can be restored', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Doc\n\nbody\n', sessionName: uniq('KeepMine') })
      await openEditor(page, doc.id)
      // Tab A (same anonymous browser identity) saves first.
      assert.equal((await uiPut(doc.id, '# Doc\n\nbody FROM-TAB-A\n')).status, 200)
      await caretToEnd(page)
      await page.keyboard.type('MINE')
      const bar = page.locator(tid('conflict-bar'))
      await bar.waitFor({ state: 'visible', timeout: 15_000 })
      await bar.locator('button', { hasText: 'Keep my version' }).click()
      await bar.waitFor({ state: 'hidden', timeout: 8000 })
      assert.ok((await serverMd(doc.id)).includes('MINE'))
      const revs = await listRevisions(doc.id)
      assert.equal(revs.revisions.length, 3, `create + tab A + mine, not folded: ${JSON.stringify(revs.revisions.map((r) => r.writes ?? 1))}`)

      const modal = await openHistory(page)
      // Newest first: now = mine, then tab A's (auto-selected FROM).
      const rows = modal.locator('.rev-item')
      assert.equal(await rows.count(), 3)
      assert.equal((await rows.nth(1).locator('.rev-role').textContent()).trim().toLowerCase(), 'from')
      const diff = await modal.locator(tid('diff-table')).textContent()
      assert.ok(diff.includes('FROM-TAB-A'), 'the overwritten text is visible in the diff')
      await modal.locator(tid('restore-revision')).click()
      await until(async () => (await editorText(page))?.includes('FROM-TAB-A'), { message: 'tab A text restored' })
    } finally { await context.close() }
  })

  it('"Use server version": my edits are set aside (banner + History row) and can be restored', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Doc\n\nbody\n', sessionName: uniq('UseServer') })
      await openEditor(page, doc.id)
      await caretToEnd(page)
      await page.keyboard.type('MY-LOST-WORDS')
      assert.equal((await uiPut(doc.id, '# Doc\n\nbody THEIRS\n')).status, 200)
      const bar = page.locator(tid('conflict-bar'))
      await bar.waitFor({ state: 'visible', timeout: 15_000 })
      await bar.locator('button', { hasText: 'Use server version' }).click()
      await bar.waitFor({ state: 'hidden', timeout: 5000 })
      await until(async () => (await editorText(page))?.includes('THEIRS'), { message: 'server version adopted' })
      const banner = page.locator(tid('local-copy-banner'))
      await banner.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await banner.textContent(), /server version in a conflict/)

      const modal = await openHistory(page)
      const local = modal.locator(tid('revision-local-copy'))
      await local.waitFor({ state: 'visible' })
      await local.click()
      await modal.locator(tid('diff-table')).filter({ hasText: 'MY-LOST-WORDS' }).waitFor({ timeout: 5000 })
      await modal.locator(tid('restore-revision')).click()
      await until(async () => (await editorText(page))?.includes('MY-LOST-WORDS'), { message: 'set-aside edits restored' })
      await banner.waitFor({ state: 'detached', timeout: 5000 })
      await until(async () => (await serverMd(doc.id)).includes('MY-LOST-WORDS'), { timeout: 15_000, message: 'restored edits autosaved' })
    } finally { await context.close() }
  })

  it('the banner\'s Restore puts the set-aside edits back too', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Doc\n\nbody\n', sessionName: uniq('BannerRestore') })
      await openEditor(page, doc.id)
      await caretToEnd(page)
      await page.keyboard.type('BANNER-WORDS')
      assert.equal((await uiPut(doc.id, '# Doc\n\nbody THEIRS\n')).status, 200)
      const bar = page.locator(tid('conflict-bar'))
      await bar.waitFor({ state: 'visible', timeout: 15_000 })
      await bar.locator('button', { hasText: 'Use server version' }).click()
      await page.locator(tid('local-copy-restore')).click()
      await until(async () => (await editorText(page))?.includes('BANNER-WORDS'), { message: 'banner restore' })
      assert.equal(await page.locator(tid('local-copy-banner')).count(), 0)
    } finally { await context.close() }
  })

  it('after a restore History marks exactly one row NOW, and re-clicking FROM keeps Restore', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# H\n\nVersion one.\n', sessionName: uniq('OneNow'), author: 'Alice' })
      await putMarkdown(doc.id, '# H\n\nVersion two.\n', { author: 'Bob' })
      await openEditor(page, doc.id)
      await until(async () => (await editorText(page))?.includes('Version two.'), { message: 'v2' })
      let modal = await openHistory(page)
      await modal.locator(tid('restore-revision')).click()
      await until(async () => (await serverMd(doc.id)).includes('Version one.'), { timeout: 15_000, message: 'restore autosaved' })
      await until(async () => (await listRevisions(doc.id)).revisions.length === 3, { timeout: 8000, message: 'restore revision listed' })
      // Let the page pick the new revision up.
      await page.waitForTimeout(500)
      modal = await openHistory(page)
      await until(async () => (await modal.locator('.rev-item').count()) === 3, { message: '3 rows' })
      const roles = (await modal.locator('.rev-item .rev-role').allTextContents()).map((s) => s.trim().toLowerCase())
      assert.equal(roles.filter((r) => r === 'now').length, 1, `one NOW row: ${JSON.stringify(roles)}`)
      assert.equal(await modal.locator('.rev-item.to').count(), 1)
      await modal.locator('.rev-item.from').click()
      await page.waitForTimeout(200)
      assert.equal(await modal.locator('.rev-item.from').count(), 1, 'FROM is still selected')
      assert.equal(await modal.locator(tid('restore-revision')).count(), 1, 'Restore still offered')
    } finally { await context.close() }
  })
})

describe('QA M2 (History) — keyboard focus', () => {
  it('opening History moves focus into it, Tab stays inside, Esc returns focus to the More button', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# F\n\none\n', sessionName: uniq('HistFocus'), author: 'A' })
      await putMarkdown(doc.id, '# F\n\ntwo\n', { author: 'B' })
      await page.goto(`${BASE}/d/${doc.id}`)
      await page.locator('.preview-pane').getByText('two').waitFor({ timeout: 15_000 })
      await page.locator(tid('header-overflow-btn')).focus()
      await page.keyboard.press('Enter')
      await page.locator(tid('menu-history')).waitFor({ state: 'visible' })
      await page.locator(tid('menu-history')).focus()
      await page.keyboard.press('Enter')
      await page.locator(tid('revisions-modal')).waitFor({ state: 'visible' })
      const inside = () => page.evaluate(() => !!document.querySelector('[data-testid="revisions-modal"]')?.contains(document.activeElement))
      await until(inside, { message: 'focus inside the dialog' })
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab')
        assert.ok(await inside(), `focus left the dialog after Tab #${i + 1}`)
      }
      await page.keyboard.press('Escape')
      await page.locator(tid('revisions-modal')).waitFor({ state: 'detached' })
      await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'header-overflow-btn'), { message: 'focus back on More' })
    } finally { await context.close() }
  })
})

describe('QA leader M3/M4 — "what changed" for a reader on a phone', () => {
  it('the change note and changed sections come first, the line diff is behind a toggle and scrolls inside the modal', T, async () => {
    const key = `qa-edit:${uniq('k')}`
    const upsert = async (body, token) => {
      const res = await fetch(`${API}/paste/by-key/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}) }, body: JSON.stringify(body),
      })
      assert.ok(res.ok, `upsert ${res.status}`)
      return res.json()
    }
    const appendix = Array.from({ length: 40 }, (_, i) => `- item ${i}`).join('\n')
    const c = await upsert({ markdown: `# Weekly\n\n## Status\n\n:rag-red[Off track]\n\n## Appendix\n\n${appendix}\n`, sessionName: 'QA weekly' })
    const changed = Array.from({ length: 40 }, (_, i) => `- item ${i} (updated)`).join('\n')
    await upsert({ markdown: `# Weekly\n\n## Status\n\n:rag-amber[At risk]\n\n## Appendix\n\n${changed}\n`, changeNote: 'Geocoder hotfix: FR back to amber' }, c.editToken)
    const { context, page } = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    try {
      await page.goto(`${BASE}/d/${c.slug}`)
      await page.locator('.preview-pane').getByText('At risk').waitFor({ timeout: 15_000 })
      const modal = await openHistory(page)
      const note = modal.locator(tid('rev-summary-note'))
      await note.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await note.textContent(), /Geocoder hotfix: FR back to amber/)
      const sections = await modal.locator(tid('rev-summary-sections')).textContent()
      assert.match(sections, /Status/)
      assert.match(sections, /Appendix/)
      assert.equal(await modal.locator(tid('diff-table')).count(), 0, 'raw diff hidden for a reader until asked')
      await modal.locator(tid('rev-toggle-lines')).click()
      await modal.locator(tid('diff-table')).waitFor({ state: 'visible' })
      const m = await box(page, `${tid('revisions-modal')}`)
      const scroller = await box(page, tid('rev-diff-scroll'))
      assert.ok(scroller.bottom <= m.bottom + 1, `diff scroller ${JSON.stringify(scroller)} inside the modal ${JSON.stringify(m)}`)
      const scrolls = await page.locator(tid('rev-diff-scroll')).evaluate((e) => e.scrollHeight > e.clientHeight)
      assert.ok(scrolls, 'the long diff scrolls inside its own box')
      const footer = await box(page, `${tid('revisions-modal')} .modal-footer`)
      assert.ok(scroller.bottom <= footer.top + 1, `diff ends above the footer (${scroller.bottom} vs ${footer.top}), not under the Close button`)
    } finally { await context.close() }
  })
})

// A tiny valid PNG (8×8) for the image paste test.
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

describe('QA m7 — an image pasted after a table', () => {
  it('starts its own paragraph: a blank line before it, and the preview has no image inside the table', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', sessionName: uniq('ImgTable'), protected: true })
      await page.goto(`${BASE}/d/${doc.id}?edit=${doc.editToken}&view=split`)
      await editor(page).waitFor({ state: 'visible', timeout: 20_000 })
      await caretToEnd(page)
      const b64 = png(8, 8).toString('base64')
      await editor(page).evaluate((el, b64) => {
        const dt = new DataTransfer()
        dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      }, b64)
      const text = await until(async () => {
        const t = await editorText(page)
        return t && /!\[shot\]\(http/.test(t) ? t : null
      }, { timeout: 15_000, message: 'image uploaded' })
      assert.match(text, /\| 1 \| 2 \|\n\n!\[shot\]/, `blank line between the table and the image: ${JSON.stringify(text)}`)
      await page.locator(`${tid('split-pane-preview')} .preview-pane img`).first().waitFor({ state: 'attached', timeout: 10_000 })
      assert.equal(await page.locator(`${tid('split-pane-preview')} .preview-pane table img`).count(), 0, 'the image is not a table row')
    } finally { await context.close() }
  })
})

describe('QA c7 — the focus cluster is clearly apart from the split preview bar\'s Sync scroll', () => {
  it('gap ≥ 20px and no overlap at 1400px', T, async () => {
    const { context, page } = await open()
    try {
      const doc = await createDoc({ markdown: '# Focus\n\nbody\n', sessionName: uniq('FocusGap') })
      await openEditor(page, doc.id, 'split')
      await page.locator(`${tid('editor-toolbar')} ${tid('focus-mode-btn')}`).first().click()
      await page.locator(tid('focus-exit-btn')).waitFor({ state: 'visible', timeout: 5000 })
      await caretToEnd(page)
      await page.keyboard.type(' x') // a save-state label widens the cluster
      await page.waitForTimeout(400)
      const sync = await box(page, tid('split-sync-toggle'))
      const cluster = await box(page, tid('focus-controls'))
      assert.ok(cluster.left - sync.right >= 20, `gap ${cluster.left - sync.right}px (sync ${JSON.stringify(sync)}, cluster ${JSON.stringify(cluster)})`)
    } finally { await context.close() }
  })
})

describe('QA c1 (History) — theme tokens, not fixed hues; line icons, not emoji', () => {
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number)

  for (const theme of ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']) {
    it(`${theme}: diff stats and the now/from labels are >= 4.5:1 on the dialog; client icons are SVG`, T, async () => {
      const doc = await createDoc({ markdown: '# C\n\none\n', sessionName: uniq('Tokens'), author: 'A' })
      await putMarkdown(doc.id, '# C\n\ntwo\n', { author: 'B' })
      const { context, page } = await open()
      try {
        await page.addInitScript((t) => { try { localStorage.setItem('md-review-theme', t) } catch { /* */ } }, theme)
        await page.goto(`${BASE}/d/${doc.id}`)
        await page.locator('.preview-pane').getByText('two').waitFor({ timeout: 15_000 })
        const modal = await openHistory(page)
        await modal.locator(tid('diff-stats')).waitFor()
        const c = await page.evaluate(() => {
          const m = document.querySelector('[data-testid="revisions-modal"]')
          const col = (sel) => getComputedStyle(m.querySelector(sel)).color
          return {
            cls: document.documentElement.className,
            bg: getComputedStyle(m).backgroundColor,
            add: col('.stat-add'), del: col('.stat-del'), now: col('.rev-item.to .rev-role'), from: col('.rev-item.from .rev-role'),
            emoji: /[\u{1F464}\u{1F916}⚙]/u.test(m.textContent),
            rows: [...m.querySelectorAll('.diff-row.add, .diff-row.del')].map((r) => ({ cls: r.className, bg: getComputedStyle(r).backgroundColor, fg: getComputedStyle(r).color })),
            icons: m.querySelectorAll('.rev-client svg').length,
            labels: [...m.querySelectorAll('.rev-client')].map((e) => e.getAttribute('aria-label')),
          }
        })
        assert.equal(/\bdark\b/.test(c.cls), theme.endsWith('dark'), `theme applied (${c.cls})`)
        if (theme.startsWith('locus')) assert.match(c.cls, /locus-theme/)
        for (const k of ['add', 'del', 'now', 'from']) {
          const r = ratio(rgb(c[k]), rgb(c.bg))
          assert.ok(r >= 4.5, `${theme} ${k} ${c[k]} on ${c.bg}: ${r.toFixed(2)}:1`)
        }
        // Added rows are green-dominant and removed rows red-dominant (Locus dark once tinted them navy); text stays >= 4.5:1.
        for (const r of c.rows) {
          const [R, G, B] = rgb(r.bg)
          if (/\badd\b/.test(r.cls)) assert.ok(G > R && G > B, `${theme} add row ${r.bg} is green`)
          else assert.ok(R > G && R > B, `${theme} del row ${r.bg} is red`)
          assert.ok(ratio(rgb(r.fg), rgb(r.bg)) >= 4.5, `${theme} row text ${r.fg} on ${r.bg}`)
        }
        assert.ok(c.rows.length >= 2, 'diff rows present')
        assert.equal(c.emoji, false, 'no emoji glyphs')
        assert.ok(c.icons >= 2, `svg icons (${c.icons})`)
        assert.ok(c.labels.every(Boolean), 'every client icon has an aria-label')
      } finally { await context.close() }
    })
  }
})
