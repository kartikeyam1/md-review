# 23 — View link vs edit link, edit tokens, expiry picker

## Goal
Sharing a doc with leadership must not hand them the ability to rewrite it. New docs get a secret edit token: the
plain link is read-only, the edit link (carrying the token) lets you edit. Editors can also choose how long a doc
lives. Agents that create docs through MCP keep editing them without any extra step.

## Scope / Out of scope
In: token issue/verify/rotate/claim on the backend, which endpoints require it, `access` info on GET, share dialog
(view link, edit link, expiry picker), FE token storage, MCP token plumbing, CLI flag.
Out: user accounts, per-person permissions, protecting comments/approvals (see Decisions), revoking view access,
hardening beyond this (security work is tracked separately).

## Current state
- Every write endpoint is open to anyone who knows the id/slug (`server/server.cjs:647-1136`, `1221-1391`).
- CORS allows only `Content-Type, If-None-Match, If-Match, X-MdReview-Client` (`server.cjs:578`).
- Expiry: create accepts `expiry_days` 7/30 (else coerced to 30), `null` = never (`server.cjs:612-620`); meta PUT
  accepts 7/30/90 (`server.cjs:1104-1111`). No UI to change expiry exists.
- Share dialog shows one link + an agent prompt (`src/components/ShareModal.vue:1-62`); URLs built from
  `#shared=` (`src/composables/useShare.ts:153-159`); `createShare` returns only `id` (`useShare.ts:113-114`).
- MCP `create_session` returns `{id, slug, shareUrl}` (`server/mcp-server.js:114-116`); the HTTP MCP server
  auto-reinitialises unknown sessions, so per-connection state is not durable (`server/mcp-server-http.js:472-481`).

## Behaviour
1. **Issue.** `POST /paste` (and #21 upsert-create) generates `editToken` = `mre_` + 32 random bytes base64url.
   Only `sha256(token)` is stored (`sessions.edit_token_hash`). Create response adds
   `{editToken, viewUrl, editUrl, url, app_url}` (existing `{id, slug?}` unchanged), where
   `viewUrl` = `url` (00 §6: `share_url(x)` when `PUBLIC_BASE_URL` is set, else `app_url(x)`),
   `editUrl` = `app_url(x) + "?edit=" + editToken`. The raw token is
   returned only at creation/rotation/claim; no GET ever returns it.
2. **Present.** Clients send `Authorization: Bearer <token>` or `X-Edit-Token: <token>` (both present and
   disagreeing → 403). The CORS allow-headers already include `Authorization, X-Edit-Token` (full list set by #20,
   00 §9). Comparison is constant-time on the hashes.
3. **Protected writes** (session has `edit_token_hash`): `PUT /paste/:id/markdown`, `PUT /paste/:id/meta`,
   `DELETE /paste/:id`, `POST|DELETE /paste/:id/files…`, `POST /paste/:id/upload/start|chunk|complete`,
   `PUT /paste/by-key/:key` update (#21), mode changes (#2), and token rotation. Missing token → 401
   `{error:'Edit token required', code:'edit_token_required'}`; wrong token → 403
   `{error:'Invalid edit token', code:'edit_token_invalid'}`. Order: unknown doc → 404 first; then 413 / 400
   invalid JSON; then the token check (401/403); then all other validation (400/409/412). A rejected write changes
   nothing.
4. **Open actions** (no token, any viewer): all GETs, comments/replies CRUD, resolve/unresolve, approval
   transitions, reactions (#24), view recording (#25), search.
5. **Legacy sessions** (no `edit_token_hash`, i.e. everything created before this item) stay link-editable: every
   write succeeds with or without a token, and a presented token is ignored.
6. **Access info.** `GET /paste/:id` (full and `fields=meta`) gains additive
   `id` and `access: {protected: boolean, can_edit: boolean}`; `can_edit` is true for legacy docs or when a valid
   token is presented. Responses are otherwise unchanged (#20 contract).
7. **Rotate / claim.** `POST /paste/:id/edit-token`: on a protected doc requires the current token, returns
   `{editToken, editUrl}` and invalidates the old one; on a legacy doc anyone may call it once — the doc becomes
   protected (claim). Response 200 either way.
8. **Expiry.** Allowed values everywhere: `1, 7, 30, 90` days or `null` (never). `POST /paste` and
   `PUT /paste/:id/meta` accept the full set; other numbers keep the legacy coercion to 30 (compatibility). Setting
   expiry is a protected write. Expiry is computed from the time of the request. `PUT /meta` response gains
   additive `expiry_days` (number|null, what was applied).
9. **FE token handling.** On load of `/d/:x?edit=<token>` the app stores the token in localStorage map
   `md-review-edit-tokens` (`{[docId]: token}`, try/catch), then removes `edit` from the URL with
   `history.replaceState` (other params and hash kept). Docs the user creates in this browser store the returned
   token. All FE write calls attach `X-Edit-Token` when a token is known for that doc. If a write returns 401/403,
   the stored token is dropped and the UI shows a non-blocking `app-toast` "This link is view-only"
   (`data-toast="view-only"`, 00 §3.1) and switches to viewer capability. Capability (`viewer`/`editor`, 00 §1.2) =
   `access.can_edit` from the latest GET, computed in `useDocState` (00 §4.1) — this item replaces #2's interim
   "every shared doc is editor" source there. The token hook is #4's `onEditToken(slugOrId, token)`.
10. **Share dialog** (`share-dialog`, opened by `share-btn`, which only editors have — #2 rule 5; viewers copy the
    view link with `copy-link-btn`). Links shown in it are FE-built (00 §6): view link `<origin><base>d/<slug||id>`,
    edit link = view link + `?edit=<token>`. It always shows the view link (`share-view-url` + `share-copy-view`).
    When the user holds a token: shows the edit link (`share-edit-url` + `share-copy-edit`) under a warning
    "Anyone with this link can edit". Legacy docs show a single link labelled "Anyone with this link can edit" and a
    "Make view-only" button (`share-protect-btn`, calls claim, then shows both links). Editors see the expiry
    picker (`share-expiry-select`, options in order: 1 day, 7 days, 30 days, 90 days, Never; current value
    preselected; change applies immediately and shows "Expires {date}" / "Never expires" in `share-expiry-label`).
    The agent prompt section (review mode only) uses API URLs as today.
11. **MCP.** Handlers keep a persistent token store (`MCP_TOKEN_STORE`, default `server/mcp-state/edit-tokens.json`,
    file mode 0600, written atomically) mapping doc id and slug → token. `create_session` and `upsert_session`
    responses include `editToken`, `url`, `app_url`, `editUrl` (and keep `id`, `slug`; `shareUrl` = `url`) and save
    the token. Every write tool (`update_markdown`, `patch_markdown`, `update_session_meta`, `delete_session`,
    `add_file`, `remove_file`, `upload_chunk`, `upsert_session`) accepts optional `editToken`; precedence: tool arg →
    store → none. A successful call with an explicit `editToken` saves it to the store. On 401/403 the tool returns
    `{error, status, code}` with the message "This document is edit-protected. Pass editToken (returned when it was
    created) or ask the owner for its edit link." Shell-command tools embed `-H 'X-Edit-Token: …'` when the token is
    known, otherwise `-H "X-Edit-Token: $MDREVIEW_EDIT_TOKEN"` and say so in `instruction`. `create_via_shell`
    instruction tells the agent the JSON output contains `editToken` and to keep it. `get_session` exposes `access`.
12. **CLI** (`server/cli.mjs`): prints `editToken`/`editUrl` on create; `upload`/`add-file`/`patch` accept
    `--token` (or env `MDREVIEW_EDIT_TOKEN`).

## Acceptance criteria
AC-23.1 Given `POST /paste`, Then the response has `id`, `editToken` matching `^mre_[A-Za-z0-9_-]{43}$`, `viewUrl` without the token, `editUrl` ending `?edit=<editToken>`; the token string does not appear in the DB file.   [verify: server]
AC-23.2 Given a new doc, When `PUT /markdown` without token / with wrong token / with `Authorization: Bearer` / with `X-Edit-Token`, Then 401 `edit_token_required` / 403 `edit_token_invalid` / 200 / 200, and content changed only by the last two.   [verify: server]
AC-23.3 Given a new doc and no token, When posting a comment, a reply, resolving it and approving, Then all succeed.   [verify: server]
AC-23.4 Given a legacy session (no token hash), When `PUT /markdown`, `PUT /meta`, `DELETE` without a token, Then each succeeds; `GET` shows `access:{protected:false, can_edit:true}`.   [verify: server]
AC-23.5 Given a new doc, When `GET` without / with token, Then `access.can_edit` is false / true and no response contains `edit_token_hash` or the raw token.   [verify: server]
AC-23.6 Given rotation with the current token, Then the old token gets 403 and the new one 200; claim on a legacy doc makes token-less writes 401.   [verify: server]
AC-23.7 Given `PUT /meta {expiry_days: 1}` with token, Then `expires_at` ≈ now+24h (±1 min) and `expiry_days:1`; `{expiry_days:null}` clears it; without token → 401.   [verify: server]
AC-23.8 Given the app opened at `/d/<slug>?edit=<token>&view=split#intro`, Then the URL becomes `/d/<slug>?view=split#intro`, localStorage `md-review-edit-tokens` has the token, and the editor is available.   [verify: e2e]
AC-23.9 Given the app opened at `/d/<slug>` (no token) on a protected doc, Then no edit affordance is shown (`view-toggle`, `share-btn`, mode radios, `restore-revision` absent; `.app[data-capability=viewer]`), and `copy-link-btn` copies `<origin><base>d/<slug>` with no `edit` param.   [verify: e2e]
AC-23.10 Given an editor opens the share dialog and picks "7 days", Then a `PUT /meta` with `X-Edit-Token` and `expiry_days:7` is sent and `share-expiry-label` shows a date 7 days ahead.   [verify: e2e]
AC-23.11 Given a stored token that the server now rejects (rotated elsewhere), When the editor saves, Then `app-toast[data-toast="view-only"]` "This link is view-only" appears, the token is removed from localStorage and the UI switches to read mode without losing the unsaved text (draft kept).   [verify: e2e]
AC-23.12 Given MCP `create_session` then `update_markdown` without `editToken` (new MCP connection, same server process or after restart), Then the update succeeds using the persisted store.   [verify: server]
AC-23.13 Given MCP `update_markdown` on a protected doc not in the store and no `editToken`, Then the result contains `code:'edit_token_required'` and the guidance message.   [verify: server]
AC-23.14 Given a legacy doc's share dialog, When "Make view-only" is clicked, Then both links appear and a token-less `PUT /markdown` from another client returns 401.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `share-dialog`, `share-view-url`, `share-copy-view`, `share-edit-url`, `share-copy-edit`,
`share-edit-warning`, `share-protect-btn`, `share-expiry-select`, `share-expiry-label`; `app-toast[data-toast="view-only"]`
(replaces the earlier `toast-view-only`, 00 §10.1).
API: `editToken/viewUrl/editUrl/url/app_url` on create; `id` + `access` on GET; `POST /paste/:id/edit-token`;
401/403 codes; `expiry_days` 1/90 accepted on create; `expiry_days` echoed by `PUT /meta`. MCP: `editToken` arg on
write tools; token fields on create/upsert results; `MCP_TOKEN_STORE` env.

## Edge cases the adversarial verifier must try
- Token in `?edit=` for a different doc than the one opened (must not be stored under the wrong id).
- Bearer token with surrounding whitespace / lowercase `bearer`; both headers present and disagreeing (reject 403).
- Delete with the token, then re-create with the same slug: old token gives 404, not 200.
- Chunked upload: start with token, chunk without → 401.
- Legacy doc + claim race: two claims at once — exactly one token works.
- Expiry value `"7"` (string), `0`, `-1`, `365` → legacy coercion to 30, never a crash.

## Dependencies on other items (by number) and files likely touched
Depends on #20 (column), #22 (URL rule — lands first), #4 (`/d/` routes, `?edit=` param), #2 (capability/mode). Used by
#10 (upload token), #21, #25 (reader list gate), #26. Files: new `server/routes/edit-tokens.cjs` + the write-route guard,
`server/mcp-server.js`, `server/mcp-server-http.js`, `server/cli.mjs`, `src/composables/useShare.ts`,
`src/composables/useSync.ts` (merge after #8, which also edits it), `src/components/ShareModal.vue`,
`src/composables/useDocState.ts`, new `src/composables/useEditToken.ts`.

## Decisions
- Comments, replies, resolve and approval stay open — in review mode the reviewers *are* the viewers.
- Token-less writes on legacy docs keep working; "Make view-only" lets owners opt in.
- MCP tokens persist in one store shared by all MCP connections on that server — the HTTP transport silently
  re-creates sessions, so a per-connection cache would lose tokens; the MCP endpoint is internal and trusted.
- Invalid expiry numbers keep coercing to 30 days instead of 400 — existing agents send odd values.
