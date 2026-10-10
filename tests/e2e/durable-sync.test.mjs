// Durability of a shared session's document:
//  - editing, switching Edit → Preview and commenting (without pressing Save)
//    must NOT lose the edits, and the edits must reach the server so comment
//    anchors match what everyone else sees (the original bug report);
//  - a server-side change while local edits are unsaved surfaces as a conflict
//    with both resolutions working;
//  - a reload before autosave restores the unsaved draft from this browser;
//  - the save state is visible in preview mode too.
import { chromium } from 'playwright'
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, API as PASTE_API } from './helpers.mjs'
import { asLegacyDoc } from './lib/legacy-docs.mjs'

let browser, context, page

async function createSharedSession(markdown = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.') {
  const res = await fetch(`${PASTE_API}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Comments, approval and the reviewer name are review-mode UI (#2); the default is now publish.
    body: JSON.stringify({ markdown, filename: 'doc.md', comments: [], sharedAt: new Date().toISOString(), mode: 'review' }),
  })
  const { id } = await res.json()
  await asLegacyDoc(id) // #23: a link-editable doc, as every doc was before edit tokens
  return id
}

async function serverMarkdown(id) {
  const res = await fetch(`${PASTE_API}/paste/${id}/markdown`)
  return (await res.json()).markdown
}

/** Poll the server until its markdown contains `text` (a hidden save-state alone can be true too early). */
async function waitForServer(id, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!(await serverMarkdown(id)).includes(text) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  return (await serverMarkdown(id)).includes(text)
}

async function agentPutMarkdown(id, markdown) {
  const res = await fetch(`${PASTE_API}/paste/${id}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }),
  })
  assert.equal(res.status, 200)
}

async function typeAtEnd(text) {
  await page.click('button:has-text("Edit")')
  await page.locator('.cm-content').waitFor()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

/**
 * Wait until this browser's local draft (IndexedDB md-review/drafts "state",
 * or the localStorage fallback) contains `text` — i.e. the 500 ms local
 * persist has run. Quiet on timeout; the caller's assertions decide.
 */
async function waitForLocalDraft(text, timeout = 5000) {
  await page.waitForFunction(async (needle) => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('md-review'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      try {
        if (db.objectStoreNames.contains('drafts')) {
          const v = await new Promise((res, rej) => { const r = db.transaction('drafts').objectStore('drafts').get('state'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
          if (typeof v === 'string' && v.includes(needle)) return true
        }
      } finally { db.close() }
    } catch { /* fall back to localStorage */ }
    for (let i = 0; i < localStorage.length; i++) {
      if ((localStorage.getItem(localStorage.key(i)) || '').includes(needle)) return true
    }
    return false
  }, text, { timeout, polling: 100 }).catch(() => {})
}

/** Resolve after `n` poll requests (GET /paste/<id>) complete from now on. */
function pollCycles(id, n, timeout = 15000) {
  return new Promise((resolve) => {
    let seen = 0
    const onResponse = (r) => {
      if (r.request().method() !== 'GET' || new URL(r.url()).pathname !== `/paste/${id}`) return
      if (++seen >= n) done()
    }
    const done = () => { page.off('response', onResponse); clearTimeout(timer); resolve(seen) }
    const timer = setTimeout(done, timeout)
    page.on('response', onResponse)
  })
}

const saveState = () => page.locator('[data-testid="save-state"]')
// #2 rule 5: save-state only shows while not idle/saved — "saved" means it is gone.
const SAVED = () => !document.querySelector('[data-testid="save-state"]')

before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  page = await context.newPage()
})
afterEach(async () => { await context?.close() })

describe('shared mode: edits survive Edit → Preview → comment', () => {
  it('keeps local edits after adding a comment in preview and persists them to the server', async () => {
    const id = await createSharedSession()
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    // Edit: append a new line at the end of the document.
    await page.click('button:has-text("Edit")')
    await page.locator('.cm-content').waitFor()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\n\nEDITED LINE XYZ')
    // The edit has reached the doc state once the header reports it unsaved.
    await saveState().waitFor({ timeout: 3000 })

    // Preview, then comment on the first paragraph (no explicit Save).
    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()
    const edited = await page.locator('.preview-pane').textContent()
    assert.ok(edited.includes('EDITED LINE XYZ'), 'preview should show the edit before commenting')

    await page.locator('.preview-pane p').first().click({ clickCount: 3 })
    const bar = page.locator('.selection-action-bar .action-btn')
    await bar.waitFor({ state: 'visible', timeout: 3000 })
    await bar.click()
    await page.locator('.popover-input').fill('a comment')
    await page.locator('.popover .btn-primary').click()
    await page.locator('.comment-body').first().waitFor({ timeout: 3000 })

    // The poll cycle is 5 s; give it two full poll round-trips to (wrongly)
    // clobber, then let the applied state render. (Negative check: bounded by
    // the poll cadence, not a fixed sleep.)
    await pollCycles(id, 2)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

    const after = await page.locator('.preview-pane').textContent()
    assert.ok(after.includes('EDITED LINE XYZ'), `local edit was lost after commenting; preview now: ${after.slice(0, 200)}`)

    const remote = await serverMarkdown(id)
    assert.ok(remote.includes('EDITED LINE XYZ'), 'edit should have been auto-saved to the server')
  })
})

describe('shared mode: save state and conflicts', () => {
  it('shows unsaved → saved in preview mode and autosaves after idle', async () => {
    const id = await createSharedSession()
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    assert.equal(await saveState().count(), 0, 'nothing to report while saved')

    await typeAtEnd('\n\nIDLE AUTOSAVE')
    assert.match(await saveState().textContent(), /Unsaved changes|Saving/)
    // Idle autosave fires ~2 s after the last keystroke — no pane switch, no Save click.
    await page.waitForFunction(SAVED, null, { timeout: 8000 })
    assert.ok((await serverMarkdown(id)).includes('IDLE AUTOSAVE'))

    // Still saved (nothing shown) after switching to the read view.
    await page.click('[data-testid="view-toggle-read"]')
    await page.locator('.preview-pane').waitFor()
    assert.equal(await saveState().count(), 0)
  })

  it('a server-side change while editing becomes a conflict; "Use server version" adopts it', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    await typeAtEnd(' MINE')
    // An agent rewrites the document underneath us before autosave lands.
    await agentPutMarkdown(id, '# Doc\n\nbody THEIRS')

    const bar = page.locator('[data-testid="conflict-bar"]')
    await bar.waitFor({ state: 'visible', timeout: 12000 })
    // Local text is untouched while the conflict is open.
    const editorText = await page.locator('.cm-content').textContent()
    assert.ok(editorText.includes('MINE'), 'local edits must be kept while conflicted')
    assert.ok(!editorText.includes('THEIRS'))
    assert.equal((await serverMarkdown(id)), '# Doc\n\nbody THEIRS', 'conflict must not overwrite the server')

    await bar.locator('button:has-text("Use server version")').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="conflict-bar"]'), null, { timeout: 3000 })
    const after = await page.locator('.cm-content').textContent()
    assert.ok(after.includes('THEIRS') && !after.includes('MINE'))
    assert.equal(await saveState().count(), 0, 'saved: no save-state')
  })

  it('"Keep my version" overwrites the server with the local edits', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    await typeAtEnd(' MINE')
    await agentPutMarkdown(id, '# Doc\n\nbody THEIRS')
    const bar = page.locator('[data-testid="conflict-bar"]')
    await bar.waitFor({ state: 'visible', timeout: 12000 })

    await bar.locator('button:has-text("Keep my version")').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="conflict-bar"]'), null, { timeout: 5000 })
    assert.equal(await serverMarkdown(id), '# Doc\n\nbody MINE')
    await page.waitForFunction(SAVED, null, { timeout: 3000 })
  })

  it('a reload before autosave restores the unsaved draft and then saves it', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    await typeAtEnd(' DRAFT')
    // Reload immediately: idle autosave (2 s) has not fired yet, only the
    // 500 ms local draft persist has.
    await waitForLocalDraft(' DRAFT')
    assert.ok(!(await serverMarkdown(id)).includes('DRAFT'), 'precondition: not yet autosaved')
    // The edit view is in the URL (?view=edit, #2), so the reload reopens the editor.
    await page.reload()
    await page.locator('.cm-content').waitFor({ timeout: 15000 })

    const text = await page.locator('.cm-content').textContent()
    assert.ok(text.includes('DRAFT'), 'unsaved draft must be restored after reload')
    assert.ok(await waitForServer(id, 'DRAFT', 8000), 'restored draft must autosave')
    await page.waitForFunction(SAVED, null, { timeout: 3000 })
  })

  it('editing in one tab shows up in another tab that is not editing', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    const other = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page2 = await other.newPage()
    await page2.goto(`${BASE}/#shared=${id}`)
    await page2.locator('.preview-pane').waitFor({ timeout: 5000 })

    await typeAtEnd(' FROM TAB ONE')
    await page.click('[data-testid="view-toggle-read"]')
    await page2.waitForFunction(() => document.querySelector('.preview-pane')?.textContent.includes('FROM TAB ONE'), null, { timeout: 12000 })
    await other.close()
  })
})

describe('shared mode: large drafts and signed comments', () => {
  it('a multi-megabyte document keeps its unsaved draft across a reload (IndexedDB, not localStorage)', async () => {
    // ~6 MB: over the ~5 MB localStorage cap, so this only passes with IndexedDB.
    const bigBody = Array.from({ length: 60000 }, (_, i) => `Line ${i} ${'lorem ipsum dolor sit amet '.repeat(3)}`).join('\n')
    const id = await createSharedSession(`# Big\n\n${bigBody}`)
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 15000 })

    await page.click('button:has-text("Edit")')
    await page.locator('.cm-content').waitFor()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('End') // end of the "# Big" heading line — keep it a heading
    await page.keyboard.type(' BIGDRAFT')
    // Let the 500 ms local persist run, but reload before the 2 s server autosave.
    await waitForLocalDraft('BIGDRAFT')
    assert.ok(!(await serverMarkdown(id)).includes('BIGDRAFT'), 'precondition: not yet autosaved')
    const persistErr = await page.locator('[data-testid="persist-error"]').count()
    assert.equal(persistErr, 0, 'local draft persistence must not report an error for a large document')

    // The edit view is in the URL (?view=edit, #2), so the reload reopens the editor.
    await page.reload()
    await page.locator('.cm-content').waitFor({ timeout: 15000 })
    const text = await page.locator('.cm-line').first().textContent()
    assert.ok(text.includes('BIGDRAFT'), `large draft must be restored after reload, got heading: ${text}`)
    assert.ok(await waitForServer(id, 'BIGDRAFT', 20000), 'restored large draft must autosave')
    await page.waitForFunction(SAVED, null, { timeout: 3000 })
  })

  it('a reviewer name set in the header signs comments and replies', async () => {
    const id = await createSharedSession()
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    await page.locator('[data-testid="reviewer-name"]').click()
    await page.locator('[data-testid="reviewer-input"]').fill('Kartikeya')
    await page.keyboard.press('Enter')
    assert.ok((await page.locator('[data-testid="reviewer-name"]').textContent()).includes('Kartikeya'))

    await page.locator('.preview-pane p').first().click({ clickCount: 3 })
    const bar = page.locator('.selection-action-bar .action-btn')
    await bar.waitFor({ state: 'visible', timeout: 3000 })
    await bar.click()
    assert.ok((await page.locator('.popover-author').textContent()).includes('Kartikeya'))
    await page.locator('.popover-input').fill('signed comment')
    await page.locator('.popover .btn-primary').click()
    await page.locator('.comment-body').first().waitFor({ timeout: 3000 })
    await page.waitForFunction(() => document.querySelector('.comment-author')?.textContent.includes('Kartikeya'), null, { timeout: 3000 })

    const stored = await (await fetch(`${PASTE_API}/paste/${id}/comments`)).json()
    assert.equal(stored.comments[0].author, 'Kartikeya')
    assert.equal(stored.comments[0].body, 'signed comment')

    // The name is remembered across reloads.
    await page.reload()
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    assert.ok((await page.locator('[data-testid="reviewer-name"]').textContent()).includes('Kartikeya'))
  })
})

describe('revision history: what changed since I last looked', () => {
  async function agentPut(id, markdown, author = 'agent') {
    const res = await fetch(`${PASTE_API}/paste/${id}/markdown`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-MdReview-Client': 'mcp' },
      body: JSON.stringify({ markdown, author }),
    })
    assert.equal(res.status, 200)
  }

  it('raises a "changes since you last looked" banner and shows the diff, then clears it', async () => {
    const id = await createSharedSession('# Report\n\nFirst finding.\n\nSecond finding.')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    // Fresh viewer: no banner.
    assert.equal(await page.locator('[data-testid="changes-banner"]').count(), 0)

    // An agent revises the document while the reader is looking.
    await agentPut(id, '# Report\n\nFirst finding, now expanded.\n\nSecond finding.\n\nThird finding added by agent.')

    // The banner appears within a poll cycle.
    const banner = page.locator('[data-testid="changes-banner"]')
    await banner.waitFor({ state: 'visible', timeout: 12000 })
    assert.ok((await banner.textContent()).includes('agent'))

    // View changes → diff modal shows the additions.
    await page.locator('[data-testid="view-changes"]').click()
    await page.locator('[data-testid="revisions-modal"]').waitFor({ timeout: 5000 })
    await page.locator('[data-testid="diff-table"]').waitFor({ timeout: 5000 })
    const diffText = await page.locator('[data-testid="diff-table"]').textContent()
    assert.ok(diffText.includes('Third finding added by agent.'), 'diff should show the added line')
    const stats = await page.locator('[data-testid="diff-stats"]').textContent()
    assert.match(stats, /\+\d/)

    // Opening the diff acknowledges the current version; closing clears the banner.
    await page.locator('[data-testid="revisions-modal"] .modal-close').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="changes-banner"]'), null, { timeout: 3000 })

    // The acknowledgement survives a reload: no banner for the same version.
    // The banner is decided once the revision list for the doc has been
    // fetched (initSeen → refreshRevisions), so wait for that response and
    // let it render before checking that nothing appeared. (Negative check.)
    const revisionsFetched = page.waitForResponse((r) => new URL(r.url()).pathname === `/paste/${id}/revisions`, { timeout: 10000 }).catch(() => {})
    await page.reload()
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    await revisionsFetched
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    assert.equal(await page.locator('[data-testid="changes-banner"]').count(), 0, 'no banner after acknowledging and reloading')
  })

  it('restores an earlier revision into the editor as unsaved edits', async () => {
    const id = await createSharedSession('# V1 title\n\noriginal body')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    await agentPut(id, '# V2 title\n\nrewritten body', 'agent')
    await page.locator('[data-testid="changes-banner"]').waitFor({ state: 'visible', timeout: 12000 })

    await page.locator('[data-testid="header-overflow-btn"]').click()
    await page.locator('[data-testid="menu-history"]').click()
    await page.locator('[data-testid="revisions-modal"]').waitFor({ timeout: 5000 })
    // The default comparison is from the acknowledged (V1) revision to current (V2); restore V1.
    await page.locator('[data-testid="restore-revision"]').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="revisions-modal"]'), null, { timeout: 3000 })

    const preview = await page.locator('.preview-pane').textContent()
    assert.ok(preview.includes('V1 title') && preview.includes('original body'), 'restored content should be on screen')
    // Restore is an unsaved edit that then autosaves back to the server. (The
    // read view shows no save-state — it is editor-header chrome, 00 §2.2 — so
    // watch the server instead.)
    assert.ok(await waitForServer(id, 'original body', 8000), 'restored revision must autosave')
    // History now has create, agent rewrite, and the restore.
    const list = await (await fetch(`${PASTE_API}/paste/${id}/revisions`)).json()
    assert.ok(list.revisions.length >= 3)
  })

  it('the History menu item shows the revision count and an unseen-changes dot', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    // history-button is retired: History lives in the overflow menu (#2, 00 §10.1).
    await page.locator('[data-testid="header-overflow-btn"]').click()
    const btn = page.locator('[data-testid="menu-history"]')
    await btn.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="menu-history"]')?.textContent.includes('1'), null, { timeout: 5000 })
    assert.equal(await btn.locator('.history-dot').count(), 0)
    await page.keyboard.press('Escape')

    await agentPut(id, '# Doc\n\nbody + more')
    await page.locator('[data-testid="changes-banner"]').waitFor({ state: 'visible', timeout: 12000 })
    await page.locator('[data-testid="header-overflow-btn"]').click()
    assert.equal(await btn.locator('.history-dot').count(), 1, 'unseen dot appears on the History menu item')
  })
})
