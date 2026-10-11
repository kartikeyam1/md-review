import { setEditTokenHandler } from '@/composables/useRouter'

// ── Edit tokens in the browser (#23 rule 9) ──────────────────────────────────
// A protected doc is editable only with its secret token. The browser keeps
// the tokens it holds in localStorage (`md-review-edit-tokens`, {[docId]:
// token}) and attaches `X-Edit-Token` to every write (and to the doc GETs, so
// the server reports `access.can_edit` for this browser).
//
// Where tokens come from:
//  - `?edit=<token>` on a doc URL: the router strips it before the first render
//    and hands it to onEditToken(slugOrId, token). It is held as *pending* for
//    that slug/id until the doc's GET (sent with it) says can_edit — only then
//    is it stored, under the id the server returned. A token for another doc is
//    never stored (the GET says can_edit: false).
//  - docs created in this browser (POST /paste returns the token);
//  - "Make view-only" (claim, POST /paste/:id/edit-token).
// A write refused with 401/403 drops the stored token and tells the listeners
// (the doc state switches to viewer and shows the "view-only" toast).
//
// Tokens are stored by id but docs are usually opened by slug, so the slug → id
// aliases of the docs we hold tokens for are persisted too
// (`md-review-edit-token-slugs`). Without them a full page load of /d/<slug>
// sent its first GET without the token, the server answered can_edit: false,
// and the stored token was dropped as "refused" (persona-QA blocker). A token
// is now dropped only when the GET that was refused actually presented it.

export const EDIT_TOKENS_KEY = 'md-review-edit-tokens'
export const EDIT_TOKEN_SLUGS_KEY = 'md-review-edit-token-slugs'

type TokenMap = Record<string, string>

function readMap(): TokenMap {
  try {
    const raw = localStorage.getItem(EDIT_TOKENS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TokenMap : {}
  } catch { return {} }
}

function writeMap(map: TokenMap) {
  try {
    if (Object.keys(map).length) localStorage.setItem(EDIT_TOKENS_KEY, JSON.stringify(map))
    else localStorage.removeItem(EDIT_TOKENS_KEY)
  } catch { /* storage unavailable: tokens last for this page only (pending) */ }
}

function readSlugs(): TokenMap {
  try {
    const raw = localStorage.getItem(EDIT_TOKEN_SLUGS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TokenMap : {}
  } catch { return {} }
}

function writeSlugs(map: TokenMap) {
  try {
    if (Object.keys(map).length) localStorage.setItem(EDIT_TOKEN_SLUGS_KEY, JSON.stringify(map))
    else localStorage.removeItem(EDIT_TOKEN_SLUGS_KEY)
  } catch { /* storage unavailable: aliases last for this page only */ }
}

/** Persist `slug → id` (only for docs whose token is stored; a slug names one doc at a time). */
function persistSlug(id: string, slug: string) {
  const map = readSlugs()
  if (map[slug] === id) return
  map[slug] = id
  writeSlugs(map)
}

/** Forget the persisted slugs of doc `id`. */
function forgetSlugs(id: string) {
  const map = readSlugs()
  let changed = false
  for (const [slug, target] of Object.entries(map)) if (target === id) { delete map[slug]; changed = true }
  if (changed) writeSlugs(map)
}

/** `?edit=` tokens not yet confirmed by the server, by the slug or id they arrived on. */
const pending = new Map<string, string>()
/** slug → id, learned from server responses (tokens are stored by id). */
const aliases = new Map<string, string>()
/** Tokens kept in memory when localStorage is unavailable (private mode, blocked storage). */
const memory: TokenMap = {}

const idOf = (key: string) => aliases.get(key) ?? readSlugs()[key] ?? key

/** Remember that `slug` names doc `id` (persisted when we hold that doc's token). */
export function learnAlias(id: string, slug?: string | null) {
  if (!slug || slug === id) return
  aliases.set(slug, id)
  if (readMap()[id]) persistSlug(id, slug)
}

/** The token this browser holds for a doc (by id or slug), pending ones included. */
export function tokenFor(key: string | null | undefined): string | null {
  if (!key) return null
  const id = idOf(key)
  return readMap()[id] ?? memory[id] ?? pending.get(key) ?? pending.get(id) ?? null
}

/** Store a token the server confirmed (or just issued) for a doc (by id, or by a slug already learned). */
export function saveToken(key: string, token: string, slug?: string | null) {
  const id = idOf(key)
  memory[id] = token
  const map = readMap()
  map[id] = token
  writeMap(map)
  learnAlias(id, slug)
  if (key !== id) learnAlias(id, key)
}

/** Forget the token for a doc (by id or slug). */
export function dropToken(key: string) {
  const id = idOf(key)
  for (const k of [...pending.keys()]) if (k === key || idOf(k) === id) pending.delete(k)
  delete memory[id]
  const map = readMap()
  if (id in map) { delete map[id]; writeMap(map) }
  forgetSlugs(id)
}

/** Headers presenting this browser's token for the doc `key` ({} when none). */
export function editHeaders(key: string | null | undefined): Record<string, string> {
  const t = tokenFor(key)
  return t ? { 'X-Edit-Token': t } : {}
}

export interface DocAccess { protected: boolean; can_edit: boolean }

/**
 * A doc GET for `key` came back: settle what we hold. `sent` is the X-Edit-Token
 * that GET carried (null: none); omitted, the token we hold for `key` is assumed.
 * can_edit → a pending token is confirmed and stored under the server's id;
 * a protected doc with can_edit false → the token we sent is no good: drop it.
 * Returns true when we hold a token for the doc that the GET did NOT present
 * (its slug was not known yet): the caller should re-send the GET with it
 * rather than treat the doc as view-only.
 */
export function settleAccess(
  key: string,
  data: { id?: string; slug?: string | null; access?: DocAccess },
  sent?: string | null,
): boolean {
  const presented = sent === undefined ? tokenFor(key) : sent
  const id = data.id || idOf(key)
  learnAlias(id, data.slug ?? (key !== id ? key : null))
  const access = data.access
  if (!access) return false
  const held = pending.get(key) ?? pending.get(id)
  pending.delete(key)
  pending.delete(id)
  if (access.can_edit) {
    if (held && access.protected) saveToken(id, held, data.slug)
    return false
  }
  if (!access.protected) return false
  const stored = tokenFor(id)
  if (!stored) return false
  if (presented && presented === stored) { dropToken(id); return false }
  return true
}

type RejectListener = (key: string) => void
const rejectListeners = new Set<RejectListener>()

/** Listen for writes the server refused with 401/403. Returns the unsubscribe function. */
export function onTokenRejected(fn: RejectListener): () => void {
  rejectListeners.add(fn)
  return () => { rejectListeners.delete(fn) }
}

/** The doc id for a key (slug → id once learned). */
export const docIdOf = (key: string) => idOf(key)

/** Every FE write calls this with its response status: 401/403 drops the token and notifies. */
export function checkWriteStatus(key: string, status: number) {
  if (status !== 401 && status !== 403) return
  dropToken(key)
  for (const fn of rejectListeners) fn(key)
}

/** True when `a` and `b` name the same doc (id or slug). */
export const sameDoc = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && idOf(a) === idOf(b)

/**
 * Register the router's `?edit=` hook (#4 rule 6). App.vue calls this before
 * router.bootstrap(), which strips the param and hands the token over.
 */
export function installEditTokenHook() {
  setEditTokenHandler((slugOrId, token) => { pending.set(slugOrId, token) })
}

/** Test hook: forget everything held in memory. */
export function __resetEditTokensForTests() {
  pending.clear(); aliases.clear()
  for (const k of Object.keys(memory)) delete memory[k]
}
