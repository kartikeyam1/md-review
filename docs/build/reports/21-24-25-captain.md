# Lane social — captain report (#21, #24, #25)

Base fb3c2af. Work is uncommitted. Hand-off patches are in scratchpad `cap-social/21.patch`, `24.patch`, `25.patch`; each applies on the one before. I checked the chain with `git apply` onto a clean `git worktree add --detach fb3c2af`. No frozen tests existed for this lane, so I wrote the acceptance tests from each spec first and ran them red. In #24 the server tests were written right after the route rather than strictly before it.

Process: I made each item's fix round in its own worktree, so each patch holds exactly one item.
- `-qa21`: base + #21.
- `-fix24`: + #24.
- the main lane worktree: + #25.

Separate subagents ran blind QA and code review for each item on a snapshot worktree. I fixed every finding in one round. The exceptions are listed under "Not fixed".

## #21 Upsert by key
- ACs: all 13 are covered. Server tests: `server/test-items/21-upsert-by-key.test.mjs` (30 tests). e2e for AC-21.12: `tests/e2e/items/21-upsert-by-key.test.mjs` (3 tests).
- The #23 tests that skipped until #21 landed no longer skip: `23-edit-tokens` AC-23.1/23.2 upsert and `23-mcp-tokens` AC-23.12. Both pass.
- QA: PASS (`21-qa.md`). One pre-existing major (D1): a shared doc with no filename crashed the header, which also hid History. Every REST/MCP upsert without a filename hit it. Fixed in `useDocLoader`, with an e2e test.
- Review: PASS, no blockers (`21-review.md`).
- Fixes:
  - A later write never coalesces into a revision that has a note.
  - The response is sent after the commit.
  - `contentType` is free-form, as in POST /paste.
  - MCP errors pass the REST `code` through.
  - A stale stored token now gets a clear message.
  - CLI `publish` sends the filename only when `--filename` is given; its help text is complete.
  - A legacy session keeps a reserved slug it already owns.
  - Revision notes are clamped to 3 lines.
  - The revisions modal stacks vertically below 641 px.
- Decisions: 8 lines tagged `#21` in DECISIONS.md.

## #24 Reactions + useReader
- ACs: all 14 are covered.
  - Server: `24-reactions.test.mjs` (14 tests).
  - Unit: `tests/items/24-reactions.test.ts` (20 tests: formatWho, applyLocal, useReader, the store, the enhancer).
  - e2e: `24-reactions.test.mjs` (11 tests: AC-24.7–24.11, 24.13 in all 6 themes plus axe, 24.14, HTML/embed/edit, blocked storage, Tab/keyboard).
- QA: PASS (`24-qa.md`), minors only. Review: PASS, 4 should-fix (`24-review.md`).
- Fixes:
  - A stale poll GET can no longer undo a click.
  - A stuck long-press flag no longer swallows taps.
  - Heading ids the server would reject get no trigger.
  - The flex rule is scoped to the doc panes only (#28 coupling).
  - A `__proto__` section id works.
  - Tabbing out of the picker closes it.
  - The trigger icon has ≥ 3:1 contrast in dark.
  - The long-press tooltip closes on its own.
  - Esc works when focus is outside the picker.
  - Dead code removed.
- Gate catch: unread `fetch` bodies kept requests open, so the page never reached network-idle (`harness-smoke` captureMatrix timed out). Fixed in useReactions and useViews: bodies are always read.
- Decisions: 10 lines tagged `#24`. Two of them were requested: section keys are today's heading ids, kept as plain strings so #3 needs no migration, and `src/preview/index.ts` is created here because #3 has not landed. A third covers the reaction bar sitting under the scroll pane until #5.

## #25 View counts + named readers
- ACs: all 14 are covered.
  - Server: `25-view-analytics.test.mjs` (15 tests, incl. the `MDREVIEW_NOW` midnight split, 5 000 rows under 100 ms, Slackbot/MCP not counted).
  - Unit: `25-view-analytics.test.ts` (7 tests).
  - e2e: `25-view-analytics.test.mjs` (11 tests).
- QA: FAIL with 2 majors (`25-qa.md`):
  - Tablet readers panel off-screen: fixed and covered by an e2e test at 641/820/1099 px.
  - "Library `view_count` counts editor views": rejected. In the QA script, the extra view came from a POST with a *wrong* token (Mallory), which is correctly a reader view. With a valid token the library and `GET /views` agree; I checked this with a dedicated script.
- Review: PASS, 2 should-fix (`25-review.md`). Fixed: the panel Esc now runs in the bubble phase, and naming yourself after your view was counted re-posts it.
- Other fixes:
  - `get_views` warns about a token that was not accepted.
  - Stats reload when edit access changes.
  - `sort=views` uses the column alias.
  - Dead code removed.
- Decisions: 7 lines tagged `#25`.

## Frozen / pre-existing test changes
- `server/test-items/20-sqlite-storage.test.mjs:232-233`: `reaction_count` and `view_count` were asserted `null`; they now expect `0`. 00 §8 says "null until #24/#25", and #25 fills `view_count`.
- `server/test-items/23-edit-tokens.test.mjs` and `23-mcp-tokens.test.mjs`: removed the skip guards for #21 (requested).

## Not fixed
- Moved to POLISH.md as security: open `POST /reactions` and `/views` have no small body cap or rate limit.
- Pre-existing, outside this lane: in default dark, header meta text (`--text-meta`) is about 3.2:1.

## Gate
Full run on the lane worktree: `VERIFY_ITEMS=21,24,25 scripts/verify.sh`.
- typecheck, unit 350/350, build, server 382/383 (1 skip): all PASS.
- e2e: 371/372 passed. The 1 failure was harness-smoke, the network-idle bug above.
- After the fix: `E2E_FILES=harness-smoke,21,24,25 --only typecheck,unit,e2e` → PASS 30/30.
- Per-patch checks:
  - `-qa21` (`--only typecheck,unit,server`): PASS.
  - `-fix24` (`--only typecheck,unit,e2e,server`, with harness-smoke + 24): PASS.
