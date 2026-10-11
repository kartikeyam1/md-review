# #21 upsert by key — code review

Verdict: **PASS (no blockers)**. Scope reviewed: `git diff` + untracked `server/routes/by-key.cjs`,
`server/test-items/21-upsert-by-key.test.mjs`, `tests/e2e/items/21-upsert-by-key.test.mjs`; the 23-* edits only
remove the "#21 not landed" skip guards (as requested) and were not otherwise changed.

Evidence: `cd server && node --test test-items/21-upsert-by-key.test.mjs` → tests 26, pass 26, fail 0 (throwaway
backend). E2E (AC-21.12) not run by the reviewer.

Spec coverage checked: key regex + 400 `invalid_key` (rule 1); create defaults (pending, mode = body else
`defaultMode` → publish, 30-day expiry, slug → sessionName → key chain, reserved slugs, edit token) (rule 3);
update: token before validation, optional If-Match/base_hash with the same 412 body as `PUT /markdown`, no-op on
identical content, `noCoalesce` + `note`, slug ignored, expiry recompute/revive (rule 4); `note` on list and
single-revision endpoints (rule 5); GET with `expired:true` (rule 6); delete frees key (row delete, UNIQUE column)
(rule 7); body read then one synchronous `BEGIN IMMEDIATE` tx for lookup + write (rule 8); MCP tool in both servers
via `registerSharedTools`, `key:<key>` token-store entry, 10 MB guard, `author` default `agent` (rule 10); CLI
`publish` (rule 11).

## BLOCKER
None.

## SHOULD-FIX
1. **A later ordinary write can fold into a noted upsert revision** — `server/storage.cjs:237-243`. `noCoalesce`
   only stops the *upsert* from merging into the previous entry. The next non-upsert write by the same `by`/`client`
   within 5 min (e.g. MCP `update_markdown` right after `upsert_session`, both `client:'mcp'`; or the CLI `upload`
   after `publish` with the same author) passes the coalesce test and rewrites that revision's hash/blob, while the
   run's `note` stays on it — the note then labels content it does not describe, and the run's own content is no
   longer diffable. Fix: add `&& !last.note` to the `coalesce` condition (a noted revision is a sealed run). One
   server test: upsert with a note, then `PUT /markdown` with the same author/client → 2 entries, first keeps hash.
2. **A meta-only update silently drops `changeNote`** — `server/routes/by-key.cjs:628-631`. When only
   filename/contentType/sessionName change, the response says `changed:true` but no revision is recorded (content
   hash unchanged), so the note is lost. Reasonable behaviour, but not in DECISIONS.md; either document it there
   ("meta-only change: no revision, note discarded") or return a hint (e.g. `note_recorded:false`). Doc line is enough.

## NIT
3. `server/storage.cjs:358` — `RESERVED_SLUGS` in `slugTaken` ignores `selfId`/`releasing`: a legacy doc that
   already owns slug `list`/`by-key` would be renamed to `-2` on any PUT /meta that re-submits its slug. Pre-#21
   data only; acceptable, maybe a DECISIONS line.
4. `server/routes/by-key.cjs:661-672` — the response is written inside the tx, before COMMIT. With BEGIN IMMEDIATE
   a failing COMMIT is very unlikely, but if it ever throws the client already has a 201/200 for rolled-back data.
   Returning a status/body from the tx and sending after it commits would make this airtight.
5. `server/cli.mjs:144-154` — `publish` always sends `filename` = basename of the input; a job that writes to a
   temp file with a random name gets `changed:true` (and a filename flip) on every run even with identical content.
   Consider sending `filename` only on create or when `--filename` is given. Also `--slug/--author/--expiry/
   --filename` are accepted but not listed in the help text for `publish`.
6. `server/mcp-server.js:258` — a stale `key:<key>` token (doc deleted and re-created from another client) gives
   403 forever until `editToken` is passed; on 403 `edit_token_invalid` from a store-sourced token, the tool could
   say so explicitly ("stored token is stale; pass editToken").
7. `server/mcp-server.js:905-908` — `registerSharedTools` call sits under the "Resource" banner comment; move it
   above the banner. The stdio registration is not covered by a test (only HTTP); shared registration makes this low risk.
8. `src/components/RevisionsModal.vue:466,475-481` — a 500-char note with `pre-wrap` makes each list row very tall;
   consider a 3-line clamp (`-webkit-line-clamp`) with the full text in `title`. Rendering is text-only (`{{ }}`), so
   no HTML injection — the e2e asserts that.

## Coupling / later items
`registerSharedTools` is a good seam for #24/#25 MCP tools. `sessionByKey` returns expired rows by design (needed
for revive); #26 library filters must keep excluding expired docs themselves. No frozen tests edited beyond the
requested 23-* skip-guard removals.
