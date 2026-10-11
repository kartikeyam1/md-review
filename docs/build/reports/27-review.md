# #27 Templates (full item): code review

Verdict: **PASS. No blockers, 5 SHOULD-FIX.**

**What I reviewed:**
- `27-only.patch` (the #27 diff on top of the #26 snapshot), against the #27 spec and 00 §1.4, §2.3, §3.1, §3.2, §3.4, §5, §6, §10 and §12.
- I read the files around the diff in the worktree.

**What I ran:**
- `node --test server/test-items/27-template-vars.test.mjs`: 22/22 pass.
- `npx vitest run tests/items/27-templates.test.ts`: 16/16 pass.

**What I did not run:** no browser, no e2e and no build. The entry bytes figure (569,895 against the 574,644 budget) comes from the implementer's report and I did not re-measure it.

## Earlier server review (27-review-server.md): all fixed
I checked each fix in the code and found a test for each one.
- **SF1, provenance:** `session-rows.cjs:36` adds `from_template` to COLUMN_OWNED, and `:69-72` decodes the column. Instantiate writes only the column.
- **SF2, error shape:** `checkCollectionId` now returns `unknownCollectionError`.
- **NITs:**
  - Builtins list in manifest order (`seedRank`).
  - MCP maps a 404 to "no longer exists".
  - PATCH checks builtin before parsing the body.
  - Instantiate re-checks the collection inside the transaction.
  - The boot upsert warns on a seed name clash.
- **POLISH:** the items are recorded in `POLISH.md`.

## Out-of-brief changes: both accepted
- **Lazy landing page** (`DocView.vue:43`). No functional regression:
  - The drop zone, paste and GitHub form all live inside FileUpload.
  - `#github=` is handled in `useDocLoader.ts:204/367`, which is unaffected.
  - The implementer ran the landing suites green (160/163).
  - Cost: one extra chunk round-trip before the landing page paints, and a blank page if that chunk fails to load. See the NIT below.
- **`testid` prop on `LibraryConfirmDialog`**: minimal, and the default keeps `library-confirm-dialog`. Fine.
- **Header overflow menu:** the item is at §2.3 position 5 and is hidden on file and pinned routes (`HeaderOverflowMenu.vue:78-81`). Correct.
- **Edit token after instantiate:** `saveToken(id, token, slug)` (`useTemplates.ts:53`) works the same way as `useShare.ts:129`, so `/d/<slug>?view=edit` is editable. The response is `no-store`. Correct.

## BLOCKER
None.

## SHOULD-FIX
1. **The picker preview is interactive and drives the main router** (`TemplatePicker.vue:243-249` → `PreviewPane.vue:136-148, 327-330, 408-411`).
   - Problem: three interactions in the preview change the main URL:
     - an in-page `#anchor` link in a markdown preview
     - a heading's section-link button
     - an anchor click inside an html preview, which posts `anchor-changed`
   - Effect: the picker's own href watch (`:144`) then closes the picker and the typed inputs are lost. The section link also copies the wrong URL.
   - Fix: add a `standalone` (or `inert-links`) prop to PreviewPane. With it set, PreviewPane:
     - runs `preventDefault` on every link click
     - skips the section-link enhancer and `alignToFragment`
     - ignores `anchor-changed` from the frame
   - Add an e2e test: clicking an anchor in the preview leaves the picker open.
2. **Esc uses a window capture listener with `stopImmediatePropagation`** (`TemplatePicker.vue:130-137`, `SaveTemplateDialog.vue:95-103`).
   - Problem: this runs ahead of any layer above the modal. §3.4 layer 1, the zoom viewer (#15), will attach to images and mermaid diagrams inside this preview, and Esc would close the picker instead of the viewer.
   - Root cause: Create and Save are disabled while busy, which drops focus to `<body>`. While busy, Tab then also leaves the focus trap.
   - Fix:
     - Use `aria-disabled` and `aria-busy` while busy instead of `disabled`, or give the dialog `tabindex="-1"` and focus it while busy.
     - Handle Esc with `@keydown` on the dialog, the way `LibraryConfirmDialog` does.
3. **Esc or Cancel during a create still navigates** (`TemplatePicker.vue:115-125`).
   - Problem: Esc stays allowed while busy, but `create()` calls `pushRoute` after the await even if the picker was closed in the meantime.
   - Fix: set a `closed` flag in `onUnmounted`. If it is set, skip the navigation and show `toast.success('Created “X”', {action: {label: 'Open', onClick: …}})`. The token is already saved, so nothing is lost.
4. **The library tablist does not follow the ARIA tabs pattern** (`LibraryView.vue:235-237`).
   - Problem: it uses `role="tab"` with no `aria-controls`, no `tabpanel`, no roving `tabindex` and no arrow keys.
   - Fix: these tabs switch the URL, so make them `<nav aria-label="Library sections">` containing `<a href>` links with `aria-current="page"`, keeping the testid. The alternative is to implement the full tabs pattern.
5. **The save dialog does not close on navigation** (`SaveTemplateDialog.vue`; the picker does).
   - Problem: if the user presses Back while the dialog is open, it stays on top of another page and still holds the previous doc's content.
   - Fix: add the same `watch(() => router.current.value.href, () => emit('close'))`.

## NIT
- **Lazy landing page:**
  - Start `import('@/components/FileUpload.vue')` at boot when the first route is `landing`, so the chunk is not loaded only after boot.
  - Give the async component an `errorComponent` that suggests a reload.
- **Success toast link:** `SaveTemplateDialog.vue:91` uses `href`, which does a full reload. AppToast supports `onClick` (`useToast.ts:12`), so use `router.push`. The DECISIONS line that justifies `href` is wrong on this point.
- **Chunk-load failures:** in `templateEntry.ts`, a failed chunk load (a stale chunk after a deploy) is an unhandled rejection and the button does nothing. Add `.catch(() => toast.error('Could not open templates. Reload the page.'))`.
- **Library chunk size:** `LibraryView.vue:23` and `LibraryTemplates.vue:12` import `templateHost` statically, so the library chunk carries both dialogs. Go through `templateEntry` instead, with a variant that takes an id.
- **Rename and delete in `LibraryTemplates.vue`:**
  - `@blur="cancelRename"` (`:106`) hides the error of a rename request that is still in flight.
  - After a rename or delete, focus falls to `<body>`. Return it to the row's Use button.
- **`applyTitleVar` edge cases** (`templateLogic.ts:47-60`):
  - A fence line with an info string (```` ```js ````) is accepted as a closing fence.
  - The html regexes match the first `<title>` anywhere, including inside `<svg>`, `<script>` or a comment.
  - Add tests or accept these.
- **Preview a11y:**
  - When offline, the preview error has `role="alert"` and is announced again on every keystroke. Use `aria-live="polite"`.
  - Variable chips need a visually hidden "Variables:" label.
- **Server performance** (`templates.cjs:74-91, 109`): `byName` and `allTemplates` decode every row, content included (up to 1 MB each), and `listVariables` runs on every GET. Select only `id, name` for name checks, or cache the variables.
- **e2e:** `waitForTimeout(300)` at `27-templates.test.mjs:345`. Wait for a readiness signal instead.

## POLISH (security hardening)
- **Html template previews run the template author's scripts.** The preview iframe uses `sandbox="allow-scripts allow-popups allow-forms"`. Templates can be written by anyone (there is no auth), so a crafted template runs script for every user who opens the picker on it. The origin is opaque, so the script cannot read the app's storage. It can still open popups and post `anchor-changed`, which closes the picker. Use `sandbox=""` for template previews.
- The 4 items in `POLISH.md` stand: no auth on template writes, no cap on the number of templates, control characters allowed in title and name, and the collection list is visible to any caller.
