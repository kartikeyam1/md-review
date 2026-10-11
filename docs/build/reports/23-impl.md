# #23 View link vs edit link, edit tokens, expiry picker — implementation report

Worktree `md-review-vs-share`, branch `lane/share` (base integ/2). Not committed.

## Round 1 — implementation

### Server
- `server/routes/edit-tokens.cjs` (new): token issue (`mre_` + 32 random bytes base64url), sha256-hex hash storage, header parsing (`X-Edit-Token` / `Authorization: Bearer`, case-insensitive scheme, trimmed, disagreeing → 403), constant-time compare, `requireEdit()` write guard (404 → 413/400 → 401/403 → validation), `accessInfo()`, and `POST /paste/:id/edit-token` (rotate with token / one-time claim on legacy; compare-and-set so concurrent claims yield exactly one working token).
- Guard applied in `markdown.cjs`, `session.cjs` (DELETE, PUT /meta), `files.cjs` (POST/DELETE), `uploads.cjs` (start/chunk/complete). `storage.cjs`: `getEditTokenHash`, `setEditTokenHash` (CAS + version bump), `savePaste(opts.editTokenHash)`, ETag variant.
- Create returns `editToken, viewUrl, editUrl, url, app_url`; GET adds `id` + `access`; GET ETag varies with view/edit access on protected docs.
- `shared/expiry.mjs` (+ `.d.mts`): 1/7/30/90/null, other values → 30; used by create, PUT /meta (echoes `expiry_days`) and the FE picker.

### MCP / CLI
- `server/mcp-token-store.js` (new): persistent store (`MCP_TOKEN_STORE`, default `server/mcp-state/edit-tokens.json`, gitignored, 0600, atomic), shared by the stdio and HTTP servers.
- `mcp-server.js` / `mcp-server-http.js`: `editToken` on every write tool (arg → store → none), token fields on create, guidance on 401/403, shell tools embed the token or `$MDREVIEW_EDIT_TOKEN`, `get_session` sends the stored token (`access`).
- `cli.mjs`: create prints `editToken`/`editUrl`; `upload`/`add-file`/`patch` take `MDREVIEW_EDIT_TOKEN` or `--token`.

### Frontend
- `src/composables/useEditToken.ts` (new): `md-review-edit-tokens` map, pending `?edit=` tokens confirmed by the doc GET before being stored under the server id, `editHeaders`, `settleAccess`, `checkWriteStatus` + rejection listeners.
- `useShare.ts`: token on GETs and all writes; create stores the token; `putMetaDetailed`, `claimEditToken`.
- `useDocState.ts`/`docState.ts`: capability = `access.can_edit` (null/older server → editor).
- `ShareModal.vue`: view link, edit link under "Anyone with this link can edit", "Make view-only" (claim) for legacy docs, expiry picker + label; agent prompt only in review mode.
- `useRevisionTracking.ts`: History refreshes its list when opened on a live doc; `RevisionsModal`/`ShareModal`: Escape closes.

## Round 2 — review / QA fixes
| Finding | Fix | Test |
|---|---|---|
| (1) poll `can_edit:false` silently downgrades | `applyServerMeta` runs the same `loseEditAccess()` as a refused write: toast once, viewer, read view, `?view=edit|split` → `view=read` | e2e 23-fixes F1 (poll), QA-1 (refused save) |
| QA defect 1 — `?view=edit` kept after downgrade | rewritten in `loseEditAccess()` | e2e 23-fixes F1 ×2 |
| (2) viewer stuck with rejected edits / QA defect 2 | edits set aside as an unsaved local copy (`src/composables/localCopy.ts`, `md-review-local-copies`), `LocalCopyBanner.vue` ("Your unsaved changes (not on the server)", copy / download / discard), doc shows the server version, also after a reload (viewer draft → local copy in the loader); a 401/403 save is not a save error; no autosave / keepalive write / leave prompt for viewers (`useAutosave` `canWrite`) | e2e 23-fixes F2 ×2; unit `localCopy.test.ts` |
| (3) MCP store keying + cross-process loss | keys `${pasteApiUrl}|${idOrSlug}` with bare-key read fallback (migrated on next save); lock file + re-read/merge before atomic rename | server 23-fixes (scoped keys, isolation, fallback/migration, 3 processes × 60 saves, stale lock) |
| (4) coverage | e2e `createDoc({ protected: true })` → `editToken`; durable-sync save/conflict/"Keep my version" on a protected doc; AC-02.9 and AC-04.12 (edit/split/bogus) against a protected doc without a token (+ #6's "viewers never get the editor"; the lazy-chunk part waits for #6) | e2e 23-fixes F4 ×5 |
| Nit: Vary | `Vary: Authorization, X-Edit-Token` on GET /paste/:id (200 + 304) | server 23-fixes |
| Nit: no-store | `Cache-Control: no-store` on create and rotate/claim | server 23-fixes |
| Nit: hook side effect | `installEditTokenHook()` called from App.vue before `router.bootstrap()` | unit `useEditToken.test.ts` |
| Nit: CLI help | `MDREVIEW_EDIT_TOKEN` before `--token`; `--expiry` 1/7/30/90/none (verified applied) | server 23-fixes |
| Nit: hard-coded host | shell commands use `PASTE_PUBLIC_URL` → `PASTE_API_URL`; `10.0.99.151:3100` removed | server 23-fixes |
| uploads.cjs chunk-index issue | not touched (deprioritised by owner) | — |

## Frozen-test changes
None. (AC-23.11's "unsaved text still on screen" is met by the local-copy banner, whose body renders with the preview styles inside `.preview-pane`, expanded by default.)

## Pre-existing test changes (one mechanism each, intent kept)
- Server: `server/test-items/lib/edit-token-jar.mjs` (new) — suites opt in (`test.mjs`, 02, 20-fixes, 20-golden-compat, 20-sqlite-storage, `22-helpers.mjs`); writes to a suite's own docs present that doc's token.
- Server assertions: 20-fixes fix 2 (real `id` may be echoed; forged hash never stored); `lib/20-golden.mjs` additive keys `app_url`, `expiry_days` and `no-store` on token-carrying responses; raw-socket PUT in `test.mjs` sends the token.
- MCP store isolation: `scripts/verify.sh` exports `MCP_TOKEN_STORE` under the run dir; 22-fixes and 22-public-base-url pass it to spawned MCP processes; `test-mcp.mjs` uses a temp store.
- E2E: `tests/e2e/lib/legacy-docs.mjs` (new) — `docs.mjs` createDoc (legacy by default, `protected: true` opt-out), shared-mode, durable-sync, qa-gate create link-editable docs.

## Decisions
Appended to `docs/build/DECISIONS.md` under "Implementation decisions" (#23 and "#23 (review round)" lines).

## Gate
See the final summary below (one full `VERIFY_ITEMS=23 scripts/verify.sh`).

### Final full gate (`VERIFY_ITEMS=23 scripts/verify.sh`, run 20261010-184905-2378595)
typecheck PASS · unit PASS 191/191 · build PASS · server PASS 321/324 (0 fail, 3 skip: #21 upsert ×2, 20-real-data) incl. 23-fixes 11/11, 23-edit-tokens 39/40, 23-legacy 6/6, 23-cli 6/6, 23-mcp-tokens 15/16 · e2e 184/185 incl. 23-fixes 9/9, 23-view-edit-links 9/9.
OVERALL: FAIL on one e2e: `app.test.mjs` "code blocks are visually distinct" — `page.goto` 30 s timeout loading the local `?filePath=` fixture (no shared doc, no token path) under box load ≈ 6.4 on 4 CPUs (app step 317 s vs 223 s before).
Re-run of that file alone (run 20261010-185947-2400024): `e2e/app PASS 50/50`. Judged a load flake unrelated to #23.
