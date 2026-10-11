# #26 Library — server code review (reviewer)

**Verdict: PASS — no blockers.**
**Scope:** the working-tree diff and untracked files under `server/**` and `shared/tags.mjs` / `shared/tags.d.mts`. Checked against spec 26, 00 §7/§8/§9 and the captain's contract `26-contract.md`. I did not review the FE files.

**Evidence:** `node --test server/test-items/26-library.test.mjs server/test-items/26-tags.test.mjs server/test-items/20-fixes.test.mjs` (Node v26.8.2) → `tests 48, pass 48, fail 0`. I did not run the full gate, as instructed.

## Frozen-test change: APPROVE
`server/test-items/20-fixes.test.mjs:62-63`. The old assertion said `created_by` is never echoed. The following all say it should be returned:
- spec 26 line 156: "`GET /paste/:id` store/return `created_by`"
- the contract
- DECISIONS line 62: "#26 exposes it"

The new assertion follows the `id` precedent from #23. It checks that `created_by` is the real author (`'Ann'`), never the forged value, so the test's intent is kept.

## BLOCKER
None.

## SHOULD-FIX
1. **`pinned=1` is an undocumented API extension.** It is in `server/routes/library-docs.cjs:89-92,127-131,153-156`. Neither 00 §8 nor the contract lists a `pinned` query param or a `pinned` sort, but `src/composables/useLibrary.ts:149` depends on it.
   - The behaviour is sound. The cursor fingerprint includes the reader key, there are no pins without a reader → `items:[]`, and pins are ordered by `pinned_at`.
   - Fix: add a `- #26 (server): GET /library/docs?pinned=1 …` line to DECISIONS (or have the captain amend the contract), so that #27+ and the MCP know it exists. There are already 2 tests for it.
2. **The comment on `PUT /library/pins` is misleading.** In `server/routes/library.cjs:262-268`, the `existing` check returns early for any existing row, so the `INSERT OR REPLACE` never replaces anything. The comment "a pin row of an expired doc may linger: replace it" is therefore wrong.
   - Fix: use a plain `INSERT` and drop the comment.
   - Alternatively, if re-pinning a doc after its expiry was extended should refresh `pinnedAt`, say so and handle it explicitly.

## NIT
3. `readerKeyOf` (`library.cjs:57`) lower-cases a `name:` key *after* decoding, then applies the 80-character check. A name that grows when lower-cased (e.g. `İ` → `i̇`, 2 code points) can exceed 80 and get a 400 even though the FE trimmed it to 80.
   - Fix: check the length before lower-casing. This is an edge case.
4. Orphan tags are only cleaned in `setDocTags`. `deleteSession` (single or bulk) leaves rows in `tags` that no doc uses. They are harmless, because `GET /library/tags` inner-joins and a tag filter gives `[]`. Calling `dropOrphanTags()` after a bulk delete would keep the table tidy.
5. `syncFileSearchRow` / `deleteFileSearchRows` (`session-rows.cjs:229-240`) do a full `doc_fts` scan on each document-file write, because the columns are UNINDEXED. This is acceptable at the measured scale (~5 ms at 400×48 KB) and is documented in DECISIONS.
   - The cost grows linearly with total indexed bytes, so it is worth revisiting when the schema version next bumps: store `fts_rowid` on the `files` row, as the `sessions` row already does.
6. `matchFor` makes one extra `doc_fts` lookup by rowid per result item. This is cheap (≤100 lookups by primary key) and needs no change.

## Checked and fine
- **Route order:** `library.cjs` comes before `session.cjs`, and `PUT /paste/:id/tags|collection` is not caught earlier.
- **CORS (§9):** PATCH and `X-MdReview-Reader` are already in the shared headers.
- **Delete cascades:** FKs are `ON DELETE CASCADE` with `foreign_keys=ON`, so a deleted doc loses its pins, tags and membership. `deleteSession` removes its file FTS rows in the same transaction.
- **File index:** `touchFileRow` reads the file after it has been written. There is no file-rename path that bypasses it, and it is the only `DELETE FROM files`.
- **Bulk:** results come back in request order. The token is looked up by the id as given, and legacy docs need no token, matching `requireEdit`. Bad action/tag/collection/ids → 400 before anything is done.
- **Tags:** `shared/tags.mjs` rejects rather than strips, ASCII-only lower-casing stops KELVIN SIGN from passing, and the `.d.mts` matches the code.
- **`?fields=library` and default GET:** adds only `created_by` (golden list ADDITIVE). ETags move because tag/collection writes bump `version`.

## POLISH (security — owner deprioritised)
- Collections create/rename/delete need no capability (per the contract), so anyone can rename or delete every collection.
- Pins key on a self-declared name, so anyone can read or alter `name:<x>`'s pins, or merge any `reader_id`'s pins into their own.
- Bulk delete/move/tag of legacy (no-token) docs needs no credential. This matches the single-doc routes, but a single 500-id request can now wipe every legacy doc.
- Bulk delete runs up to 500 synchronous `fs.rmSync` calls on the event loop. A rate or size limit would bound the stall.
- Document files are indexed in full: an asset can be up to 10 MB, all read and FTS-tokenised in one transaction. A cap like the session row's would bound this, though the session row is uncapped too.
