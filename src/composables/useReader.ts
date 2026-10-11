import { computed } from 'vue'
import { useReviewer } from '@/composables/useReviewer'
import { READER_ID_RE } from '@shared/reactions.mjs'

// ── Reader identity (00 §7; built by #24, shared with #25/#26) ───────────────
// Not authentication: an anonymous per-browser id plus the self-declared
// reviewer name.
//   readerId   `anon-<uuid>`, created once per browser (localStorage
//              md-review-reader-id; in memory for the page lifetime when
//              storage is blocked). Reactions (#24) and views (#25) key on it.
//   readerName the reviewer name (md-review-reviewer), trimmed, ≤ 80; '' = anonymous.
//   readerKey  `name:<lower-cased name>` when a name is set, else readerId (pins, #26).

export const READER_ID_KEY = 'md-review-reader-id'

let memoryId: string | null = null

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `anon-${crypto.randomUUID()}`
  } catch { /* insecure context */ }
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `anon-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** This browser's reader id: the stored one, else a new one (stored when storage works). */
export function getReaderId(): string {
  if (memoryId) return memoryId
  let id: string | null = null
  try {
    const stored = localStorage.getItem(READER_ID_KEY)
    if (stored && READER_ID_RE.test(stored)) id = stored
  } catch { /* storage blocked */ }
  if (!id) {
    id = randomId()
    try { localStorage.setItem(READER_ID_KEY, id) } catch { /* in memory for this page only */ }
  }
  memoryId = id
  return id
}

/** Pure: the per-person key for a name/id pair (00 §7). */
export function readerKeyOf(name: string, readerId: string): string {
  const n = name.trim().slice(0, 80)
  return n ? `name:${n.toLowerCase()}` : readerId
}

/** Tests: forget the cached id (the next getReaderId() re-reads storage). */
export function _resetReaderId() { memoryId = null }

export function useReader() {
  const { reviewerName } = useReviewer()
  const readerId = getReaderId()
  const readerName = computed(() => reviewerName.value.trim().slice(0, 80))
  const readerKey = computed(() => readerKeyOf(readerName.value, readerId))
  /** Header value for X-MdReview-Reader (ISO-8859-1 safe). */
  const readerHeader = computed(() => ({ 'X-MdReview-Reader': encodeURIComponent(readerKey.value) }))
  return { readerId, readerName, readerKey, readerHeader }
}
