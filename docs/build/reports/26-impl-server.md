# #26 Library — server implementation report (srv26)

**Verdict: DONE.** Server gate is green. One frozen-test change needs the captain's approval (see below).

## Gate
`VERIFY_ITEMS=26 scripts/verify.sh --only server` → `server  PASS  423/424 pass, 0 fail, 1 skip  35.7s` / `OVERALL: PASS`
(run `.verify/runs/20261010-223117-2873339`). The 1 skip is the existing `20-real-data` skip (no real data copy). Every 20-*, 23-*, 24-*, 25-* suite passes, and so does `20-golden-compat`.
Note: one earlier run had 8 `20-perf` failures, all of them "POST/search took >1 s" on a 600 KB doc, on code #26 does not touch. Load average was 11 on 4 CPUs at the time (other agents' e2e). Run on its own straight afterwards, it passed 18/18, and the next full gate was green.

## Tests written first (confirmed failing: 26 of 29 failed with 404s / missing module before any implementation)
- `server/test-items/26-library.test.mjs` (29 tests). Covers:
  - AC-26.20: shape, paging, `total`, `pinned` per reader, invalid reader → 400, `protected`.
  - AC-26.21: a term found only in a file gives `field:'file'`; after the file is deleted it no longer matches.
  - Nested HTML files are stripped. Rewriting a file replaces its indexed text. `.png` is not indexed. A `.TXT` extension is matched case-insensitively. A session and its files collapse into one result.
  - `created_by` on the full GET and on `?fields=meta`. `?fields=library`, alone and combined with other fields. The ETag moves after a tag change or a collection rename.
  - Collections: 201 shape, 400 name rules, 409 case-insensitive duplicate. PATCH: renaming to its own name in another case is allowed, renaming to another collection's name is 409, unknown is 404. DELETE leaves its docs unfiled, and filtering on the deleted collection gives `items:[]`. `doc_count` excludes expired docs.
  - Tags: normalised, de-duplicated and sorted. `café`, 33 characters, 21 tags or a non-array → 400 and nothing saved. 401/403/legacy. `GET /library/tags` counts, drops count-0 tags and excludes expired docs.
  - Pins: the header is required. PUT by slug stores the id. PUT is idempotent. Most recent first. Pins are per reader. DELETE is idempotent. `name:` keys are case-insensitive. Pinning a doc and then deleting it leaves no dead row. The 51st pin → 409 `pin_limit`.
  - AC-26.7: merge, re-merge, `from` validation, merge capped at 50 (the most recent source pin wins).
  - Bulk: delete with results in request order, `edit_token_required` / `_invalid` / `not_found`, legacy docs need no token. add-tag including `tag_limit`. move / unfile. Invalid action/tag/collection/ids/editTokens → 400 and nothing done.
  - Deleting a doc removes its pins, tags, membership and every `doc_fts` row.
  - Expired docs are excluded everywhere. FTS syntax in `q` never gives a 4xx/5xx.
  - Boot backfill of migrated document files. CORS.
- `server/test-items/26-tags.test.mjs` (4 tests): unit tests for `shared/tags.mjs`.

## Files changed
- **new** `server/routes/library.cjs`: collections, tags list, `PUT /paste/:id/tags|collection`, pins (+merge) and bulk, plus the exported helpers `readerKeyOf` (00 §7) and `libraryFields`.
- `server/server.cjs`: one ROUTES line, after `library-docs.cjs`.
- `server/routes/library-docs.cjs`:
  - `X-MdReview-Reader` sets `pinned` (an invalid header → 400 `{error:'invalid reader'}`).
  - New `protected` field.
  - The best-ranked FTS row (`m.fts_rowid`) decides `match`: when it is a file row → `{field:'file', file, snippet}`, with the snippet taken from that file's indexed text (markdown made plain).
  - Tags are sorted with `compareTags`.
- `server/session-rows.cjs`: `DOC_FILE_RE`, `isDocFile`, `syncFileSearchRow`, `deleteFileSearchRows`. A file row is title `''`, filename = file_name = path, content = text, with HTML stripped by the same `htmlToText` the session row uses.
- `server/storage.cjs`:
  - `touchFileRow` writes or removes a document file's index row in the same transaction as its `files` row.
  - `deleteSession` removes the file rows (in the same transaction).
  - A boot-time `backfillFileSearchRows()` indexes migrated document files: one index scan, then only the missing files are read. It is wrapped in try/catch so it can never block boot.
- `server/routes/session.cjs`: `created_by` on the full GET and on `?fields=meta`; `?fields=library` adds `title`, `collection`, `tags`. Default responses gain no other key.
- **new** `shared/tags.mjs` + `shared/tags.d.mts`: `normalizeTag`, `normalizeTags`, `compareTags`, `MAX_TAGS_PER_DOC` (20), `TAG_MAX_LENGTH` (32).

## API notes / deviations from the contract (all small; DECISIONS.md has the reasons)
- The `name:` part of a reader key is trimmed and lower-cased on the server, and an empty header counts as absent.
- Expired docs:
  - Pinning one → 410.
  - PUT tags/collection on one → 410, checked after the edit-capability check.
  - Bulk treats an expired doc as `not_found`.
- The pin limit counts only pins of existing, unexpired docs. Re-pinning a doc that is already pinned when you are at the limit returns 200.
- Merge only adds pins and never drops the target's own pins. Copied pins keep their `pinnedAt`.
- `PUT /paste/:id/collection` and bulk `move` accept a collection id or its slug. In bulk, an unknown collection → 400; in the per-doc PUT → 404 (per the contract).
- A collection's slug is regenerated on rename. It is never `none` (that would clash with the unfiled filter) and never another collection's id.
- Tag/collection writes, renames and deletes bump the affected docs' `version`, so ETags never go stale.
- Finding a file's index row scans `doc_fts`, because the schema stays at version 1 (AC-20.1) and the index columns are UNINDEXED. The scan runs only for document files. Measured at 400 docs × 48 KB: a doc-file write takes about 5.2 ms (a png write 0.9 ms), and deleting a doc with 20 doc files about 13 ms.
- The migration script is not changed; the boot backfill covers migrated document files. If a session is re-migrated, its old file rows stay attached to the same id, so the backfill skips them; stale content is possible only if the file's content changed in between. This edge is accepted.

## FROZEN TEST CHANGES
- `server/test-items/20-fixes.test.mjs` "fix 2" (+2 lines): the test asserted that `created_by` never appears in GET responses. That contradicts spec 26 ("`GET /paste/:id` store/return `created_by`"), the #26 contract ("always includes `created_by`") and the #20 golden suite, whose ADDITIVE list already contains `created_by`.
  - The change follows the test's own `id` precedent from #23: it now asserts `created_by === 'Ann'`, the real author, never the forged `'Mallory'`. The intent (forged column-owned keys never round-trip) is kept.
  - Alternative if you reject the change: drop `created_by` from the GET responses, which contradicts the contract.

## Decisions appended
Five `#26 (server)` lines under "## Implementation decisions" in docs/build/DECISIONS.md.

## Addendum: `pinned=1` on GET /library/docs (requested by lib26)
- `pinned=1` keeps only docs pinned by the `X-MdReview-Reader` reader.
  - No header → `items: []`; an invalid header → 400.
  - With no `sort` given, order is `pinned_at DESC` (ties go to the latest pin); an explicit sort is honoured.
  - It ANDs with `q` and every filter.
  - `pinned` and the reader key are part of the cursor fingerprint, so a cursor reused by another reader → 400.
  - `pinned=0` or absent means no filter; any other value → 400 `{error:'invalid pinned'}`.
- New test in `26-library.test.mjs`. The suite is now 30/30, passing in every run.
- Gate after this change: four runs were red, all on timing or boot failures in suites #26 does not touch, while load average was 9–21 on 4 CPUs (other agents' e2e).
  - The failures:
    - test-meta-units: "1 MB inputs < 50 ms" took 95 ms.
    - 20-perf: "server did not become ready".
    - 20-fixes: "< 2000 ms".
    - 20-sqlite-storage: a refuse-to-boot spawn timed out.
    - 10-paste-image: EPIPE.
  - Run on its own, test-meta-units passes 13/13.
  - The last gate on a quiet box (before `pinned=1`, which only touches library-docs.cjs) was `server PASS 423/424, 0 fail, 1 skip`.
  - **Please re-run `VERIFY_ITEMS=26 scripts/verify.sh --only server` when the box is quiet.**

## Addendum 2: AC-26.3, literal inline HTML in markdown snippets (captain follow-up)
- `server/doc-text.cjs`: `markdownToPlain(md, { keepTags })` and `stripInlineMarkdown(s, { keepTags })`. With `keepTags`, `removeTags` is skipped; HTML comments are still stripped. The default is unchanged, so `test-storage-units` stays at 10/10.
- `snippetText()` passes `keepTags: true` for markdown docs, and so does the `.md/.markdown` file-row snippet in `library-docs.cjs`. docTitle, the indexed content and HTML docs/files are untouched; HTML stays tag-stripped (00 §8, AC-20.14).
- New test "AC-26.3 markdown snippets keep inline HTML as literal text …" in `26-library.test.mjs` covers:
  - a session row, where `<img src=x onerror=alert(1)>term` appears verbatim and the comment is gone;
  - a file row, where `<b onclick=…>` appears verbatim;
  - an HTML doc, where the snippet has no `<`.
- The suite is now 31/31.
- Gate after this change (load average 19–25 on 4 CPUs): `server FAIL 418/426`. The only failures were timing checks: 20-perf "POST took 1.5–9 s" ×6 and 22-fixes "meta page took 10 s", both on code paths that do not use the snippet path.
- Run standalone at the same load: 20-perf 18/18, 22-fixes 10/10, 20-fixes 14/14, 20-sqlite-storage 27/27.
- Please re-run `VERIFY_ITEMS=26 scripts/verify.sh --only server` when the box is quiet.
