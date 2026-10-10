# Decisions log

Decisions made autonomously while the owner was AFK. Each line: decision — reason.

## Owner-approved (2026-10-10)
- Locus theme: purple buttons use #280A38 text; dark-mode table header #533B60; code font JetBrains Mono; comment highlight keeps 2px stripe.
- Storage: `node:sqlite` + FTS5; migration is a script, tested on a copy of real data only.
- Cover images: PNG via @resvg/resvg-js. Real Slack unfurls are not tested.
- Single draft PR, one green commit per item. Security hardening out of scope.

## Defaults applied
- Named readers = self-declared reviewer name (no auth exists).
- Legacy sessions (no edit token) stay link-editable.
- GitHub Pages path routes via 404.html SPA fallback.

## Spec reconciliation (2026-10-10, see specs/00-cross-cutting.md and BUILD-ORDER.md)
- View toggle = one `view-toggle` group with `view-toggle-read|edit|split`, labels Read/Edit/Split — replaces Edit/Preview; existing `has-text("Edit")` selectors keep working, `"Preview"` ones move to `view-toggle-read`.
- `AppToast`/`AppMenu`/`useDocState`/`DocView` are built by #2 (first consumer), not #10/#1 — needed by the foundation wave.
- `EditorToolbar` owned by #8; `focus-mode-btn` lives in it (not the header) so it survives focus mode.
- Pasted table = 2 undo steps (raw paste, then pre-paste); slash insert = 1 step back to `/query`.
- One search endpoint: `GET /library/docs` (list + FTS, segment snippets); `GET /search` dropped; #20 implements it.
- `docTitle` precedence: sessionName > front-matter title / HTML `<title>` > first human-visible H1 > filename > Untitled (FE and server).
- Handed-out server URLs use `PUBLIC_BASE_URL` only when explicitly set, else `FRONTEND_URL`; FE-built links always use the page origin.
- Reader identity: `reader_id` (anon-uuid) for reactions/views; `reader_key` = `name:<lower name>` else reader_id for pins, header percent-encoded.
- Front-matter absolute line numbers fixed by #5 (first useMarkdown item), not #7.
- All UI view changes use `replaceState` (incl. slides entry); Back never steps through views.
- `?` shortcuts overlay only in edit/split views; Esc layering and z-index scale centralised in 00 §3.
- Viewers have no `share-btn`/share dialog; they use `copy-link-btn`.
