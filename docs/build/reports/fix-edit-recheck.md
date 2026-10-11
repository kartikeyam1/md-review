# Fix-edit recheck: blind re-verification of the persona-QA findings

**Verdict: PASS.** All 11 findings are FIXED. No new blocker or major defects.

**Build and setup**
- Worktree `md-review-fixedit` (branch `lane/fixedit` plus its uncommitted fix), tested as a prod build.
- A throwaway stack (`scripts/lib/stack.sh` functions, backend :45339, vite preview :45015) was torn down afterwards.
- Every Chromium run went through `scripts/lib/browser-slot.sh`.
- Probes: `.verify/qa/fixedit-recheck/p1..p9.mjs`. Shots: `.verify/qa/fixedit-recheck/shots/`.
- I did not read the diff or `src/`.

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | eng M5 Ctrl+B toggle | FIXED | **Bold:** `a ` → Ctrl+B → `bb` → Ctrl+B → ` cc` gives `"a **bb** cc"`. **Italic:** the same steps give `"x *yy* z"`. **Empty bullet:** Ctrl+B twice leaves `"- "`, and Enter then gives `"- one\n"`, so the list ends and the next text lands outside it (p1). |
| 2 | eng M6a conflict recovery | FIXED | **Keep my version:** History shows 3 revisions. The overwritten A-EDIT revision is its own row, auto-selected as FROM. Restore loads A-EDIT, and it autosaves to the server (p2 keep keeprow). **Use server version:** the local-copy banner appears (Restore/Copy/Download/Discard) and History gets a "Your set-aside edits · not saved, kept in this browser" row. Both the banner Restore and the row's Restore bring back B-EDIT, which then autosaves (p2 server aside, p2 server banner). Shots: `m6a-*`. |
| 3 | eng M6b two NOW rows | FIXED | I restored the oldest revision (same hash as the original) and let it autosave. History then has 3 rows with exactly one NOW, and the old row with that hash is unmarked (p6, `m6b-history.png`). |
| 4 | eng M6c FROM click | FIXED | Clicking the auto-selected `.rev-item.from` keeps aria-pressed=true and the Restore button stays visible, count 1 (p7). The same held in p2 keeprow. |
| 5 | eng m7 image after table | FIXED | On a shared doc, an image pasted on the empty line after a table, or at the end of the last row, gives `| 1 | 2 |\n\n![x](…)`. The preview has 2 table rows and no image inside the table (p1b, `m7-shared.png`). |
| 6 | eng c7 focus cluster | FIXED | At 1400×900 in split view with focus mode on, Sync scroll spans x 1179–1282 and the cluster spans x 1302–1392. That is a 20px gap with a vertical divider and no overlap (`c7-focus.png`). |
| 7 | eng c8 diff pills | FIXED | "whole UK" → "entire Irish and Scottish" renders as one `seg-changed` span on each side (p8, `c1-Locus-light.png`). |
| 8 | eng M2 History focus | FIXED | **Keyboard open:** focus moves to the modal's ×. **Tab:** 25 Tabs cycle × → rev-items → diff-skip → Close → Restore → × without leaving the modal; Shift+Tab also stays in. **Esc:** focus returns to `header-overflow-btn`. **Mouse open:** focus also lands in the modal (p3). |
| 9 | eng c1 History palette and emoji | FIXED | **Colours:** a computed-colour scan found no Tailwind green/red/amber values in History. **Emoji:** none in any of the 6 themes (Default/GitHub/Locus × light/dark); client glyphs are line icons (robot, code). **Readability:** stats, labels and NOW/FROM read fine in all 6 (`c1-<Style>-<mode>.png`). |
| 10 | leader M3 phone diff spill | FIXED | On a 390×844 touch phone (viewer), the modal spans 68–776. With line-by-line changes open, the diff scrolls inside `.rev-diff-scroll` (324–719), which ends above the Close footer (732–763). There is no page horizontal scroll (docW 390) (`phone-raw-diff-bottom.png`). |
| 11 | leader M4 change note first | FIXED | After an agent upsert with a changeNote, the viewer's "View changes" shows the note "Geocoder hotfix: FR back to amber" with author/time, a "Changed sections" chip list and +24/−20 first. The raw diff sits behind "Show line-by-line changes", and there is no Restore button for a viewer (`phone-changes.png`). |

## Residual notes
None of these are regressions; all are cosmetic or minor.
- The History hint still says "Select a revision to compare it with the current version" to a phone viewer. This is the leader's secondary wording point; it no longer says "Click".
- In Locus dark, added diff rows are tinted navy/blue-grey rather than green. They are readable but less obviously "added" than in the other themes (`c1-Locus-dark.png`).
- The intra-line highlight swallows the trailing space on only one side ("entire Irish and Scottish␠" vs "whole UK"). This is barely visible.
- The focus cluster's "Saved" label is very faint grey on cream in Default light (`c7-focus.png`).
- In "Use server version" mode, the loser tab also shows a "1 change since you last looked" banner next to the local-copy banner. That is two stacked banners; acceptable, but busy.
- The expected 412 console error appears during the conflict, as in the original run. There were no page errors.
