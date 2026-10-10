# 02 — Reading mode by default + per-doc `publish | review` mode

## Goal
Anyone opening a doc sees a clean reading page: title, when it was last updated, and a few actions,
with no editor, comment rail, approval banner or prompt generator. Authors choose per doc whether it
is a **publish** doc (pure reading) or a **review** doc (today's comments + approval workflow).

## Scope / Out of scope
**In:** the three orthogonal axes (view × mode × capability) and what each combination shows; the reader
header vs the editor header; where comments, approval, summary and prompt generator live; the mode
toggle; the `mode` field on backend, REST and MCP; mode for local (unshared) docs.
**Out:** how edit capability is granted (#23 — this item only consumes `capability`); split view (#7);
header collapse on phone (#5); TOC (#3); theme switcher internals (#1); downloads (#19).

## Current state
- One layout for everyone: `App.vue:625-652` renders `HeaderBar` with filename, paste id, reviewer
  name, word/char counts, Edit/Preview toggle, sync, save state, History, New, Open file, Share and
  **Generate Prompt** (`HeaderBar.vue:103-212`).
- `ApprovalBanner` (`App.vue:659-669`) and `SummaryPanel` (`App.vue:671-676`) render for every shared doc;
  the comments sidebar + toggle strip always render (`App.vue:727-751`); text selection always raises the
  comment action bar (`App.vue:753-758`, `PreviewPane.vue:312-354`); comment highlights always painted
  (`PreviewPane.vue:196-219`).
- No notion of doc mode anywhere: not in `SharedPayload` (`useShare.ts:27-38`), not in `POST /paste`
  (`server/server.cjs:587-646`), `PUT /paste/:id/meta` (`:1090-1136`), `GET /paste/list` (`:1028-1063`) or
  MCP `create_session` / `update_session_meta` (`server/mcp-server.js:385-405, 618-633`).
- Default pane is already `preview` (`App.vue:30`), but it is a review surface, not a reading page.
- `appMode` (`'upload'|'review'|'dashboard'`, `types/index.ts:53`) uses the word "review" for "a doc is
  open" — rename it (e.g. `'doc'`) to avoid confusion with doc mode.

## Behaviour
1. **Axes.** *View* (`read | edit`, plus `split` from #7; from `?view=`, see #4) × *Mode* (`publish | review`,
   per doc) × *Capability* (`viewer | editor`). They are independent; every rule below names which axis it uses.
2. **Capability source** — canonical table in 00 §1.2. Local (never shared) doc → `editor`. Pinned revision and
   `?embed=1` → `viewer`. File routes keep the doc's capability but allow only the read view (00 §1.3). Shared doc →
   the #23 resolver; until #23 ships, and for legacy sessions afterwards, every shared doc is `editor` (link-editable).
   The FE exposes a single computed `capability` from `useDocState` (00 §4.1) that all rules read; `.app` carries
   `data-view`, `data-mode`, `data-capability` (00 §10.2).
3. **Mode source** (all creation paths: 00 §1.4). Shared doc → payload `mode`; absent/invalid → `review`. Local doc opened by file picker,
   drop, paste or `#github=` → `publish`. Local doc from the dev `?filePath=` loader → `review`. Restored
   local draft with no stored mode → `review`. Local mode is stored in the persisted draft and sent as
   `mode` when the doc is first shared.
4. **Default view is `read`** for every doc, mode and capability (no `?view=`, or `?view=read`).
5. **Read view — what renders** (✓ = rendered, — = absent from the DOM):

   | Element (testid / selector) | publish·viewer | publish·editor | review·viewer | review·editor |
   |---|---|---|---|---|
   | `doc-header`, `doc-title`, `copy-link-btn`¹, theme switcher (#1), `header-overflow-btn` | ✓ | ✓ | ✓ | ✓ |
   | `doc-updated`¹ | ✓ | ✓ | ✓ | ✓ |
   | `doc-mode-badge` ("Review") | — | — | ✓ | ✓ |
   | View toggle `view-toggle` (`view-toggle-read` "Read" / `view-toggle-edit` "Edit"; #7 adds `view-toggle-split`) — replaces today's Edit/Preview buttons | — | ✓ | — | ✓ |
   | `share-btn` | — | ✓ | — | ✓ |
   | Comments sidebar `.sidebar` + toggle strip, comment highlights, selection action bar | — | — | ✓ | ✓ |
   | `.approval-banner`, `.summary-panel`, `reviewer-name` | — | — | ✓ | ✓ |
   | `menu-generate-prompt` (overflow) | — | — | ✓ | ✓ |
   | `menu-history` (overflow)¹; `restore-revision` inside it | ✓; — | ✓; ✓ | ✓; — | ✓; ✓ |
   | Mode radios `doc-mode-publish` / `doc-mode-review` (overflow) | — | ✓ | — | ✓ |
   | `changes-banner` (unchanged rules) | ✓ | ✓ | ✓ | ✓ |
   | `save-state` | only when not `idle`/`saved` (dirty, saving, error, conflict) for editors; never for viewers |||||
   | Sync indicator `.sync-indicator`, word/char counts, `.paste-id`, filename rename | — | — | — | — |

   ¹ shared docs only (a local doc has no link or server time; it shows `doc-local-badge` "Not shared" to
   the editor instead of `doc-updated`).
6. **Publish mode hides review UI for everyone**, editors included. Comments that exist (e.g. posted by an
   agent via the API) are kept server-side and still returned by REST/MCP, just not shown. Selecting text in
   a publish doc is plain browser selection: no action bar, no popover, no highlight.
7. **Review mode, viewers** may comment, reply, resolve and approve/request changes exactly as today (legacy
   link-shared review); they cannot edit content, restore revisions or change the mode.
8. **Reader header** (`doc-header` `data-variant="reader"`, one line). **Order and per-width placement are canonical
   in 00 §2.2**; in short: left — `app-home-link`, `nav-library` (#26); centre — `doc-title` (00 §5 rule; until #5
   lands use `sessionName || filename`; single line, ellipsis, full text in `title`), then `doc-updated` and
   `doc-mode-badge`; right — `reviewer-name` (review), view toggle (editors), `share-btn` (editors), `copy-link-btn`
   (shared docs), theme switcher, `header-overflow-btn`. No control before `theme-toggle` carries `.btn-icon` (00 §2.1).
   - `doc-updated` is a `<time datetime="<ISO>">` with the absolute local date-time in `title`; text
     `Updated <rel>` + ` by <name>` when the latest revision has `by`. `<rel>`: < 60 s "just now"; < 60 min
     "N min ago"; < 24 h "N h ago"; else "MMM D" (adds ", YYYY" if a different year). Source:
     `latest_revision.at`, else `sharedAt`. It updates when polling brings a new revision.
   - `copy-link-btn` copies `<origin><BASE_URL>d/<slug||id>` (no query, no fragment; FE-built link rule, 00 §6) and
     shows an `app-toast` "Link copied"; clipboard failure → error toast containing the URL.
   - Overflow menu (`header-overflow-menu`, an `AppMenu`, 00 §3.2; item order canonical in 00 §2.3):
     `menu-history`, `menu-generate-prompt`, a "Document mode" group (`doc-mode-publish`, `doc-mode-review` as
     `menuitemradio` with `aria-checked`) plus `doc-mode-hidden-comments` ("N comments hidden in Publish mode", only
     when N > 0 and mode is publish), `menu-open-file`, `menu-new-doc`, `menu-refresh` (dev `filePath` only).
9. **Editor header** (`doc-header` `data-variant="editor"`, edit/split views, editors only; order per 00 §2.2): today's controls — renameable `.filename`, `save-state`,
   `.sync-indicator`, word/char counts, view toggle, `share-btn`, theme switcher, overflow menu (same items).
   The paste id moves out of the header (shown in the share dialog). Generate Prompt is never a top-level
   header button any more; it lives in the overflow menu in review mode.
10. **Edit view** shows the editor (#6 lazy) and, in review mode, the comments sidebar; in publish mode no
    sidebar and the editor takes the full width. Comment line decorations in the editor only in review mode.
11. **Changing mode** (editor): clicking a mode radio updates the UI immediately. Shared doc →
    `PUT /paste/:id/meta {mode}`; on non-2xx or network failure the previous mode is restored and an error
    `app-toast` "Couldn't change the document mode" appears. Local doc → stored in the draft.
    Other open tabs/readers switch within one poll cycle (mode is part of the polled payload; the ETag
    already covers meta).
12. **Server**: `mode` is a session field (`"publish"|"review"`; JSON meta today, a column under #20).
    - `POST /paste`: `mode` optional. Invalid value → 400 `{"error":"mode must be \"publish\" or \"review\""}`.
      Absent → `"publish"`, except when `callback_url` is present → `"review"`. Response adds `mode`.
    - `GET /paste/:id` (full and `?fields=meta`) and `GET /paste/list` items include `mode`; a stored session
      without it reports `"review"` (computed on read — no boot-time migration).
    - `PUT /paste/:id/meta`: accepts `mode` (same validation); response includes `mode`.
    - Comment/approval endpoints keep working in both modes (publish only hides UI).
13. **MCP**: `create_session` gains `mode?: "publish"|"review"` (description: "publish = read-only page for
    humans (default); review = comments and approval"); `update_session_meta` gains `mode`; `get_session` and
    `list_sessions` return it. `create_via_shell` passes `mode` through when given.

14. **Shared building blocks this item creates** (contracts in 00): `AppToast` + `useToast` (§3.1), `AppMenu` +
    `useMenu` (§3.2), `useDocState` (§4.1), `useGlobalShortcuts` (§3.5, absorbing App.vue's Mod+S handler),
    `DocView.vue` (doc layout; `App.vue` becomes a router shell), `DocHeader.vue` (both variants),
    `HeaderOverflowMenu.vue`, `ViewToggle.vue` (§4.2–4.3). Existing `history-button` is retired in favour of
    `menu-history`.

## Acceptance criteria
AC-02.1 Given a session created via `POST /paste` without `mode` When an editor opens `/d/<id>` Then `doc-header` shows the doc title, `.sidebar`, `.approval-banner`, `.summary-panel`, `.cm-editor` and any "Generate Prompt" button are absent.   [verify: e2e]
AC-02.2 Given a session JSON on disk with no `mode` key When `GET /paste/:id` Then the body has `"mode":"review"` and the file on disk is unchanged.   [verify: server]
AC-02.3 Given `POST /paste` with `mode:"draft"` Then 400 with the documented error; with `callback_url` and no mode Then the stored mode is `review`.   [verify: server]
AC-02.4 Given a review-mode doc with 2 comments opened by an editor Then the sidebar lists both, `doc-mode-badge` reads "Review", and `menu-generate-prompt` is present in the overflow menu.   [verify: e2e]
AC-02.5 Given a publish-mode doc with 3 API-posted comments When the editor opens the overflow menu Then `doc-mode-hidden-comments` contains "3", and no comment text appears anywhere in the page.   [verify: e2e]
AC-02.6 Given a publish doc When the reader selects a paragraph with the mouse Then `.selection-action-bar` is not visible and `window.getSelection().toString()` equals the selected text.   [verify: e2e]
AC-02.7 Given an editor on a publish doc When `doc-mode-review` is clicked Then the sidebar appears without reload, `PUT /paste/:id/meta` was sent with `{"mode":"review"}`, and a second browser context showing the doc shows the sidebar within 7 s.   [verify: e2e]
AC-02.8 Given `PUT /paste/:id/meta` is forced to 500 When the editor switches mode Then the UI returns to the previous mode and an `app-toast` with `data-kind="error"` appears.   [verify: e2e]
AC-02.9 Given a viewer (#23 view link, or a pinned revision URL until #23) on a review doc Then the view toggle, `share-btn`, mode radios and `restore-revision` are absent, while the sidebar and approval banner are present.   [verify: e2e]
AC-02.10 Given a shared doc whose latest revision is 3 h old by "agent" Then `doc-updated` text is "Updated 3 h ago by agent" and its `datetime` attribute equals the revision ISO time.   [verify: e2e]
AC-02.11 Given a markdown file opened via the file picker (local) Then mode is publish (no sidebar); When shared Then the `POST /paste` body contains `"mode":"publish"`.   [verify: e2e]
AC-02.12 Given `/?filePath=<fixture>` Then the doc opens in review mode (sidebar visible) and selection raises the comment action bar as today.   [verify: e2e]
AC-02.13 Given MCP `create_session` with `mode:"review"` then `get_session` Then `mode` is `"review"`; `update_session_meta {mode:"publish"}` then `list_sessions` shows `"publish"`.   [verify: server]
AC-02.14 Given `copy-link-btn` is clicked on `/d/<slug>?view=read#intro` Then the clipboard holds exactly `<origin><base>d/<slug>` and an `app-toast` "Link copied" shows.   [verify: e2e]
AC-02.15 Given an editor switches to edit view on a review doc, then back to read Then the URL is `?view=edit` then `?view=read`, the sidebar persists in both, and `save-state` is not shown after a successful save.   [verify: e2e]
AC-02.16 Given an error toast is raised (e.g. AC-02.8) Then it has `data-testid="app-toast"`, `data-kind="error"`, `role="alert"`, closes via `app-toast-close`, and otherwise disappears after ~8 s; an info toast has `role="status"` and disappears after ~4 s.   [verify: e2e]
AC-02.17 Given the overflow menu is opened with Enter Then focus is on its first item; ArrowDown/ArrowUp wrap, Home/End jump, Esc closes and focus returns to `header-overflow-btn`, an outside click closes it.   [verify: e2e, a11y]
AC-02.18 Given a review doc at 1400×900 Then `doc-header` children appear in the 00 §2.2 order and the first `.btn-icon` in the document is `theme-toggle`.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
Testids (registry: 00 §10.1): `doc-header`, `doc-title`, `doc-updated`, `doc-mode-badge`, `doc-local-badge`, `app-home-link`, `nav-library` (#26),
`copy-link-btn`, `share-btn`, `view-toggle`, `view-toggle-read`, `view-toggle-edit` (#7 adds `view-toggle-split`), `app-toast`, `app-toast-close`, `header-overflow-btn`,
`header-overflow-menu`, `menu-history`, `menu-generate-prompt`, `menu-open-file`, `menu-new-doc`, `menu-refresh`,
`doc-mode-publish`, `doc-mode-review`, `doc-mode-hidden-comments`; existing `save-state`, `reviewer-name`,
`restore-revision`, `changes-banner`; classes `.sidebar`, `.approval-banner`, `.summary-panel`, `.selection-action-bar`.
API: `mode` on `POST /paste`, `GET /paste/:id`, `GET /paste/list`, `PUT /paste/:id/meta` (rule 12).
MCP: `mode` on `create_session`, `update_session_meta`, returned by `get_session`/`list_sessions` (rule 13).

## Edge cases the adversarial verifier must try
- Mode flipped by another tab while this tab has the comment popover open (popover closes cleanly, no orphan bar).
- Publish doc with a `must-fix` comment: no approval UI anywhere, and `GET /paste/:id/approval` still works.
- `PUT /paste/:id/meta {mode:"REVIEW"}` (case) → 400; `{mode:null}` → 400; `{}` → mode unchanged.
- Review doc at 390×844 — comments still reachable (via #5's comments drawer), no horizontal scroll.
- Rapid double toggle publish→review→publish: final server value equals final UI value.
- Local publish doc with a restored draft from before this feature (no `mode` key) opens as review.
- Keyboard: overflow menu fully operable (Tab to button, Enter, arrows, Esc) and mode radios announce checked state.

## Dependencies on other items (by number) and files likely touched
Needs #4 (`?view`, routes). Lands **before** #1, #5, #10, #23 (build order): it creates `app-toast` (00 §3.1) and the
header those items fill; #5 later supplies the final `docTitle` and phone collapse; #1 drops its switcher into the
header; #23 swaps the capability source (viewer ACs use pinned revisions until then, 00 §1.2). #7 extends the view
toggle; #26 filters by `mode`; #20 stores `mode` as a column. Existing e2e changes are listed in 00 §11 (sessions
created via `POST /paste` that expect comment UI must pass `mode:"review"`; `Preview`/`New`/`Generate Prompt`/
`history-button` selectors; `.filename`/`.sync-indicator` move to edit view).
Files: `src/App.vue`, `src/components/HeaderBar.vue` → `DocHeader.vue` + `HeaderOverflowMenu.vue` + `ViewToggle.vue`,
new `DocView.vue`, `AppToast.vue`, `AppMenu.vue`, `src/composables/useDocState.ts`, `useToast.ts`, `useMenu.ts`,
`useGlobalShortcuts.ts`, `src/types/index.ts`,
`src/composables/useShare.ts`, `src/composables/useSync.ts` (mode from poll), `src/composables/usePersistence.ts`,
`src/components/PreviewPane.vue` (selection/highlight gating), `src/components/RevisionsModal.vue`, `server/server.cjs`,
`server/mcp-server.js`, `server/mcp-server-http.js`.

## Decisions
- Publish hides review UI for editors too: one predictable page per mode; the editor switches mode to see comments.
- `callback_url` without `mode` implies review: an approval webhook only makes sense for a review doc.
- Dev `?filePath=` opens in review: it is the fixture harness for the existing comment/selection e2e suite.
- Review-mode viewers keep commenting/approving: that is how review links are used today.
- Generate Prompt moves to the overflow menu: it is a reviewer/agent tool, not reader chrome.
