// Docs "created before #23" for e2e suites written before edit tokens existed.
//
// Since #23 a doc created with POST /paste is edit-protected: opened without its
// token it is view-only, and token-less REST writes get 401. The suites written
// before #23 (sync, routes, selection, review flows …) create docs over REST and
// then edit them in the browser and over REST as "another client" — their premise
// is a link-editable doc. asLegacyDoc() turns a fresh doc into exactly that: it
// clears its edit_token_hash in the throwaway backend's SQLite DB (E2E_DATA_DIR,
// exported by scripts/verify.sh), the state every pre-#23 doc is in (spec #23 rule 5).
// The #23 suites (tests/e2e/items/23-*) never use it.
import path from 'node:path'

export async function asLegacyDoc(id) {
  const dataDir = process.env.E2E_DATA_DIR
  if (!dataDir) throw new Error('E2E_DATA_DIR is not set — run through scripts/verify.sh (it exports the backend data dir)')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(dataDir, 'md-review.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const r = db.prepare('UPDATE sessions SET edit_token_hash = NULL WHERE id = ?').run(id)
    if (r.changes !== 1) throw new Error(`asLegacyDoc: no session row ${id}`)
  } finally { db.close() }
}
