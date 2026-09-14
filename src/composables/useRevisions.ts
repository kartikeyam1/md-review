import { useShare, type RevisionEntry, type RevisionContent } from '@/composables/useShare'
import { openKeyValueStore, type KeyValueStore } from '@/composables/draftStore'

/**
 * "What changed since I last looked".
 *
 * The browser remembers, per session, the last content hash the reader
 * ACKNOWLEDGED — the last one they wrote themselves, dismissed a change banner
 * for, or opened the diff for. Merely having a newer copy pushed onto the
 * screen does not count, so a reload never loses the pointer to what the
 * reader actually reviewed.
 */
export interface SeenRecord { hash: string; at: string }

export interface SinceSummary {
  /** Hash the reader last acknowledged. */
  since: string
  /** Whether `since` is still a known revision (it may have been folded away or expired). */
  sinceKnown: boolean
  /** Revisions written after `since` (all revisions when `since` is unknown). */
  count: number
  authors: string[]
  /** ISO time of the first and last change in the range. */
  from: string | null
  to: string | null
}

const seenKey = (pasteId: string) => `seen:${pasteId}`

export function displayAuthor(entry: Pick<RevisionEntry, 'by' | 'client'>): string {
  if (entry.by) return entry.by
  if (entry.client === 'mcp') return 'an agent'
  if (entry.client === 'ui') return 'someone'
  return 'the API'
}

/** Pure: describe the revisions after `sinceHash`. */
export function summarizeSince(revisions: RevisionEntry[], sinceHash: string, currentHash: string | null): SinceSummary | null {
  if (!sinceHash || sinceHash === currentHash) return null
  const idx = revisions.findIndex(r => r.hash === sinceHash)
  const after = idx === -1 ? revisions : revisions.slice(idx + 1)
  const authors = Array.from(new Set(after.map(displayAuthor)))
  const first = after[0]
  const last = after[after.length - 1]
  return {
    since: sinceHash,
    sinceKnown: idx !== -1,
    count: after.length,
    authors,
    from: first ? first.at : null,
    to: last ? (last.at_end || last.at) : null,
  }
}

let kvPromise: Promise<KeyValueStore> | null = null
const kv = () => (kvPromise ??= openKeyValueStore())

export function useRevisions() {
  const { getRevisions, getRevision } = useShare()
  const contentCache = new Map<string, RevisionContent>()

  async function getSeen(pasteId: string): Promise<SeenRecord | null> {
    try {
      const raw = await (await kv()).get(seenKey(pasteId))
      if (!raw) return null
      const rec = JSON.parse(raw) as SeenRecord
      return rec && typeof rec.hash === 'string' ? rec : null
    } catch { return null }
  }

  async function setSeen(pasteId: string, hash: string): Promise<void> {
    try {
      await (await kv()).set(seenKey(pasteId), JSON.stringify({ hash, at: new Date().toISOString() } satisfies SeenRecord))
    } catch { /* best effort */ }
  }

  async function fetchList(pasteId: string) {
    return getRevisions(pasteId)
  }

  /** Fetch a revision's content (cached per hash; 'current' is never cached). */
  async function fetchRevision(pasteId: string, hash: string | 'current'): Promise<{ data: RevisionContent | null; status: number }> {
    if (hash !== 'current') {
      const cached = contentCache.get(hash)
      if (cached) return { data: cached, status: 200 }
    }
    const result = await getRevision(pasteId, hash)
    if (result.data && hash !== 'current') contentCache.set(hash, result.data)
    return result
  }

  return { getSeen, setSeen, fetchList, fetchRevision, summarizeSince, displayAuthor }
}
