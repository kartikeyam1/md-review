# 07 — Side-by-side edit + preview with synced scrolling

## Goal
Editors can write and see the rendered result at the same time (`?view=split`), with both panes kept
scrolled to the same place, for markdown and HTML documents. On narrow screens the same view degrades
to Edit/Preview tabs instead of two unreadable slivers.

## Scope / Out of scope
**In:** third view `split` (alongside `read` and `edit`); header toggle; resizable divider (mouse, touch,
keyboard); bidirectional synced scrolling with an on/off toggle; HTML docs (sandboxed iframe) supported;
tab fallback below a width breakpoint; preview keeps its scroll position while typing; absolute source
line numbers on preview blocks when the doc has front-matter.
**Out:** live cursor highlighting in the preview, click-in-preview-to-place-caret, scroll sync in
`read` or `edit` alone, per-doc remembered view (the URL is the source of truth), mermaid flicker while
typing (rendering cost is unchanged).

## Current state
- `src/types/index.ts:55` — `PaneMode = 'edit' | 'preview'`; there is no split mode.
- `src/App.vue:30` `paneMode` ref; `App.vue:705-725` renders **either** `EditorPane` (`v-if="paneMode === 'edit'"`)
  **or** `PreviewPane` (`v-if="paneMode === 'preview'"`) inside `.main-pane` (`flex: 7`, `App.vue:844`); the comments
  sidebar sits to its right (`App.vue:727-750`, `max-width: 340px` at `App.vue:894`).
- `src/components/HeaderBar.vue:147-161` — two-button Edit / Preview toggle, no testids.
- Preview blocks already carry `data-line-start` / `data-line-end` (0-indexed, end exclusive):
  `src/composables/useMarkdown.ts:95-132` (`renderToken` for every block open, plus fences, mermaid `<div>`, indented code).
- **Bug:** with YAML front-matter, `renderHtml` (`useMarkdown.ts:186-192`) renders `fm.body` separately, so every
  block's line numbers are relative to the body, i.e. off by `fm.endLine`. Comment highlighting is
  already affected; synced scroll would be too. **Fixed by #5 (rule 20), which lands earlier**; this item relies on it.
- HTML docs render in an opaque-origin sandboxed iframe loaded from a fresh Blob URL on **every** content
  change (`PreviewPane.vue:139-155`); the bridge script (`PreviewPane.vue:58-108`) only relays selections and a
  text-match `scroll` request. A reload resets the iframe to the top.
- `EditorPane.vue` (CodeMirror 6) exposes only `scrollToLine` (`EditorPane.vue:286-296`); its scroller is `.cm-scroller`.
- `PreviewPane` markdown root `.preview-pane` is the scroll container (`overflow-y: auto`, `PreviewPane.vue:414-423`).

## Behaviour
1. **Views.** The view set is `read | edit | split`. `?view=split` opens split view; changing view via the
   header toggle updates `?view=` with `history.replaceState` (no new history entry). Split is an editing
   view: it is offered only to editors (see #2/#23 capability). A viewer opening `?view=split` gets `read`
   and the URL is rewritten to `?view=read`.
2. **Header toggle** — this item adds the third segment to #2's `view-toggle` group (`ViewToggle.vue`): Read / Edit /
   Split (`view-toggle-read`, `view-toggle-edit`, `view-toggle-split`); the active one has `aria-pressed="true"`.
   Labels and phone icon-only rule per 00 §2.2.
3. **Layout (wide, viewport width ≥ 960px).** `.main-pane` holds `split-view` = editor pane (left) |
   `split-divider` | preview pane (right). The comments sidebar (review-mode docs) stays to the right of the
   whole split view, unchanged.
4. **Divider.** Default ratio 50/50. Dragging (pointer events: mouse and touch) changes the ratio live.
   Each pane is never narrower than 240px. Double-click resets to 50/50. The divider is `role="separator"`,
   `aria-orientation="vertical"`, focusable (`tabindex="0"`), exposes `aria-valuenow` = editor share in
   whole percent (min/max via `aria-valuemin`/`aria-valuemax`); ArrowLeft/ArrowRight move it by 5
   percentage points, Home/End jump to the min/max. The ratio is a reader preference stored in
   localStorage key `md-review-split-ratio` (try/catch; invalid or missing → 50).
5. **Narrow (viewport < 960px).** Split view shows a tab strip `split-tabs` with `split-tab-edit` and
   `split-tab-preview`; only one pane is visible at a time (the other is `display:none`, not unmounted, so
   editor state and undo history survive). Default tab: Edit. `?view=` stays `split`. Resizing across the
   breakpoint switches layout live without losing editor content, selection or history.
6. **Live preview.** The preview reflects editor content; markdown re-renders as today. HTML preview in
   split view re-renders at most once per 400ms of typing (trailing debounce) to avoid iframe reload storms.
7. **Preview scroll stability.** Re-rendering never jumps the preview to the top: after any re-render
   the preview is re-synced to the editor's current position (if sync on) or keeps its previous `scrollTop`
   (if sync off). For HTML, the bridge restores the scroll position after each iframe load.
8. **Synced scroll — markdown.** Source of truth = the top visible editor line *L* (0-indexed, fractional
   within a line allowed). Editor → preview: find the deepest preview element with
   `data-line-start ≤ L < data-line-end` (if none, the last element starting before *L*; before the first
   block → top), interpolate linearly inside it by line fraction, and set the preview `scrollTop` so that
   point sits at the preview's top edge. Preview → editor: inverse mapping from the preview's top edge to a
   line, then scroll the editor so that line is at its top. Both ends clamp: editor at bottom ⇒ preview at
   bottom, and vice versa.
9. **Synced scroll — HTML.** The iframe is cross-origin, so sync is proportional: ratio =
   `scrollTop / (scrollHeight − clientHeight)` (0 when not scrollable), relayed both ways via the bridge
   (`{__mdreview:true,type:'scroll-ratio',ratio}`), parent→iframe and iframe→parent.
10. **No feedback loops.** A scroll caused by sync must not trigger a sync back (e.g. suppress the
    follower's scroll events for one animation frame / until its next user scroll). Sync work runs at
    most once per animation frame.
11. **Sync toggle** `split-sync-toggle` (`aria-pressed`) turns sync on/off; default on; stored in
    localStorage `md-review-split-sync` (`"0"`/`"1"`).
12. **Line numbers are absolute** — owned and implemented by #5 rule 20 (moved there so every earlier item gets correct
    lines); this item depends on it and keeps AC-07.15 as an end-to-end regression check in split view.
13. **Selections/comments.** In a review-mode doc, selecting text in either pane of split view raises the
    existing comment action bar exactly as in that pane's single view. Comment-sidebar "scroll to"
    scrolls both panes (editor via `scrollToLine`, preview via its own `scrollToLine`).
14. **Lazy editor (#6).** Split view shows a lightweight placeholder in the editor pane while the editor
    chunk loads; the preview renders immediately.

## Decisions
- Breakpoint is **viewport** width 960px, not pane width — deterministic for verifiers (desktop = side by side, tablet/phone = tabs).
- HTML sync is proportional, not line-mapped: the sandboxed iframe gives no line attributes; text matching per scroll event is too slow/unstable.
- Ratio + sync toggle are per-reader prefs (localStorage); the view itself lives only in the URL.
- Hidden tab pane is kept mounted so CodeMirror history (#8) is not lost when switching tabs.

## Acceptance criteria
AC-07.1 Given an editor opens a markdown doc with `?view=split` at 1400×900 When it loads Then `split-view`, an editor (`.cm-content`), `split-divider` and the preview are all visible side by side and `view-toggle-split` has `aria-pressed="true"`.   [verify: e2e]
AC-07.2 Given a doc in Read view When the user clicks `view-toggle-split` Then the URL query contains `view=split`, `history.length` is unchanged, and both panes are visible.   [verify: e2e]
AC-07.3 Given split view When the user types `ZEBRA123` at the end of the editor Then the preview contains `ZEBRA123` within 1s without any click.   [verify: e2e]
AC-07.4 Given split view at 1400px When the divider is dragged 200px to the left Then the editor pane's width decreases by 200±10px; When dragged far past the edge Then the editor pane is ≥ 240px wide; When the page reloads Then the ratio is restored; When the divider is double-clicked Then the panes are 50/50 (±1%).   [verify: e2e]
AC-07.5 Given the divider is focused When ArrowRight is pressed twice Then `aria-valuenow` increases by 10.   [verify: a11y]
AC-07.6 Given a 300-line markdown fixture with a heading every 20 lines in split view (sync on) When the editor is scrolled so source line 140 is the first visible line Then within 300ms the preview element whose `data-line-start ≤ 140 < data-line-end` (deepest) has its top within ±48px of the preview's top edge (or the element spans the top edge).   [verify: e2e]
AC-07.7 Given the same fixture When the preview is scrolled so the heading starting at source line 200 is at its top Then within 300ms the editor's first visible line is within 200±2.   [verify: e2e]
AC-07.8 Given split view When either pane is scrolled to its very bottom Then the other pane's `scrollTop + clientHeight ≥ scrollHeight − 2` within 300ms; same for top (`scrollTop ≤ 2`).   [verify: e2e]
AC-07.9 Given sync is turned off via `split-sync-toggle` When the editor is scrolled Then the preview `scrollTop` does not change; after reload the toggle is still off.   [verify: e2e]
AC-07.10 Given an HTML doc taller than the viewport in split view When the editor is scrolled to 50% Then the iframe document's scroll ratio is 0.5±0.05 (read via the bridge or the iframe's reported ratio), and scrolling the iframe to its bottom scrolls the editor to its bottom.   [verify: e2e]
AC-07.11 Given an HTML doc in split view with the preview scrolled to the middle When the user types 10 characters in the editor Then after the debounced reload the iframe is not at scroll 0 (it is re-synced/restored), and the iframe reloaded at most 2 times for those 10 keystrokes.   [verify: e2e]
AC-07.12 Given a markdown doc in split view with sync off and the preview scrolled to 2000px When the user types in the editor Then the preview `scrollTop` stays within ±50px of 2000.   [verify: e2e]
AC-07.13 Given a viewport of 820×1180 (and 390×844) with `?view=split` Then `split-tabs` is visible, only the editor is visible, clicking `split-tab-preview` shows only the preview, and there is no horizontal page scroll.   [verify: e2e, visual]
AC-07.14 Given narrow split with edits typed and then `split-tab-preview` → `split-tab-edit` When the user presses Ctrl/Cmd+Z Then the last edit is undone (editor was not remounted).   [verify: e2e]
AC-07.15 Given a doc beginning with a 4-line front-matter block (`---`,`a: 1`,`b: 2`,`---`) followed by `# Title` on source line 4 When shown in split view with sync on and the editor scrolled so line 4 is the first visible line Then the preview `h1` (`data-line-start="4"`, per #5 AC-05.19) is at the preview's top edge (±48px).   [verify: e2e]
AC-07.16 Given a viewer (no edit capability) opens `?view=split` Then the Read view is shown, `view-toggle-split` is absent, and the URL reads `view=read`.   [verify: e2e]
AC-07.17 Given a review-mode doc in split view When text is selected in the preview pane Then the comment action bar appears (same as Read view).   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`view-toggle-read`, `view-toggle-edit`, `view-toggle-split`, `split-view`, `split-pane-editor`, `split-pane-preview`,
`split-divider`, `split-sync-toggle`, `split-tabs`, `split-tab-edit`, `split-tab-preview`.
Bridge message added: `{__mdreview:true, type:'scroll-ratio', ratio:number}` in both directions. No server/MCP changes.
localStorage keys: `md-review-split-ratio`, `md-review-split-sync`.

## Edge cases the adversarial verifier must try
- Empty doc; doc shorter than the viewport (nothing to scroll — no errors, no jitter).
- Fast alternating scrolls in both panes (no infinite ping-pong; `scrollTop` settles within 500ms).
- Long fenced code block / tall mermaid diagram / large table spanning many screens (interpolation inside one element).
- Mermaid finishing render after sync (heights change) — next scroll still aligns.
- Resize the window across 960px repeatedly while typing; content and caret preserved.
- Divider dragged with touch at tablet width just above 960 (e.g. 1000×800).
- Front-matter doc + comments: highlights land on the correct blocks in Read and Split.
- HTML doc whose own script changes its height after load; HTML doc with no `<body>` tag.
- `?view=split&filePath=…` dev loader still works.

## Dependencies on other items (by number) and files likely touched
Depends on #2 (read/edit views, capability), #4 (`?view=` routing), #6 (lazy editor), #5 (absolute line numbers). Interacts
with #8 (history must survive tab switches), #13 (focus mode applies to split), #3 (TOC width budget at desktop).
Files: `src/components/DocView.vue`, `src/composables/useDocState.ts`, `src/types/index.ts`, `src/components/ViewToggle.vue`,
new `src/components/SplitView.vue`, `src/components/EditorPane.vue` (expose scroller/top-line API), `src/components/PreviewPane.vue`
(bridge + scroll API — the only W3 item editing PreviewPane core), new `src/composables/useScrollSync.ts` (pure mapping fns, unit-tested).
