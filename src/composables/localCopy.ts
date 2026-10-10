// ── Unsaved local copies (#23 review fix) ────────────────────────────────────
// When a shared doc turns view-only under the user (the edit token was rotated
// or the link never could edit), edits that never reached the server are kept
// as a *local copy* — not rendered as the document. They live in localStorage
// (`md-review-local-copies`, {[docId]: {markdown, filename, at}}) so a reload
// still offers them; the user copies, downloads or discards them.

export const LOCAL_COPIES_KEY = 'md-review-local-copies'

export interface LocalCopy {
  markdown: string
  filename: string
  /** ISO time the copy was set aside. */
  at: string
}

type CopyMap = Record<string, LocalCopy>

function readAll(): CopyMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_COPIES_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CopyMap : {}
  } catch { return {} }
}

function writeAll(map: CopyMap) {
  try {
    if (Object.keys(map).length) localStorage.setItem(LOCAL_COPIES_KEY, JSON.stringify(map))
    else localStorage.removeItem(LOCAL_COPIES_KEY)
  } catch { /* storage unavailable: the copy lasts for this page only */ }
}

export function loadLocalCopy(docId: string | null | undefined): LocalCopy | null {
  if (!docId) return null
  const c = readAll()[docId]
  return c && typeof c.markdown === 'string' ? c : null
}

export function saveLocalCopy(docId: string, copy: LocalCopy) {
  const map = readAll()
  map[docId] = copy
  writeAll(map)
}

export function clearLocalCopy(docId: string | null | undefined) {
  if (!docId) return
  const map = readAll()
  if (docId in map) { delete map[docId]; writeAll(map) }
}
