# 20 — SQLite + FTS5 storage, migration script, search endpoint

## Goal
Move session storage from loose JSON/gzip files to one SQLite database (`node:sqlite` `DatabaseSync`, Node 26) so the
backend can do full-text search, reactions (#24), view analytics (#25), library metadata (#26) and templates (#27),
without changing a single existing REST response. Existing data moves over with a verified, idempotent script.

## Scope / Out of scope
In: DB schema, storage layer swap inside `server/server.cjs`, `server/scripts/migrate-json-to-sqlite.mjs`,
`GET /library/docs` (the single list + search endpoint, contract in 00 §8), boot-time safety check, the final CORS
header list (00 §9), the server route-module structure (00 §4.9), rewritten storage-specific server tests.
Out: library UI (#26), template endpoints (#27), reaction/view endpoints (#24/#25 — only their tables are created
here), moving session file blobs or hosted-site files into the DB, any change to request bodies.

## Current state
- Meta per session in `DATA_DIR/<id>.json`, content in `<id>.content.gz` (`server/server.cjs:199-212`); a legacy
  inline `markdown` key is split out on first read (`server.cjs:268-298`).
- Revisions: list lives inside the meta JSON (`meta.revisions`), blobs in `revisions/<id>/<md5>.gz`
  (`server.cjs:302-385`); coalescing by same author+client within `REVISION_COALESCE_MS` (`server.cjs:362-379`),
  cap `REVISIONS_MAX` (`server.cjs:381`), seeding of pre-history sessions on first change (`server.cjs:345-358`).
- Comments + replies are arrays inside the meta JSON; comments passed at create time are stored verbatim and may
  lack an `id` (`server.cjs:608-640`, MCP `create_session` `comments: z.array(z.any())` `mcp-server.js:394`).
- Arbitrary extra keys posted to `POST /paste` are persisted and echoed by `GET` (`server.cjs:640`, `1208-1209`);
  live data has `expiry_days`, `contentType`, `approved_by`, `approved_at` etc. stored this way.
- Slugs: `_slug-index.json`, one namespace shared by sessions and hosted sites (`server.cjs:40-78`, `1580-1583`);
  sites: `_site-index.json` + `sites/<id>/` (`server.cjs:81-98`).
- Files: `files/<id>/…` walked on every list (`server.cjs:427-443`). Live data: 227 MB of files, 460 KB revisions.
- `GET /paste/list` reads every meta file per request (`server.cjs:1028-1066`). No search exists.
- Server tests poke JSON files directly (`server/test.mjs:535-567`, `731-750`).

## Behaviour
1. DB file: `DB_PATH` env, default `DATA_DIR/md-review.sqlite`. On open: `PRAGMA journal_mode=WAL`,
   `foreign_keys=ON`, `busy_timeout=5000`. Schema created with `CREATE … IF NOT EXISTS`; `schema_meta(key,value)`
   holds `schema_version` (starts at `1`). Forward migrations run in a transaction keyed on that version.
2. Required tables (column names normative where tests may read them; more columns allowed):
   - `sessions(id TEXT PK, slug TEXT UNIQUE NULL, session_name, filename, content_type, approval_status,
     approved_by, approved_at, shared_at, expires_at, callback_url, mode, upsert_key TEXT UNIQUE NULL,
     edit_token_hash NULL, created_by NULL, from_template_json NULL, extra_json TEXT NOT NULL DEFAULT '{}',
     version INTEGER NOT NULL, created_at, updated_at)` (`created_by`/`from_template_json` for #26/#27; `mode` per
     00 §1.4 — the migration writes the stored value if valid, else `review`)
     — `extra_json` keeps every other meta key verbatim so responses round-trip; `version` increments on every write.
   - `contents(session_id PK FK, markdown TEXT NOT NULL, content_hash TEXT NOT NULL)` (current content, plain text).
   - `revisions(session_id FK, seq INTEGER, hash, at, at_end NULL, by NULL, client NULL, size, parent NULL,
     writes NULL, seeded INTEGER NULL, note NULL, blob BLOB /*gzip*/, PK(session_id, seq))`.
   - `comments(pk INTEGER PK, session_id FK, ord INTEGER, id TEXT NULL, data_json TEXT)` and
     `replies(pk INTEGER PK, comment_pk FK, ord INTEGER, id TEXT, data_json TEXT)`; comment JSON must round-trip
     exactly, including absence vs `[]` of `replies`.
   - `files(session_id FK, name, size, type, updated_at, PK(session_id,name))` — metadata only; **blobs stay on disk**
     at `files/<id>/<name>`. Every file write/delete updates the row in the same handler.
   - `slugs(slug PK, kind 'session'|'site', target_id)`; `sites(id PK, slug, name, created_at, expires_at,
     file_count, spa)` (site files stay in `sites/<id>/`).
   - Created now for later items: `reactions` (#24), `views` (#25), `collections`, `collection_items`, `tags`,
     `session_tags`, `pins` (#26), `templates` (#27). Their columns are owned by those specs.
   - `doc_fts` FTS5 table (00 §8 "Index"): columns `title, filename, content`, `session_id UNINDEXED`,
     `file_name UNINDEXED`, `tokenize='unicode61 remove_diacritics 2'`, `prefix='2 3'`. This item writes one row per
     session with `file_name=''`; #26 adds rows for document files. `title` = the server `docTitle` (00 §5);
     `content` = the full current markdown (agent sections included), or for `contentType=html` the text with
     tags/scripts/styles stripped. Kept in sync inside the same transaction as every content/name/filename write and
     on delete.
3. Every write handler keeps the "no `await` between load and save" rule (`server.cjs:175-178`); each write is one
   `BEGIN IMMEDIATE … COMMIT` transaction.
4. Revision semantics are unchanged: coalescing, `REVISIONS_MAX` pruning (rows deleted), seeding a session whose
   revision list is empty on its first content change (`seeded: true`), comment/meta edits do not add revisions.
5. **Backward-compatible contract** — for every endpoint below, status codes, headers named here, and JSON bodies
   must deep-equal (key order not significant) what the JSON-file server returns for the same request sequence:
   - `POST /paste` → 200 `{id, slug?}`.
   - `GET /paste/:id` full → all stored meta keys except `revisions`, plus `markdown`, `content_hash`, `comments`,
     `revision_count`, `latest_revision{hash,at,by,client}|null`, `files` only when non-empty; `ETag`; 304 on
     matching `If-None-Match`; 410 `{error:'Session expired'}`; 404 `{error:'not found'}`.
   - `GET /paste/:id?fields=meta,content,comments,files` (meta omits `comments`, `content_hash`, `revisions`).
   - `GET /paste/:id/comments` → `{filename, comments}`; `GET /paste/:id/markdown` → `{filename, markdown}`.
   - Comments POST 201 / PUT 200 / DELETE 204, replies same, resolve/unresolve 200 → comment object.
   - `GET|PUT /paste/:id/approval` → `{approval_status, approved_by, approved_at}`; 400 invalid transition;
     409 `{error, unresolved_comment_ids}`; webhook payload `{sessionId, approval_status, approved_by, approved_at}`.
   - `PUT /paste/:id/markdown` → 200 `{ok, content_hash, filename}` + `ETag`; 412 `{error, content_hash, markdown,
     filename}`; 409 `{error, content_hash}`; 400 messages unchanged; delta/patch/base_hash rules unchanged.
   - `GET /paste/:id/revisions` → `{current, revisions:[{hash, at, at_end?, by, client, size, parent, writes?,
     seeded?}]}`; `GET /paste/:id/revisions/:hash|current` → `{hash, markdown, at, at_end, by, client, size,
     parent, is_current}`; 404 `unknown revision`; 410.
   - `GET /paste/list?status&name&limit` → array of `{id, slug, sessionName, filename, approval_status,
     comment_count, must_fix_unresolved, file_count, created_at, expires_at, updated_at, revision_count}`, newest
     `created_at` first, expired excluded. An invalid `name` regex must not crash the server (400 allowed).
   - `DELETE /paste/:id` 204 (removes rows, FTS row, slug, `files/<id>/`); `PUT /paste/:id/meta` →
     `{sessionName, slug, expires_at}`; upload start/chunk/complete; files list/get/post/delete; `/github`;
     `/site*`; `GET /` health.
   Additive fields introduced by #21–#25 (`id`, `access`, `upsert_key`, `note` on revisions, `editToken`…) are
   allowed; nothing may be removed or renamed. `edit_token_hash` must never appear in any response.
6. **List + search** `GET /library/docs` — request, semantics and response shape are **00 §8** (normative; there is
   no `GET /search`). This item implements all of it: list mode (no `q`) and FTS mode (tokenised, prefix-matched,
   ANDed, FTS syntax never 4xx/5xx, `bm25(doc_fts, 10, 5, 1)`), filters `collection|tag|mode|type|updated_after`
   (collection/tag tables exist but stay empty until #26), sort, opaque cursor paging (limit default 50, max 100),
   expired excluded. Fields owned by later items are returned as their documented empty values: `reaction_count:null`,
   `view_count:null`, `pinned:false`, `collection:null`, `tags:[]` until #24/#25/#26 fill them.
7. **Boot safety**: if the DB file does not exist **and** `DATA_DIR` contains legacy session `*.json` files
   (not starting with `_`), the server exits non-zero with a message naming the migrate script, unless
   `ALLOW_EMPTY_DB=1`. The server never reads or converts legacy JSON at boot.
8. **Migration script** `node server/scripts/migrate-json-to-sqlite.mjs --data-dir <dir> [--db <path>] [--dry-run]
   [--report <file.json>]`:
   - Reads the JSON layout read-only (never writes, renames or deletes anything under `--data-dir` except the DB
     file itself). `--dry-run` migrates into `:memory:` and runs the same verification, writing nothing.
   - Handles: inline legacy `markdown` in meta; missing content file (content `''`); comments without `id`;
     sessions with no `revisions`; slug index entries for sessions and sites; site index; files metadata walk.
   - Idempotent: re-running against an already-migrated DB inserts nothing new for unchanged sessions and
     re-verifies; a session whose source changed since is re-imported (replaced) and reported as `updated`.
   - Per session verification: content md5 equals source content md5 (and `content_hash` when present); comment
     count and per-comment reply counts equal; revision count and ordered hash list equal, every revision blob
     readable; file list `(name,size)` equal to the disk walk; slug resolves to the same id.
   - Corrupt meta JSON or unreadable gzip: session reported under `errors`, skipped, migration continues.
   - Prints a summary (`sessions: N migrated, M updated, K unchanged, E errors; revisions; comments; files; sites;
     slugs`) and per-failure lines; `--report` also writes it as JSON `{totals, sessions:[{id, status, checks}],
     errors}`. Exit 0 only when there are zero verification failures (corrupt sources count as failures).

## Acceptance criteria
AC-20.1 Given a fresh `DATA_DIR`, When the server starts, Then `md-review.sqlite` exists with all tables in rule 2 and `schema_meta.schema_version = '1'`.   [verify: server]
AC-20.2 Given the existing `server/test.mjs` request sequences (minus the JSON-file tests), When run against the SQLite server, Then every assertion passes unchanged.   [verify: server]
AC-20.3 Given a golden fixture data dir (≥10 sessions incl. extra meta keys, id-less comments, a comment without `replies`, inline-markdown meta, HTML session, files, slugs, a site) served by the old server and by the new server after migration, When the same GET requests are replayed, Then bodies deep-equal (ETag values may differ).   [verify: server]
AC-20.4 Given the fixture, When the script runs twice, Then run 1 reports all `migrated` with exit 0 and run 2 reports all `unchanged`, row counts identical between runs.   [verify: server]
AC-20.5 Given `--dry-run`, When run, Then no DB file is created and source files' mtimes/sha256 are unchanged, and the report is printed.   [verify: server]
AC-20.6 Given a fixture session with corrupt meta JSON, When migrating, Then it appears in `errors`, others migrate, exit code ≠ 0.   [verify: server]
AC-20.7 Given legacy `*.json` sessions and no DB, When the server starts, Then it exits non-zero and stderr names `migrate-json-to-sqlite.mjs`; with `ALLOW_EMPTY_DB=1` it starts.   [verify: server]
AC-20.8 Given docs titled "Weekly routing status" and one whose body contains "café", When `GET /library/docs?q=rout` and `?q=cafe`, Then each returns the matching doc whose `match.snippet` has a segment with `hit:true` whose text is "routing" / "café" (case as in the source) and `match.field` is `title` / `content`.   [verify: server]
AC-20.9 Given a title match and a body-only match for the same term, When searching (default sort), Then the title match ranks first.   [verify: server]
AC-20.10 Given `q` values `"`, `foo-bar`, `a:b`, `(`, `NEAR`, `*`, When searching, Then status is 200 every time.   [verify: server]
AC-20.11 Given an expired session containing the term, When searching and when listing, Then it is absent; after `PUT /meta {expiry_days:null}` it appears in both.   [verify: server]
AC-20.12 Given a doc whose content changes from "alpha" to "beta", When searching `alpha` then `beta`, Then only `beta` matches; after `DELETE /paste/:id` nothing matches.   [verify: server]
AC-20.13 Given `GET /library/docs` with no or blank `q`, Then 200 list mode: `query:null`, every item has `match:null`, items sorted by `updated_at` desc; `limit=500` returns ≤100 items with a non-null `next_cursor` when more exist, and following cursors visits every non-expired doc exactly once; `sort=bogus` → 400.   [verify: server]
AC-20.14 Given an HTML doc `<script>secretvar</script><p>visible words</p>`, When searching `secretvar`, Then no result; `visible` matches.   [verify: server]
AC-20.15 Given revision writes with `REVISIONS_MAX=3`, When 5 writes by alternating authors land, Then `/revisions` lists 3 and the oldest hash GET is 404.   [verify: server]
AC-20.16 Given any response, Then `Access-Control-Allow-Headers` equals the 00 §9 list, `Access-Control-Allow-Methods` includes `PATCH`, and `Access-Control-Expose-Headers` includes `ETag`.   [verify: server]

## Test hooks (data-testid list) and API/MCP contract changes
No UI. New endpoint `GET /library/docs` (00 §8). New env: `DB_PATH`, `ALLOW_EMPTY_DB`. New script file. Server tests
`test.mjs:535-567` (corrupt JSON/gzip) and `731-750` (seed via JSON edit) move to migration-script tests using
fixture dirs; seeding is tested by migrating a session that has no `revisions` and then writing to it.

## Edge cases the adversarial verifier must try
- Slug that is all hex (`cafe`) and also a real id prefix; slug shared between a site and a session in the source.
- Two concurrent `PUT /markdown` + `POST /comments` (existing concurrency test) — no lost write.
- 5 MB markdown doc: search snippet still returned; list still fast (<200 ms for 500 sessions).
- Emoji / CJK title search; offsets in `highlights` index correctly into UTF-16 strings.
- Kill the server mid-write (SIGKILL) — DB opens cleanly afterwards, no half-written session.
- Migration of a session whose `revisions` reference a missing blob → reported failure, not crash.

## Dependencies on other items (by number) and files likely touched
Blocks #21–#27. Tables for #24/#25/#26/#27 created here (incl. `created_by`/`from_template_json` session columns).
Search is unified with #26 (00 §8): this item ships `GET /library/docs`; #26 adds pins, document-file FTS rows and
the UI. Built in parallel with W1's FE lane but **merged after #2** (it must store and migrate #2's `mode`; the
golden-fixture comparison in AC-20.3 is against the JSON-file server at the commit just before this item, which
already includes #2). Files: `server/server.cjs` (becomes a route table), new `server/db.cjs` and
`server/routes/<area>.cjs` modules (00 §4.9), `server/scripts/migrate-json-to-sqlite.mjs`, `server/test.mjs`, new
`server/test-migrate.mjs` + `server/fixtures/legacy-data/`.

## Decisions
- File blobs and site files stay on disk; only metadata moves — 227 MB of binaries gain nothing in SQLite.
- Revision blobs move into the DB (gzip BLOB) — small (460 KB live) and makes backups a single file.
- Expired sessions excluded from search — consistent with `/paste/list`; data is retained, not deleted.
- Server refuses to boot on an un-migrated data dir — serving an empty DB would silently 404 every shared link.
- Unknown extra meta keys are kept in `extra_json` — required for byte-compatible GET responses.
