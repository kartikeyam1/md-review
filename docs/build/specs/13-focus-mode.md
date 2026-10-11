# 13 — Focus mode

## Goal
A distraction-free writing surface: one toggle hides the app chrome (header, banners, comments sidebar,
TOC) so the editor — or the split editor + preview — fills the window, while save status and a way out
stay one glance / one key away.

## Scope / Out of scope
**In:** focus toggle button + shortcut, Esc exit, which chrome is hidden and what stays, layout of Edit and
Split views in focus, interplay with overlays (Esc layering), session-only state.
**Out:** browser Fullscreen API, typewriter scrolling, dimming of non-active paragraphs, focus mode for
Read view (reading comfort is #18), persisting focus mode across documents or reloads, putting it in the URL.

## Current state
- No focus mode exists. Chrome rendered by `src/App.vue`: `HeaderBar` (`App.vue:625-653`), `ApprovalBanner`
  (`App.vue:659-669`), `SummaryPanel` (`App.vue:671-676`), `ChangesBanner` (`App.vue:678-683`), notice bar (`App.vue:685-688`),
  persist-error bar (`App.vue:690-692`), conflict bar (`App.vue:694-703`), comments sidebar toggle + `CommentsSidebar`
  (`App.vue:727-750`). The editor lives in `.main-pane` (`flex: 7`, `App.vue:844-847`).
- Global keydown handler handles only Mod+S (`App.vue:239-244`), registered at `App.vue:407`.
- Save status is only shown in the header (`src/components/HeaderBar.vue:167-177`, `data-testid="save-state"`).
- CodeMirror consumes Escape only when it has something to do (`simplifySelection` in `defaultKeymap`; search
  panel close) — otherwise the event propagates (and arms tab-focus mode for 2 s).

## Behaviour
1. **Availability.** Focus mode exists only in Edit and Split views (#7) for users who can edit. It is not
   offered in Read view, on the upload/library screens, or with `?embed=1`.
2. **Toggle.** A button `focus-mode-btn` at the right end of the shared `EditorToolbar` (00 §3.3 — not in the header,
   so it stays reachable while the header is hidden; `aria-label="Focus mode"`, `aria-pressed`, title with the
   shortcut) and the shortcut **Mod+Shift+Enter** (registered via `useGlobalShortcuts`, 00 §3.5) (Cmd on macOS, Ctrl elsewhere) toggle focus mode. The
   shortcut works whether focus is in the editor, the preview, or the page body, and `preventDefault`s.
3. **Hidden in focus mode:** the header (`doc-header`), ApprovalBanner, SummaryPanel, ChangesBanner, the notice bar, the
   comments sidebar and its toggle, the TOC (#3). The editor toolbar (#8/#9) is kept (see 5).
   The `.app` root gets `data-focus-mode="true"` (absent/`"false"` otherwise).
4. **Still visible (safety):** the conflict bar (`conflict-bar`) and the persist-error bar (`persist-error`) —
   data-loss warnings are never hidden. Modals opened explicitly (History, shortcuts overlay #9) still work.
5. **Floating controls.** A small fixed cluster `focus-controls` at the top-right shows the save status
   (`focus-save-state`, same labels as the header's `save-state`: Saved / Unsaved changes / Saving… /
   Save failed / Conflict; hidden for unshared local docs where the header shows none) and an exit button
   `focus-exit-btn` (`aria-label="Exit focus mode"`). The cluster rests at opacity 0.35 and goes to 1 on
   hover or when any of its controls has keyboard focus. It never covers the first line of editor text
   (editor gets enough top padding). The editor toolbar (#8/#9: undo, redo, shortcuts) stays available.
6. **Layout — Edit view.** `.main-pane` spans the full viewport width; the editor fills the viewport height
   (minus a visible conflict/persist bar). The text column is centred with `max-width: 860px` on
   `.cm-content`'s container so lines stay readable on wide screens (gutter stays attached to the column).
7. **Layout — Split view.** Editor | divider | preview span the full viewport width; the divider ratio and
   sync behave as in #7; below 960px the split tabs (#7) remain visible.
8. **Entering** moves keyboard focus into the editor (keeping the caret/selection and scroll position).
   **Exiting** restores all chrome exactly as before (e.g. a sidebar the user had collapsed stays collapsed)
   and keeps caret, selection, scroll, view and undo history.
9. **Esc layering** (canonical full order: 00 §3.4). Esc closes the innermost open layer first, one layer per press:
   open modal/overlay → comment popover/action bar → slash menu (#12) → CodeMirror search panel → multi-selection
   simplify → *then* focus mode exits. Esc pressed in the editor with none of those open exits focus mode.
10. **State scope.** Focus mode is in-memory per page: it is off on every page load, turns off when the
    user switches to Read view or navigates to another document/route (library, `/`, another `/d/…`), and is
    never written to localStorage or the URL. Switching Edit ↔ Split keeps it on.
11. **Phone/tablet.** Works at all viewports; on phones the exit button is at least 40×40 px.
12. **Shortcuts overlay row.** This item appends a "Focus mode" row (Mod+Shift+Enter) to #9's `shortcuts-overlay`.

## Decisions
- Shortcut **Mod+Shift+Enter**: unbound in CodeMirror and in Chrome/Firefox/Safari; Mod+Shift+F is taken by Chrome on macOS ("always show toolbar in full screen") and F11 is the browser's own fullscreen.
- Not persisted (not even per doc): a shared link must never open with chrome hidden, and users should not get "stuck" without the header on the next doc.
- No Fullscreen API: it needs a user gesture each time, behaves badly on iOS, and hides the OS status the writer may want.
- Conflict/persist warnings stay visible in focus mode — losing work silently is worse than a little chrome.
- Read view excluded: reader comfort controls live in #18; focus mode is a writing feature.

## Acceptance criteria
AC-13.1 Given an editor in Edit view at 1400×900 When `focus-mode-btn` (in `editor-toolbar`) is clicked Then `.app` has `data-focus-mode="true"`, the header (`[data-testid=doc-header]`), comments sidebar, and banners are not visible, `.main-pane` width equals the viewport width (±2px), and `focus-exit-btn` is visible.   [verify: e2e]
AC-13.2 Given focus mode in Edit view at 1400px Then `.cm-content`'s container is ≤ 860px wide and horizontally centred (left and right margins differ by ≤ 20px).   [verify: e2e, visual]
AC-13.3 Given Edit view with the caret in the editor When Mod+Shift+Enter is pressed Then focus mode turns on, the caret is still in `.cm-content` at the same position (typing `X` inserts at the old caret), and pressing Mod+Shift+Enter again turns it off.   [verify: e2e]
AC-13.4 Given focus mode with no popover/search/overlay open and focus in the editor When Esc is pressed Then focus mode exits and the header is visible again.   [verify: e2e]
AC-13.5 Given focus mode with the CodeMirror search panel open (Mod+F) When Esc is pressed once Then the search panel closes and focus mode is still on; When Esc is pressed again Then focus mode exits.   [verify: e2e]
AC-13.6 Given focus mode with the shortcuts overlay (#9) open When Esc Then only the overlay closes; focus mode stays on.   [verify: e2e]
AC-13.7 Given a shared doc in focus mode When the user types Then `focus-save-state` shows "Unsaved changes" and, after autosave, "Saved".   [verify: e2e]
AC-13.8 Given a shared doc with unsaved edits in focus mode When a remote change produces a conflict Then `conflict-bar` is visible while `data-focus-mode="true"` remains.   [verify: e2e]
AC-13.9 Given Split view (`?view=split`) at 1400px When focus mode is entered Then the editor pane, `split-divider` and preview are visible and together span the viewport width (±2px), with the header hidden.   [verify: e2e]
AC-13.10 Given focus mode When the user switches to Read view (e.g. via a shortcut or after exit) or reloads the page Then `data-focus-mode` is not `"true"`; and localStorage contains no key whose value records focus mode, and the URL is unchanged by entering focus mode.   [verify: e2e]
AC-13.11 Given the comments sidebar was collapsed before entering focus mode When focus mode is exited Then the sidebar is still collapsed; and the text typed in focus mode can be undone with Mod+Z after exit.   [verify: e2e]
AC-13.12 Given Read view, or a viewer without edit capability Then `focus-mode-btn` is absent and Mod+Shift+Enter does nothing (no `data-focus-mode="true"`).   [verify: e2e]
AC-13.13 Given focus mode at 390×844 Then `focus-exit-btn` is at least 40×40px, fully inside the viewport, does not overlap the first editor line's text, and there is no horizontal scroll.   [verify: e2e, visual]
AC-13.14 Given focus mode Then `focus-exit-btn` and `focus-mode-btn` (when shown) are keyboard-focusable with accessible names; `focus-controls` has computed opacity < 0.5 at rest and 1 while `focus-exit-btn` is focused.   [verify: a11y]
AC-13.15 Given Edit view When `editor-shortcuts-btn` is clicked Then `shortcuts-overlay` contains a `shortcuts-row` "Focus mode" showing Mod+Shift+Enter with platform labels.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`focus-mode-btn`, `focus-controls`, `focus-save-state`, `focus-exit-btn`; attribute `data-focus-mode` on `.app`.
Relies on `conflict-bar`, `persist-error`, `save-state` (existing), `split-divider` (#7), `shortcuts-overlay` (#9), `view-toggle-read` (#7/#2).
No server/MCP changes.

## Edge cases the adversarial verifier must try
- Toggle rapidly 10× with the shortcut while typing — no lost keystrokes, no stuck hidden chrome.
- Enter focus mode, open History via any remaining path, close it — still in focus mode.
- Esc while a multi-cursor selection exists: first Esc collapses to one cursor, second exits focus.
- Esc then Tab (CodeMirror tab-escape) in focus mode — focus mode exits on Esc; Tab then moves focus normally.
- Resize from desktop to phone while in focus split view.
- Unshared local doc in focus mode (no save state to show — cluster shows only the exit button).
- Navigate with browser Back to another document while in focus mode — chrome visible on the new doc.

## Dependencies on other items (by number) and files likely touched
Depends on #2 (views/capability), #7 (split layout), #9 (shortcuts overlay + Esc layering), #8 (editor toolbar). Interacts with
#3 (TOC hidden), #4 (route change exits), #5 (mobile layout), #12 (slash menu Esc). Files: `src/components/DocView.vue` (state, chrome
`v-if`/`v-show`), `src/composables/useGlobalShortcuts.ts` (shortcut), `src/components/EditorToolbar.vue` (button), new
`src/components/FocusControls.vue`, `src/components/EditorPane.vue` (centred column style), `src/components/SplitView.vue`,
`src/components/ShortcutsOverlay.vue` row data.
