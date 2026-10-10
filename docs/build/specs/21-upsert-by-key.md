# 21 — Upsert by key (stable URL per recurring doc)

## Goal
Agents that publish the same report every day/week (status updates, QA findings) should get one stable URL whose
history shows each run, instead of a new session per run. One call: create if the key is new, otherwise publish the
new content as a revision with a change note.

## Scope / Out of scope
In: `PUT /paste/by-key/:key`, `GET /paste/by-key/:key`, key rules, revision `note`, concurrency, MCP
`upsert_session` tool (stdio + HTTP), CLI `publish` command.
Out: renaming/re-keying via UI, listing by key prefix in the library (#26 may add a filter), comment carry-over
logic (comments simply stay on the doc).

## Current state
- Creating always mints a new random id (`server/server.cjs:622`); slug uniqueness appends `-2`, `-3`
  (`server.cjs:59-65`), so a recurring job re-using a slug gets a new URL each run.
- Content replace exists (`PUT /paste/:id/markdown`, `server.cjs:913-986`) with If-Match/412
  (`server.cjs:951-960`); revisions record `by`/`client` and coalesce same-author writes within 5 min
  (`server.cjs:362-379`) — consecutive automated runs within the window would fold into one revision.
- MCP has `create_session` and `update_markdown` but nothing that does both (`server/mcp-server.js:92-208`).

## Behaviour
1. **Key rules.** `key` matches `^[a-z0-9][a-z0-9._:-]{0,127}$` (lowercase, 1–128 chars). Anything else → 400
   `{error:'Invalid key', code:'invalid_key'}`. Keys are exact-match and unique across all sessions
   (`sessions.upsert_key`). Recommended (documented, not enforced) form `<owner-or-tool>:<doc-name>`, e.g.
   `factory:dp-weekly-status`. Keys are not slugs and are never shown in URLs.
2. **`PUT /paste/by-key/:key`**, JSON body:
   `{markdown (required string), filename?, contentType?, sessionName?, slug?, mode?, expiry_days?, changeNote?,
   author?}`. Max body as today. `changeNote` ≤ 500 chars (trimmed; longer → 400).
3. **Create** (no live session with this key): behaves like `POST /paste` with the same body (defaults:
   `approval_status:'pending'`, mode per 00 §1.4 — body `mode`, else `publish`; expiry default 30 days), stores the
   key, slug (never a reserved slug, 00 §6) from
   `slug` → `sessionName` → key with `:`/`.` replaced by `-`; issues an edit token (#23). Response **201**
   `{id, slug, key, created:true, changed:true, revision:<content_hash>, url, app_url, editToken, editUrl}`.
4. **Update** (key exists): protected write per #23 (token required unless legacy-style doc without token hash).
   - If-Match header (or `base_hash` body field) is optional; when given and stale → 412 with the same body shape as
     `PUT /markdown` 412.
   - If the new markdown hashes equal to the current content and no meta field changes: no new revision, response
     **200** `{…, created:false, changed:false, revision:<current hash>}`.
   - Otherwise content is replaced and **always** recorded as a new revision (never coalesced with the previous
     one, regardless of author/time), with `note` = `changeNote` (omitted when absent), `by` = `author` (default
     `null`; MCP default `agent`), `client` as usual. `filename`, `contentType`, `sessionName` update when provided.
   - `slug` in the body is ignored on update (URL stays stable); `url`/`app_url` are identical across runs.
   - `expiry_days` provided → expiry recomputed from now; absent → on an **expired** keyed doc the expiry is reset to
     30 days (the doc is revived); on a live doc unchanged.
   - Comments, reactions, views, files are kept. Response **200**
     `{id, slug, key, created:false, changed:true, revision:<new hash>, url, app_url}` (no `editToken`).
5. **Revision note.** Revision list entries gain optional `note` (only present when set), visible in
   `GET /paste/:id/revisions` and MCP `list_revisions`; `GET /revisions/:hash` includes `note` (null when absent).
   The revisions UI shows the note under the entry (`revision-note`).
6. **`GET /paste/by-key/:key`** → 200 `{id, slug, key, revision, updated_at, url, app_url}`; 404 if unknown;
   expired docs return 200 with `expired:true` (so jobs can see the doc will revive). No token needed.
7. **Deletion** frees the key and slug; the next upsert creates a fresh doc (new id, new token, `created:true`).
8. **Concurrency.** The key lookup and insert/update run in one synchronous transaction after the body is read.
   Two simultaneous first upserts for one key yield exactly one session: one 201 `created:true`, the other 200
   or 401 (the loser is treated as an update of the doc the winner just created, so it needs that doc's token,
   which it does not have). Upserts and `PUT /markdown` on the same doc serialise.
9. **Response `revision`** is the `content_hash` (md5 hex, 32 chars) also returned as `ETag`.
10. **MCP `upsert_session`** (both servers), input `{key, markdown, filename?, contentType?, sessionName?, slug?,
    expiryDays?, changeNote?, author?, expectedContentHash?, editToken?}`; description says: "Publish a recurring doc
    under a stable key: creates it the first time, otherwise adds a new revision; the URL never changes." Uses the
    #23 token store (saves the token on create; uses arg → store on update). Returns the REST body plus
    `shareUrl` (= `url`). Content is sent in one request (no chunked flow); content > 10 MB is rejected by the tool
    with an error suggesting `create_via_shell`/CLI `publish` (the server body limit stays 50 MB).
11. **CLI**: `md-review publish <key> <file> [--name] [--note] [--token]` → prints `url`, `revision`, `created`.

## Acceptance criteria
AC-21.1 Given an unused key `test:weekly`, When `PUT /paste/by-key/test:weekly {markdown:"v1"}`, Then 201 with `created:true`, `changed:true`, a 32-hex `revision`, `editToken`, and `url` ending `/d/<slug>`.   [verify: server]
AC-21.2 Given AC-21.1's doc, When upserting `v2` with the token and `changeNote:"run 2"`, Then 200 `created:false`, same `id`/`slug`/`url`, new `revision`; `/revisions` last entry has `note:"run 2"`; total revisions = 2.   [verify: server]
AC-21.3 Given two upserts by the same author 10 s apart with different content, Then two separate revisions exist (no coalescing).   [verify: server]
AC-21.4 Given an upsert with content identical to current, Then 200 `changed:false`, revision count unchanged.   [verify: server]
AC-21.5 Given a keyed doc with a token, When upserting without a token, Then 401 `edit_token_required` and content unchanged.   [verify: server]
AC-21.6 Given keys `Test`, `-x`, `a b`, `a/b`, 129 chars, Then each → 400 `invalid_key`.   [verify: server]
AC-21.7 Given a stale `If-Match`, Then 412 with `content_hash` + `markdown` of the current doc.   [verify: server]
AC-21.8 Given a keyed doc that has expired, When upserted without `expiry_days`, Then 200, `GET /paste/:id` is 200 again and `expires_at` ≈ now+30d.   [verify: server]
AC-21.9 Given the keyed doc is deleted, When upserted again, Then 201 `created:true` with a different `id`, and the old slug is reused if free.   [verify: server]
AC-21.10 Given two parallel first-time upserts (both with no token), Then exactly one session with the key exists; one response is 201, the other 401.   [verify: server]
AC-21.11 Given MCP `upsert_session` called twice from separate MCP connections without `editToken`, Then the second returns `created:false` with the same `url` (token taken from the store).   [verify: server]
AC-21.12 Given a revision with a note, When the revisions modal is opened in the app, Then `revision-note` shows the note text for that entry.   [verify: e2e]
AC-21.13 Given `GET /paste/by-key/unknown:key`, Then 404; for an existing key, 200 with the current `revision`.   [verify: server]

## Test hooks (data-testid list) and API/MCP contract changes
Testid: `revision-note` (inside each revisions-modal entry). API: `PUT|GET /paste/by-key/:key`; optional `note` on
revision entries. MCP: new `upsert_session` tool. CLI: `publish`.

## Edge cases the adversarial verifier must try
- Key that equals an existing slug or id (`cafe`) — key and slug namespaces must not interfere.
- Upsert with `slug` that is taken by another doc on create → suffixed slug, response shows the real one.
- `changeNote` with HTML/markdown — returned verbatim, rendered as text (no HTML injection in the modal).
- Upsert of an HTML doc then a markdown run (contentType switch) — stored and rendered as the new type.
- Upsert immediately followed by `PUT /markdown` from the UI with the old hash → 412.

## Dependencies on other items (by number) and files likely touched
Depends on #20 (`upsert_key` column, transactions), #23 (tokens, store), #22 (URL rule; `url`/`app_url` per 00 §6).
`/paste/by-key/*` must be routed before the `/paste/:id/*` routes (`by-key` is a reserved slug). Files:
new `server/routes/by-key.cjs` (00 §4.9), `server/mcp-server.js`, `server/mcp-server-http.js`, `server/cli.mjs`,
`src/components/RevisionsModal.vue`, `src/composables/useShare.ts` (RevisionEntry `note`).

## Decisions
- Upsert revisions never coalesce — each run must be a distinct, diffable revision.
- Updating an expired keyed doc revives it — the whole point is a URL that keeps working for recurring reports.
- Keys are lowercase-only and validated, not normalised — silent normalisation could merge two different jobs.
- The create-race loser gets 401 rather than silently overwriting — it never held the token.
