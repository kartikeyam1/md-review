// QA fixes in History (RevisionsModal): persona engineer M6 (one "now" row after a restore,
// re-clicking FROM keeps Restore, the set-aside local copy is listed and restorable) and
// persona leader M4 (a reader sees change notes + changed sections first, the line diff on request).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { RevisionEntry } from '@/composables/useShare'

const contents: Record<string, string> = {}
vi.mock('@/composables/useRevisions', async (orig) => ({
  ...(await orig<typeof import('@/composables/useRevisions')>()),
  useRevisions: () => ({
    fetchRevision: async (_id: string, hash: string) => {
      const key = hash === 'current' ? '__current' : hash
      const md = contents[key]
      return md === undefined ? { data: null, status: 404 } : { data: { hash: hash === 'current' ? contents.__currentHash : hash, at: '2026-10-11T10:00:00Z', by: null, client: 'ui', size: null, parent: null, markdown: md, is_current: hash === 'current' }, status: 200 }
    },
  }),
}))

const { default: RevisionsModal } = await import('@/components/RevisionsModal.vue')
// The modal loads `diff` lazily. Warm the module here so its dynamic import
// resolves promptly; the assertions below still wait for the rendered state
// instead of counting promise flushes (a fixed flush count passed on Node 26
// and failed on CI's Node 20).
await import('diff')

/** Flush promises until `check` passes (or time out) — waits for real state, not a tick count. */
async function settle(check: () => void, timeout = 3000) {
  await vi.waitFor(async () => { await flushPromises(); check() }, { timeout, interval: 10 })
}

const rev = (hash: string, minute: number, extra: Partial<RevisionEntry> = {}): RevisionEntry =>
  ({ hash, at: `2026-10-11T10:${String(minute).padStart(2, '0')}:00Z`, by: 'Kim', client: 'ui', size: 1, parent: null, ...extra })

async function mountModal(props: Record<string, unknown>) {
  const w = mount(RevisionsModal, { props: { visible: true, pasteId: 'p1', initialFrom: null, ...props }, attachTo: document.body })
  await flushPromises()
  await flushPromises()
  return w
}

beforeEach(() => {
  for (const k of Object.keys(contents)) delete contents[k]
  document.body.innerHTML = ''
})

describe('QA M6 — History after a restore and a conflict', () => {
  it('a restore that brings back an older hash shows exactly one "now" row', async () => {
    Object.assign(contents, { A: '# v1\n', B: '# v2\n', __current: '# v1\n', __currentHash: 'A' })
    // v1 → v2 → restored v1: the newest revision's hash equals the first one's.
    const w = await mountModal({ revisions: [rev('A', 1), rev('B', 2), rev('A', 3)], currentHash: 'A' })
    const roles = w.findAll('.rev-item .rev-role').map((r) => r.text())
    expect(roles.filter((r) => r === 'now')).toHaveLength(1)
    expect(roles[0]).toBe('now') // newest first
    expect(roles[1]).toBe('from')
    expect(w.findAll('.rev-item.to')).toHaveLength(1)
    w.unmount()
  })

  it('clicking the selected FROM row keeps it selected and Restore visible', async () => {
    Object.assign(contents, { A: 'one\n', B: 'two\n', __current: 'two\n', __currentHash: 'B' })
    const w = await mountModal({ revisions: [rev('A', 1), rev('B', 2)], currentHash: 'B', allowRestore: true })
    expect(w.find('[data-testid="restore-revision"]').exists()).toBe(true)
    await w.find('.rev-item.from').trigger('click')
    await flushPromises()
    expect(w.find('.rev-item.from').exists()).toBe(true)
    expect(w.find('[data-testid="restore-revision"]').exists()).toBe(true)
    w.unmount()
  })

  it('lists the set-aside local copy; picking it diffs and restores its text', async () => {
    Object.assign(contents, { A: 'one\n', B: 'server\n', __current: 'server\n', __currentHash: 'B' })
    const w = await mountModal({ revisions: [rev('A', 1), rev('B', 2)], currentHash: 'B', allowRestore: true, localCopy: { markdown: 'my lost edits\n', at: '2026-10-11T10:05:00Z' } })
    const row = w.find('[data-testid="revision-local-copy"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('Your set-aside edits')
    await row.trigger('click')
    await settle(() => expect(w.find('[data-testid="diff-table"]').text()).toContain('my lost edits'))
    await w.find('[data-testid="restore-revision"]').trigger('click')
    expect(w.emitted('restore')![0]).toEqual(['my lost edits\n', null])
    w.unmount()
  })

  it('a viewer gets no local-copy row or restore', async () => {
    Object.assign(contents, { A: 'one\n', B: 'two\n', __current: 'two\n', __currentHash: 'B' })
    const w = await mountModal({ revisions: [rev('A', 1), rev('B', 2)], currentHash: 'B', allowRestore: false })
    expect(w.find('[data-testid="restore-revision"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('QA leader M4 — reader-facing "what changed"', () => {
  it('a reader sees the change note and changed sections first; the line diff is behind a toggle', async () => {
    Object.assign(contents, {
      A: '# Weekly\n\n## Status\n\n:rag-red[Off track]\n\n## Risks\n\nnone\n',
      B: '# Weekly\n\n## Status\n\n:rag-amber[At risk]\n\n## Risks\n\nnone\n',
      __current: '# Weekly\n\n## Status\n\n:rag-amber[At risk]\n\n## Risks\n\nnone\n', __currentHash: 'B',
    })
    const w = await mountModal({
      revisions: [rev('A', 1), rev('B', 2, { client: 'mcp', by: 'agent', note: 'Geocoder hotfix: FR back to amber' })],
      currentHash: 'B', initialFrom: 'A', allowRestore: false,
    })
    await settle(() => expect(w.find('[data-testid="rev-summary-note"]').text()).toContain('Geocoder hotfix: FR back to amber'))
    expect(w.find('[data-testid="rev-summary-sections"]').text()).toContain('Status')
    expect(w.find('[data-testid="rev-summary-sections"]').text()).not.toContain('Risks')
    expect(w.find('[data-testid="diff-table"]').exists()).toBe(false)
    await w.find('[data-testid="rev-toggle-lines"]').trigger('click')
    expect(w.find('[data-testid="diff-table"]').exists()).toBe(true)
    w.unmount()
  })

  it('an editor still gets the line diff right away (plus the summary)', async () => {
    Object.assign(contents, { A: '# T\n\nold\n', B: '# T\n\nnew\n', __current: '# T\n\nnew\n', __currentHash: 'B' })
    const w = await mountModal({ revisions: [rev('A', 1), rev('B', 2)], currentHash: 'B', allowRestore: true })
    await settle(() => expect(w.find('[data-testid="diff-table"]').exists()).toBe(true))
    expect(w.find('[data-testid="rev-toggle-lines"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('QA M2 (History) — dialog semantics and focus', () => {
  it('is an aria-modal dialog and takes focus on open', async () => {
    Object.assign(contents, { A: 'one\n', B: 'two\n', __current: 'two\n', __currentHash: 'B' })
    const w = await mountModal({ revisions: [rev('A', 1), rev('B', 2)], currentHash: 'B' })
    const dlg = w.find('[data-testid="revisions-modal"]')
    expect(dlg.attributes('role')).toBe('dialog')
    expect(dlg.attributes('aria-modal')).toBe('true')
    expect(dlg.element.contains(document.activeElement)).toBe(true)
    w.unmount()
  })
})
