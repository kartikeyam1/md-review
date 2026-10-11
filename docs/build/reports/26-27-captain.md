# Lane library — captain report: #26 Library + multi-file sessions, #27 Templates

Base: main 3796a62. Hand-off patches (uncommitted work in `lane/library`):
- `scratchpad/cap-library/26.patch` — #26 (54 files), applies on 3796a62.
- `scratchpad/cap-library/27.patch` — #27, applies on 26.patch.
Verified: both apply in order onto a clean `git worktree add --detach 3796a62`, and the resulting tree is identical to this worktree (minus `scripts/lib/browser-slot.sh`, the orchestrator's slot change, which is left out of both patches).

How the lane ran: #26 was split into three parallel implementers (server / library page / file tabs) working to a captain-written internal contract (`scratchpad/cap-library/26-contract.md`). #27's server+MCP half was built in parallel in a side worktree. Its FE was built on a #26 snapshot plus the #27 server. #27 was then 3-way merged onto the final #26 (one conflict: #26's fix round generalised `LibraryConfirmDialog` into `ConfirmDialog`; #27's delete confirm now uses `ConfirmDialog` with a new `dialogTestid` prop).

## #26 Library (collections, tags, pins, search) + multi-file sessions
- **ACs:** AC-26.1–26.21 are all covered by item tests and all pass:
  - `tests/e2e/items/26-library.test.mjs` 19/19, `26-files.test.mjs` 24/24;
  - `server/test-items/26-library.test.mjs` 33/33, `26-tags.test.mjs` 4/4;
  - `tests/items/26-library.test.ts` and `26-files.test.ts`.
- **QA (blind, `26-qa.md`):** PASS. All 21 ACs and the whole edge-case list pass, in 6 themes at phone, tablet and desktop. 3 minor and 2 cosmetic findings, all fixed.
- **Review:**
  - Server (`26-review-server.md`): no blockers; 2 should-fix and 4 nits.
  - FE (`26-review-fe.md`): no blockers; 5 should-fix and 8 nits.
  - Everything was fixed in the single fix round (`26-fix.md`), except two items logged by design:
    - an fts_rowid follow-up, which waits for a schema bump that #26 must not make;
    - the #27+ entry-budget rule, in DECISIONS.
- **Security hardening:** logged to `docs/build/POLISH.md` `## #26`.
- **Product calls:** in DECISIONS (`- #26:` lines). The main ones:
  - `GET /library/docs` gains `protected` per item and the `?pinned=1` extension. `GET /paste/:id?fields=library` adds title, collection and tags, and `created_by` is always returned.
  - Markdown snippets keep inline HTML as literal text (AC-26.3 as worded).
  - File routes keep the doc attached, so capability, the poll and the header all stay the doc's. History, Document mode and the changes banner are hidden there.
  - Downloads go through blob URLs.
  - A recent entry for a deleted doc shows not-found unless this browser holds unsaved edits.
  - Phone cards have variable height and virtualisation stays ≤120 rows.
- **Frozen/pre-existing test changes:**
  - `server/test-items/20-fixes.test.mjs`: `created_by` is now returned as the real author, never the forged value. The spec and contract require this, and the reviewer approved it.
  - `tests/e2e/items/04-routes-extra.test.mjs`:
    - the dashboard selectors are widened;
    - the file-route GET assertion is dropped, since the attached doc is required by rule 27;
    - `file-not-found` replaces doc-not-found;
    - the download link is now a `blob:` URL.
  - `tests/composables/useDocState.test.ts`: on a file route, capability is the doc's and the view is read (00 §1.2).
  - `tests/e2e/qa-gate-features.test.mjs`: the dashboard block was rewritten per 00 §11.
- **Entry chunk (#6 AC-06.8):** about 1 KB of headroom after #26. #27 made the landing page lazy, which leaves about 4.7 KB.

## #27 Templates
- **ACs:** AC-27.1–27.15 are covered:
  - `server/test-items/27-templates.test.mjs` 38/38 and `27-template-vars.test.mjs` 22/22;
  - `tests/e2e/items/27-templates.test.mjs` 17/18, with 1 skip: the screenshot test, which the fixer ran separately (17/17);
  - `tests/items/27-templates*.test.ts`.
- **QA (blind, `27-qa.md`):** PASS for #27's own work. All 15 ACs and the edge cases pass: REST, MCP over both stdio and HTTP, and 6 themes at phone and desktop.
  - D1 (major, a dependency): the seeds show raw `[!NOTE]` and `:rag-*[]` because #16 is not in base 3796a62. #16 is on main, so this resolves on landing. **Re-check one seed doc after landing.**
  - D2 and D3 (cosmetic) are fixed.
- **Review:**
  - Server-only (`27-review-server.md`): 2 should-fix and 5 nits.
  - Full item (`27-review.md`): no blockers; 5 should-fix and 10 nits.
  - All of them were fixed (`27-fix.md`, plus the server fixes listed in `27-impl-fe.md`).
- **Security hardening:** logged to `POLISH.md` `## #27`.
- **Captain fix after merging:** the lane gate found that #27's "From template" button clipped "Set your name" in the phone library header (an assertion in #26's c2 test). On phones the label is now "Template" (aria-label "New from template") with compact header buttons. Logged in DECISIONS and checked visually (light and locus-dark at 390×844).
- **Out-of-brief changes, accepted:** the lazy landing page (DocView, `lazyLanding.ts`), a `standalone` prop on PreviewPane for the picker preview, and toast `onClick` links navigating in-app.
- **Frozen-test changes:** none.

## Gate (lane, on the combined 26+27 tree)
- `VERIFY_ITEMS=26,27 E2E_FILES=26-library,26-files,27-templates,qa-gate-features,app,04-routes,04-routes-extra,04-routes-pages,05-mobile-layout,06-lazy-editor-build,23-view-edit-links,02-reading-mode,shared-mode,durable-sync scripts/verify.sh --only typecheck,unit,build,e2e,server`
  - Run `20261011-035528-3429886`: typecheck PASS · unit 525/525 · build 180 chunks · server 487/488 (1 skip `20-real-data`) · e2e 249/251.
  - The one failure was the 26-library phone-header clipping caused by #27's button (fixed above). The one skip is #27's screenshot test.
- After the fix, run `20261011-040544-3451842`: typecheck PASS · unit 525/525 · build PASS · e2e 26-library 19/19, 27-templates 17/18 (1 skip), 06-lazy-editor-build 6/6 · **OVERALL: PASS**.

## For the orchestrator when landing on main
- Main has moved (#7, #12–#19, #28, #29, the hljs perf commit). The likely conflict files are `DocView.vue`, `DocHeader.vue`, `HeaderOverflowMenu.vue`, `PreviewPane.vue`, `App.vue`, `server.cjs` ROUTES, `mcp-server.js`, `DECISIONS.md` and `POLISH.md`.
- Re-check the AC-06.8 entry budget on main.
- Check that the seed templates render callouts and rag badges (#16).
