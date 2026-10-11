# fix-lib — persona-QA (librarian) findings, all 7

Verdict: DONE. One commit on feat/view-share.

## Root causes and fixes
- B1 token wiped on full load: tokens stored by id; slug→id alias was memory-only, so the first GET after a full load of /d/<slug> carried no X-Edit-Token, server said can_edit:false, settleAccess dropped the stored token. Fix (useEditToken.ts, useShare.ts): persist aliases of held tokens (`md-review-edit-token-slugs`); settleAccess takes the token actually presented and drops only if that one was refused; a GET that did not present a held token is re-sent once (loadShareDetailed, pollPaste).
- M2 stale content on not-found: boot restore put the cached draft on screen and the doc body v-if was independent of docMissing. Fix (useDocLoader.ts, DocView.vue, RouteNotFound.vue, docState.ts): 404/410 clears the screen, deletes a clean draft; dirty draft / #23 local copy kept in md-review-local-copies (reason 'gone') and offered as "Download my changes"/"Discard". Behaviour change: such edits are no longer reopened as a local doc.
- M3/c7c: AppMenu shifts a dropdown back inside the viewport; `truncate` prop (320px cap, ellipsis, title) used by bulk Move.
- m4: phone tag chips in a sideways-scrolling strip; "+ tag" outside it (card heights stay fixed for the virtual list).
- m5: header overflow button hidden when it has no items.
- m6: title-substring match for queries with CJK-family or symbol-only tokens (server/search-query.cjs, routes/library-docs.cjs). No schema change (AC-20.1 pins schema_version 1); trigram migration path documented in DECISIONS.md.
- c7a phone bulk bar one line; c7b count hidden on Templates tab.

## Tests
- tests/e2e/items/qa-lib-tokens.test.mjs (4): ?edit= reload/new tab/typed URL/by id; pre-fix storage retry; New from template; UI share (that doc has no slug, so it also passed on base).
- tests/e2e/items/qa-lib-library.test.mjs (7): M2 clean + recently viewed, M2 dirty download/discard, M3+c7a+c7c phone and desktop, m4, m5, m6 UI, c7b.
- tests/e2e/items/qa-lib-embed.test.mjs (1): dirty draft → doc deleted → ?embed=1 shows only not-found (no stale content, no offer) → the full page still offers the edits as a download (fails if the embed path clears the draft).
- server/test-items/qa-lib-search.test.mjs (3); 3 new unit tests in tests/composables/useEditToken.test.ts.
- On base b49d9ae (temp worktree): qa-lib-library 0/7, qa-lib-tokens 1/4 → all reproduce.

## Gate
VERIFY targeted run 20261011-051131: typecheck PASS, unit 746/746, build PASS, e2e 312/313 (1 skip, 19 files: 23-*, 26-*, 27-*, 04-routes, 04-routes-extra, qa-lib-*, qa-edit-fixes, qa-read-*, app, durable-sync, 05-mobile-layout, 19-downloads, 18-font-width-control, 02-reading-mode, shared-mode), server 571/572 (1 skip) — OVERALL PASS. Post-gate edit (embed keeps a dirty draft on 404) re-typechecked + unit 746/746.

## Blind re-check
Fresh verifier: all 7 FIXED, no regressions. Its two cosmetic notes were fixed in the same commit (orchestrator follow-up):
- desktop Move menu overlapped the sidebar → AppMenu `align="start"` for bulk Move (left edge at the trigger; the viewport clamp still applies on phone);
- phone chip strip gave no hint of more chips → mask fade on the edge(s) with hidden chips (`data-more` start|end|both, updated on scroll, resize and tag changes).
Tests added to qa-lib-library (M3 desktop: menu.left >= trigger.left and >= sidebar right; m4: data-more end → start → both → end while scrolling, gradient mask, none for a card whose chips fit).

No frozen tests edited.
