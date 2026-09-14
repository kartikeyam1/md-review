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

const BASE = process.env.E2E_BASE || 'http://localhost:58747'
const PASTE_API = process.env.PASTE_API || 'http://localhost:3100'

let browser, context, page

async function createSharedSession(markdown = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.') {
  const res = await fetch(`${PASTE_API}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, filename: 'doc.md', comments: [], sharedAt: new Date().toISOString() }),
  })
  const { id } = await res.json()
  return id
}

async function serverMarkdown(id) {
  const res = await fetch(`${PASTE_API}/paste/${id}/markdown`)
  return (await res.json()).markdown
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

const saveState = () => page.locator('[data-testid="save-state"]')

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
    await page.waitForTimeout(300)

    // Preview, then comment on the first paragraph (no explicit Save).
    await page.click('button:has-text("Preview")')
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

    // The poll cycle is 5 s; give it two cycles to (wrongly) clobber.
    await page.waitForTimeout(11000)

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
    await saveState().waitFor()
    assert.equal((await saveState().textContent()).trim(), '✓ Saved')

    await typeAtEnd('\n\nIDLE AUTOSAVE')
    assert.match(await saveState().textContent(), /Unsaved changes|Saving/)
    // Idle autosave fires ~2 s after the last keystroke — no pane switch, no Save click.
    await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.textContent.includes('Saved'), null, { timeout: 8000 })
    assert.ok((await serverMarkdown(id)).includes('IDLE AUTOSAVE'))

    // Save state stays visible after switching to preview.
    await page.click('button:has-text("Preview")')
    await page.locator('.preview-pane').waitFor()
    assert.equal((await saveState().textContent()).trim(), '✓ Saved')
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
    assert.equal((await saveState().textContent()).trim(), '✓ Saved')
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
    assert.equal((await saveState().textContent()).trim(), '✓ Saved')
  })

  it('a reload before autosave restores the unsaved draft and then saves it', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    await typeAtEnd(' DRAFT')
    // Reload immediately: idle autosave (2 s) has not fired yet, only the
    // 500 ms localStorage persist has.
    await page.waitForTimeout(700)
    assert.ok(!(await serverMarkdown(id)).includes('DRAFT'), 'precondition: not yet autosaved')
    await page.reload()
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })

    const text = await page.locator('.preview-pane').textContent()
    assert.ok(text.includes('DRAFT'), 'unsaved draft must be restored after reload')
    await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.textContent.includes('Saved'), null, { timeout: 8000 })
    assert.ok((await serverMarkdown(id)).includes('DRAFT'), 'restored draft must autosave')
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
    await page.click('button:has-text("Preview")')
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
    await saveState().waitFor()

    await page.click('button:has-text("Edit")')
    await page.locator('.cm-content').waitFor()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('End') // end of the "# Big" heading line — keep it a heading
    await page.keyboard.type(' BIGDRAFT')
    // Let the 500 ms local persist run, but reload before the 2 s server autosave.
    await page.waitForTimeout(900)
    assert.ok(!(await serverMarkdown(id)).includes('BIGDRAFT'), 'precondition: not yet autosaved')
    const persistErr = await page.locator('[data-testid="persist-error"]').count()
    assert.equal(persistErr, 0, 'local draft persistence must not report an error for a large document')

    await page.reload()
    await page.locator('.preview-pane').waitFor({ timeout: 15000 })
    const text = await page.locator('.preview-pane h1').first().textContent()
    assert.ok(text.includes('BIGDRAFT'), `large draft must be restored after reload, got heading: ${text}`)
    await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.textContent.includes('Saved'), null, { timeout: 20000 })
    assert.ok((await serverMarkdown(id)).includes('BIGDRAFT'))
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
    await page.reload()
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    await page.waitForTimeout(1500)
    assert.equal(await page.locator('[data-testid="changes-banner"]').count(), 0, 'no banner after acknowledging and reloading')
  })

  it('restores an earlier revision into the editor as unsaved edits', async () => {
    const id = await createSharedSession('# V1 title\n\noriginal body')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    await agentPut(id, '# V2 title\n\nrewritten body', 'agent')
    await page.locator('[data-testid="changes-banner"]').waitFor({ state: 'visible', timeout: 12000 })

    await page.locator('[data-testid="history-button"]').click()
    await page.locator('[data-testid="revisions-modal"]').waitFor({ timeout: 5000 })
    // The default comparison is from the acknowledged (V1) revision to current (V2); restore V1.
    await page.locator('[data-testid="restore-revision"]').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="revisions-modal"]'), null, { timeout: 3000 })

    const preview = await page.locator('.preview-pane').textContent()
    assert.ok(preview.includes('V1 title') && preview.includes('original body'), 'restored content should be on screen')
    // Restore is an unsaved edit that then autosaves back to the server.
    await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.textContent.includes('Saved'), null, { timeout: 8000 })
    assert.ok((await serverMarkdown(id)).includes('original body'))
    // History now has create, agent rewrite, and the restore.
    const list = await (await fetch(`${PASTE_API}/paste/${id}/revisions`)).json()
    assert.ok(list.revisions.length >= 3)
  })

  it('the History button shows the revision count and an unseen-changes dot', async () => {
    const id = await createSharedSession('# Doc\n\nbody')
    await page.goto(`${BASE}/#shared=${id}`)
    await page.locator('.preview-pane').waitFor({ timeout: 5000 })
    const btn = page.locator('[data-testid="history-button"]')
    await btn.waitFor()
    assert.ok((await btn.textContent()).includes('1'), 'shows the initial revision count')
    assert.equal(await btn.locator('.history-dot').count(), 0)

    await agentPut(id, '# Doc\n\nbody + more')
    await page.locator('[data-testid="changes-banner"]').waitFor({ state: 'visible', timeout: 12000 })
    assert.equal(await btn.locator('.history-dot').count(), 1, 'unseen dot appears on the History button')
  })
})
