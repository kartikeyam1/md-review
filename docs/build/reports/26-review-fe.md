# #26 — FE review (library page + multi-file doc view)

Reviewer, read-only. Scope: `git diff` + untracked under `src/**`, `tests/**`, `shared/` usage from the FE. Out of scope: `scripts/lib/browser-slot.sh`, server (see `26-review-server.md`).
Nothing was built or run. The entry-budget numbers below are the implementers' own measurements, not re-measured here.

**Verdict: no blockers.** 5 SHOULD-FIX, 8 NIT, 2 POLISH.

## What checks out
- **FE↔API contract matches `26-contract.md`:**
  - `/library/docs`, plus `?pinned=1`, a server extension now recorded in DECISIONS l.205;
  - collections POST/PATCH/DELETE;
  - `PUT /paste/:id/tags` with `editHeaders`;
  - pins PUT/DELETE with 409 handling;
  - `pins/merge {from: readerId}` (`readerId` is a plain string, `useReader.ts:53`);
  - `bulk` with `editTokens` keyed by row id;
  - `?fields=library`;
  - `rowCanEdit = !protected || tokenFor(id)`.
- **URL state (rule 2):**
  - Typing in search and Esc use `replace`.
  - Filters, sort, tag chips, collection select, clear-filters and the deleted-collection fallback all `push`.
  - Back/forward restores the search box (`LibraryView.vue:42`).
  - A 1-char `q` sends no request (`resultKey` uses `searchTerm`).
- **Virtualisation (rule 15):**
  - The cap is `max(30, 120 − pinned)`, and pins are ≤ 50, so pinned + window ≤ 120.
  - `virtualRange` is unit-tested.
  - Pinned rows are filtered out of `mainRows` only when the section shows (rule 9).
  - The sentinel and the load-more fallback are both present.
  - Selection clears on any query change.
- **Snippets are text only** (`LibraryRow.vue:165-167`, no `v-html`). Tag validation is shared with the server through `@shared/tags.mjs`.
- **Doc view, files half:**
  - The doc stays attached on file routes, and `markdown` is always the primary doc, so autosave cannot write file text into the doc.
  - The poll keeps running (rule 27).
  - Embeds get `FileView` but no strip.
  - Pinned revisions get no strip, because `active` requires a doc/file route (rule 26).
  - The HTML file goes through the sandboxed `PreviewPane`.
  - The TOC follows markdown files.
  - `docScroll` for primary HTML docs is unchanged.
  - AC-26.17: the file is fetched once per route entry, and a 404 is final.
- **Pre-existing test edits are all justified:**
  - `useDocState.test.ts`: file route = the doc's capability with `view:'read'`, which is exactly 00 §1.2/§1.3.
  - `04-routes-extra`:
    - The dropped "no live-doc GET" follows from rule 27 plus the attached doc.
    - `file-not-found` is rule 23.
    - The `.session-card` and `.dashboard` selectors are widened, with no assertion changed.
  - `qa-gate-features` dashboard block: matches 00 §11 l.507.
  - `DocHeader.vue:132` one-liner: required by 00 §1.3, since an editor on a file route must not get Edit. It is correct, but sits outside everyone's ownership list, so the captain should acknowledge it.

## SHOULD-FIX

1. **The leave guard ignores file tabs as the "from" screen.** `src/composables/useDocLoader.ts:297-310`
   - **Code:** `showing = from.key === attachedKey && doc.screenKey.value === attachedKey`.
   - **Repro:** an editor types and immediately clicks a file tab, so the save is in flight or stalled. They then click Library.
   - **What happens:**
     - `held` is not set, so the library renders while the 1.5 s flush and the confirm run. Rule 13 says the doc stays on screen.
     - Cancel pushes `/d/<attached>` instead of the file tab the user was on.
   - **Fix:** `const fromAttached = from.key === attachedKey || (from.route.kind === 'file' && from.route.id === attached); const showing = fromAttached && doc.screenKey.value === from.key`.
   - **Test:** add an e2e to `26-files`: stall writes → type → file tab → Library → cancel → URL is the file tab and `file-tabs` is still visible.

2. **Dead `fileView` plumbing is left in the entry chunk.**
   - **Where:**
     - `docState.ts:52` (`fileView`), `:229-233` (`setFileView`, including its revoke logic), and the export at `:264`;
     - `useDocLoader.ts:51, 167, 270, 328, 391` (`setFileView(null)` / `fileView.value = null`).
   - Since `loadFile` was rewritten, nothing sets these to a non-null value.
   - **Fix:** delete all of it. Besides the hygiene, it gives back entry bytes in the lane's tightest constraint (AC-06.8, ~600 B headroom).

3. **Downloads use `<a download>` across origins, where the attribute is ignored.**
   - **Where:** `FileView.vue:58` (`:href="c.url" :download`) and `sessionFiles.ts:393-403` (`download()`).
   - In production the API is another origin (00 §9), so "Download" navigates the app tab to the raw API URL. A PDF replaces the app; unknown types may render inline.
   - **Fix:**
     - `openFile` already holds the blob (`sessionFiles.ts:304-305`). Use `URL.createObjectURL(res.blob)` for the card and track it in `objectUrl` like images.
     - In `download()`, `fetch` the blob first, then click a blob-URL anchor.
   - The pattern pre-dates #26 (#4), but #26 makes it the main path for every attachment.

4. **The destructive confirm focuses OK.** `LibraryConfirmDialog.vue:15`
   - `initialFocus: () => okBtn.value` means pressing Enter right after "Delete N documents?" deletes them.
   - **Fix:** focus `library-confirm-cancel` first, as alertdialog guidance says.

5. **History, Restore and Document mode stay reachable on file routes.** `HeaderOverflowMenu.vue:46-74`
   - Capability correctly stays the doc's (00 §1.2).
   - But restoring a revision, or switching publish/review, from a file tab changes the primary doc invisibly.
   - **Fix:** either (a) when `routeKind === 'file'`, make History push the primary tab before opening, or (b) hide History and the mode group on file routes. Add a DECISIONS line either way.

## NIT
- `useLibrary.ts:190-193`: both branches of the `finally` set `loadingMore = false`. Collapse them.
- `sessionFiles.ts:271`: `fetchLibrary` runs an extra `GET ?fields=library` on every changed poll of every shared doc, so remote edits double the poll traffic. Fetch it only on a pasteId's first payload; the server already bumps the version on a collection change, so also when `payload.version` changes due to meta-only edits if needed.
- `useSessionFiles.ts:31-34`:
  - The store chunk is imported at boot on every route, landing and embed included.
  - A rejected import (offline, or a stale chunk after a deploy) gives an unhandled rejection, and file routes stay blank forever.
  - **Fix:** add `.catch`, set a notice, and retry the import on the next `openFile`.
- `App.vue:62-71`: the recent list re-records on every title change. An editor typing in the first `# ` heading writes localStorage on each keystroke. Debounce it, or update the title in place without re-sorting.
- `FileTabs.vue`: `role="tab"` sits on navigation links with no `role="tabpanel"` or `aria-controls`.
  - Option 1: add `aria-controls` pointing at the content region, which gets `role="tabpanel"`.
  - Option 2: model the strip as `<nav>` links with `aria-current="page"`, which fits URL-pushing tabs better.
- The entry budget has ~600 B left. `App.vue` now pulls `useRecent`, `useReader`, `PASTE_API` and two watchers into the entry. Note in BUILD-ORDER or DECISIONS that #27+ must put any entry addition behind an async boundary. SHOULD-FIX 2 frees some bytes.
- `qa-gate-features.test.mjs:224` asserts on the CSS class `.lib-badge-mode`. Prefer a `data-testid` or `data-mode` attribute on the badge.
- On a file route, copy-link and heading links copy the doc URL, not the file URL. This is known from the impl report; worth a follow-up item.

## POLISH (security hardening)
- `server/routes/files.cjs:59-69`: non-asset files are served with no `Content-Disposition: attachment`, no `nosniff` and no CSP.
  - The download card links straight to them (see SHOULD-FIX 3), so an `.xhtml`, `.xml` or similar file opened in a tab runs on the API origin.
  - **Fix:** send `Content-Disposition: attachment` for the download kind, `nosniff` on everything, and `Content-Security-Policy: sandbox` on non-image responses.
- `App.vue:52-59`: the pin merge sends `from: readerId` to the server on every first name-set. That is fine per 00 §7. If reader ids ever become secrets, consider merging only when the anonymous key has pins (`GET /library/pins` first), so ids are not posted unnecessarily.
