# #26 Library + multi-file sessions — fix round (single round, all findings)

Worktree `md-review-cap-library` (lane/library), not committed. Inputs: 26-review-server.md, 26-review-fe.md, 26-qa.md.
Security-hardening findings go to `docs/build/POLISH.md` under `## #26` (the file did not exist on this lane; created with the standard header).

## Server review (26-review-server.md)
| # | Finding | Outcome |
|---|---|---|
| SHOULD-FIX 1 | `?pinned=1` undocumented | **Fixed (docs).** The DECISIONS line existed (`#26 (server): GET /library/docs?pinned=1 …`); amended to say it is an extension beyond 00 §8 and the captain's contract, that this line amends the contract, the `pinned=0`/invalid → 400 rule, and that MCP / #27+ may rely on it. Tests already present (`26-library.test.mjs` "pinned=1 keeps only…"). |
| SHOULD-FIX 2 | misleading `INSERT OR REPLACE` comment | **Fixed.** `PUT /library/pins/:docId` uses a plain `INSERT`; the comment now says any existing row answers first. Covered by the existing idempotent / limit pin tests. |
| NIT 3 | length check after lower-casing | **Fixed.** `readerKeyOf` checks `name:<trimmed>` against the 80-char rule before lower-casing. New test "a name key is length-checked before lower-casing" (80 × `İ` accepted, 81 × `a` → 400). |
| NIT 4 | orphan tags after delete | **Fixed.** `storage.deleteSession` drops tags no doc uses when the deleted doc had tags (covers single delete, bulk delete and the expiry sweep). New test "deleting a doc (single and bulk) drops tags no other doc uses; shared tags stay". |
| NIT 5 | doc_fts scan per doc-file write | **Logged** as a known follow-up in DECISIONS (store `fts_rowid` on `files` when the schema version next bumps; #26 must not bump it). |
| NIT 6 | `matchFor` lookups | No change (reviewer: none needed). |
| POLISH ×5 | collections/pins/bulk/rmSync/index size | → POLISH.md `## #26`. |

## FE review (26-review-fe.md)
| # | Finding | Outcome |
|---|---|---|
| SF 1 | leave guard ignores file tabs as "from" | **Fixed** in `useDocLoader.guardLeave`: `fromAttached` = the doc or one of its file tabs; `showing = fromAttached && screenKey === from.key`, so the file tab is `held` on screen while deciding and Cancel pushes back the file tab's URL. e2e `26-files` "leave guard from a file tab …" (stalled PUTs → type → file tab → Library: no library render while deciding, the confirm, URL back on the file tab, tab selected). |
| SF 2 | dead `fileView` plumbing | **Fixed.** Removed `fileView`/`setFileView`/revoke logic from `docState.ts` and the 5 calls in `useDocLoader.ts` (typecheck proves no reader left). |
| SF 3 | cross-origin `<a download>` | **Fixed.** `openFile` gives the download card a blob URL (revoked like images); `download()` fetches the file and clicks a blob-URL anchor (toast on failure). e2e "a download card and a download attachment save the file from a blob URL; the app tab stays" (card href `blob:`, `download` events with `data.bin`, URL unchanged, bytes intact). |
| SF 4 | destructive confirm focuses OK | **Fixed.** The confirm starts on Cancel. Asserted in `26-library` AC-26.11 and in `26-files` AC-26.18 (focus on `file-confirm-cancel`). |
| SF 5 | History/Restore/Document mode on file routes | **Fixed, option (b)** (least surprising: nothing changes the doc out of sight): on a file route the overflow menu has no History and no Document mode, its unseen-changes dot is off, and the "changed since you last looked" banner (whose View opens History) is hidden; all are one click away on the primary tab. DECISIONS line added. e2e "a file route offers no History or Document mode …; the primary tab does …". |
| NIT finally | duplicate branches | **Fixed** (`loadingMore = false`). |
| NIT fetchLibrary | extra GET per poll | **Fixed.** `?fields=library` on the doc's first payload, then only on payloads whose `content_hash` is unchanged (a collection move bumps the version alone). e2e "the collection is re-read on meta-only polls (a move), not on every remote content change" (two remote edits → no extra read; a move → breadcrumb collection appears). |
| NIT store import | unhandled rejection, blank forever | **Fixed** in `useSessionFiles.ts`: the import has a rejection handler, is retried on the next payload or file open, and a file open that still cannot load it shows a notice. (No offline e2e: simulating a chunk-load failure in the prod build is brittle; logic is 6 lines.) |
| NIT recent title | localStorage per keystroke | **Fixed.** Title/slug changes of the open doc are debounced 800 ms; a new doc is recorded at once (pending title flushed first). The recording moved into the lazy `useRecent` chunk (`noteRecent`), which also took `useRecent` out of the entry. AC-26.8 + the new m3 e2e exercise the path. |
| NIT tabs a11y | role=tab without tabpanel | **Fixed.** Tabs keep `role="tab"` + `aria-selected` (spec hooks) and gain `aria-controls="doc-tabpanel"`; the doc body (`#doc-tabpanel`) is `role="tabpanel"` with an `aria-label` (file or primary name) while the strip shows. (`<main>` cannot take role=tabpanel, so the panel is the `.doc-body` wrapper.) |
| NIT entry budget | note for #27+ | **Logged** in DECISIONS (`#26 → #27+` line, with the measured numbers). |
| NIT `.lib-badge-mode` | CSS-class assertion | **Fixed.** The badge has `data-mode`; `qa-gate-features` and `26-library` assert on `[data-mode]`. |
| NIT heading copy-link | copies doc URL on file routes | **Fixed** (small change in `PreviewPane.sectionLink`): on a file route it copies `/d/<doc>/<file>#<id>`. Header Copy link still copies the doc URL (DECISIONS). Asserted via the real clipboard in the History e2e above. |
| POLISH ×2 | files.cjs headers; pin-merge ids | → POLISH.md. |

## QA (26-qa.md)
| # | Finding | Outcome |
|---|---|---|
| m1 | native `window.confirm` for file remove/replace | **Fixed.** `LibraryConfirmDialog.vue` generalised into `ConfirmDialog.vue` (testid-prefix prop; `library-confirm-*` unchanged, `file-confirm-*` for files), a layer-2 modal (focus trap, Esc/backdrop cancel, starts on Cancel). The store exposes a promise-based `confirmation`; FileTabs renders it. e2e: AC-26.18 (remove via the dialog, no native dialog) and "an existing name asks to replace (in-app dialog); Cancel or Esc sends nothing, Replace uploads". The leave guard keeps its `window.confirm` (pre-existing, other items' tests). |
| m2 | default sort written to the URL | **Fixed.** `sortParam()` returns '' for the default of the current q. Unit test + AC-26.5 e2e extended (Title → Recently updated gives a bare `/library`; then q defaults to relevance with no `sort`). |
| m3 | recent entry for a deleted doc shows the local copy | **Fixed** in `loadSharedDoc`: on 404/410 the local copy is used only when the draft has unsaved edits (`!draft.clean`); a clean draft → `doc-not-found`. Checked dependants: the only e2e asserting "Showing your local copy" (`04-routes-extra` "a restored clean shared draft … offline copy still works") is the **unreachable** path, unchanged; no unit test covers the loader's 404 branch (`usePersistence*` tests cover `takeRestoredDraft` itself, unchanged). e2e "a recent entry for a doc deleted elsewhere opens the doc view's not-found state". DECISIONS updated. |
| c1 | phone cards ~80 px empty band | **Fixed (variable height, exact).** A phone card is 2 lines (76 px), + its tags line only when it has content (tags / collection / "+ tag"), + snippet; `libraryRowHeight` models it, the list uses per-row offsets (binary search in `virtualRange`), the ≤120 cap is unchanged. Unit tests (heights, offsets vs fixed path, cap); e2e "phone cards have no empty band …" and a new **AC-26.12 (phone)** run over 600 docs with mixed heights (every 3rd protected): ≤120 rows at every step, every card exactly 76 or 104 px, last card ends at the list end. |
| c2 | phone header clips "Set your name" | **Fixed.** On phones the header actions take their own full-width line; the name button shrinks only when it truly cannot fit (no 7.5em cap). Asserted in the c1 e2e (`scrollWidth <= clientWidth`). |

## Visual check
`.verify/qa/26fix/phone-library-{light,dark}.png` (390×844 @2x, script `.verify/qa/26fix/shots.mjs`): looked at both — cards without tags end right under the badges line, tagged / "+ tag" cards have their third line, "Set your name" is whole, theme switcher + New sit right.

## Entry budget (#6 AC-06.8)
Test build (NODE_ENV=test): entry **573,575 B** (limit 574,644; lane before the fix round 574,039). Headroom ~1,070 B. A first pass was 116 B over; moving the recent-list recording behind a dynamic import fixed it.

## Pre-existing / own test changes
- `tests/e2e/qa-gate-features.test.mjs` (dashboard block, #26-owned per 00 §11): `.lib-badge-mode` → `[data-mode]` (FE NIT).
- `tests/e2e/items/26-library.test.mjs`, `26-files.test.mjs`, `tests/items/26-library.test.ts`, `server/test-items/26-library.test.mjs`: #26's own tests, extended as listed above; the two `26-files` dialog tests moved from native dialogs to the in-app dialog (m1).
- `tests/e2e/items/04-routes-extra.test.mjs` "an image file is shown in an <img>, anything else as a download link" (item #4 test, already touched by #26): the download link's `href` was asserted to be the raw API path; it is now asserted to be a `blob:` URL with `download="data.csv"`. Justification: FE review SF3 — that exact behaviour (`<a download>` on the cross-origin API URL) is the bug being fixed; the test's intent (non-image files get a download link, not an inline view) is kept.
- No #26 frozen tests existed for the FE; server frozen tests unchanged in this round.

## Decisions appended / amended (DECISIONS.md)
Amended: `?pinned=1` (contract note), row heights (phone variable), clear-filters/sort (m2), recent list (m3 + debounce + lazy), confirmations (ConfirmDialog). Appended: server NIT 3/4 + plain INSERT; fts_rowid follow-up (no schema bump); file routes hide History/mode/changes banner + heading link = file URL; blob downloads; collection re-read rule + chunk retry; tabs a11y; #27+ entry-budget rule.

## Gate
Command: `flock <lane-browser.lock> env VERIFY_ITEMS=26 E2E_FILES=26-library,26-files,qa-gate-features,04-routes,04-routes-extra,04-routes-pages,05-mobile-layout,06-lazy-editor-build,23-view-edit-links,02-reading-mode,shared-mode,durable-sync scripts/verify.sh --only typecheck,unit,build,e2e,server`

- Run 1 (`.verify/runs/20261011-030355-3334780`, load avg 9–24): typecheck PASS; unit FAIL 5 (in-test `vite build` killed without stderr under load — 06-lazy-editor, 04-routes.test.ts collect); e2e: one **real** failure, `04-routes-extra` "anything else as a download link" asserted the raw API href → updated to the blob URL (see test changes); `02-reading-mode` AC-02.16 timed out (60 s); server PASS 427/428 (1 skip).
- Run 2 (`.verify/runs/20261011-031637-3364759`, load avg 18–28 from other agents): typecheck PASS 0 errors · unit **PASS 485/485** · build PASS 177 chunks · e2e PASS 26-library 19/19, 26-files 24/24, qa-gate-features 16/16, 04-routes 21/21, 04-routes-extra 23/23, 06-lazy-editor-build 6/6, 23-view-edit-links 9/9, 02-reading-mode 19/19, shared-mode 2/2, durable-sync 11/11; FAIL (timeouts only) 04-routes-pages 0/9 ("did not finish before its parent", 252 s), 05-mobile-layout 22/24 (`page.goto` 8 s timeouts) · server FAIL 426/428 — only `20-perf` "POST took 1101 ms" (< 1 s timing check) · OVERALL FAIL 1103.5 s.
- Re-run alone at load ~6–8 (`.verify/runs/20261011-033610-3388509`): `e2e/04-routes-pages PASS 9/9`, `e2e/05-mobile-layout PASS 24/24`, `OVERALL: PASS`; `node --test server/test-items/20-perf.test.mjs` → pass 18, fail 0.

Net: every step and suite green, across run 2 + the load re-runs (no code change between them).
