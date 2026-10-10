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
- #20 (orchestrator): live data contains one corrupt stray file `oldformat12345.json` (a test artifact, not valid JSON). The migration keeps strict behaviour (reports it, exits non-zero); the PR's deploy steps tell the operator to delete that file first. The live data dir is never modified by the build.
- #2/#4 (orchestrator ruling): a pinned revision `/d/<id>@<hash>` never GETs the live `/paste/<id>` (AC-04.15 checks the pathname). It gets content from `/paste/<id>/revisions/<hash>`, comments from `/paste/<id>/comments`, approval from the approval endpoint, and the doc `mode` from a new additive `mode` field on the revision response (owned by #2).
- #2 (orchestrator ruling): menus focus the checked item if there is one, else the first (00 §3.2 wins over AC-02.17's wording).
- #2 (orchestrator ruling): #2 adds `data-testid="theme-toggle"` to the existing theme button; #1 then rebuilds the control around it.
- #2: durable-sync e2e expectations of a visible "✓ Saved" change to "save finished, save-state hidden" (spec rule 5); this is a listed pre-existing test change.

## Implementation decisions
- #4: UI view toggles do not write `?view=` yet — they *drop* a present `view` param (replaceState) so a reload/copied link cannot reopen a stale view; unknown/forbidden/empty values are rewritten to `view=read` and `?view=edit` is honoured on load. Writing the toggle into the URL reopens edit view after a reload, which breaks durable-sync.test.mjs:165-169 and :212-215 (they reload in edit view and expect `.preview-pane`) — #2/#7 (ViewToggle owners) wire it with that test change.
- #4: frame→parent `anchor-changed` with `id: ''` clears the fragment (rule 15's in-frame `href="#"`); otherwise only ids of 1–256 chars are accepted. Frame-driven fragment updates are coalesced to ≤ 2/s and dropped if the route changed meanwhile; every history call is try/caught (Safari throws past its rate limit).
- #4: one leave rule (rule 13): any navigation away from the attached shared doc with unsaved changes (link, Back/Forward, library, New, not-found) flushes autosave for ≤ 1.5 s while the doc stays on screen, then `confirm()`s. Cancel pushes the doc URL back; accepting discards the edits (detach + drop the persisted draft), so later navigation does not ask again.
- #4: drafts: the main draft slot only ever holds what the current route shows (paused otherwise), and the never-shared local draft also lives in its own slot (`md-review-local-draft`), so opening a shared doc never costs it. The landing route shows that local draft when arriving from elsewhere; sharing a local doc (or New on it) forgets it; New from a shared doc keeps it in storage. An all-empty screen writes nothing. Exception kept from before: a doc that answers 404/410 while this browser holds its draft turns that copy into the local doc.
- #4: slugs are matched case-sensitively by the server (`/d/Weekly` ≠ `/d/weekly` → doc-not-found); left as-is.
- #4: local-draft persistence is paused on pinned-revision, file and embed views so viewing them never overwrites the reader's own draft.
- #4: pinned and file routes use a read-only header (no Edit/Preview, Save, History, Share, Generate Prompt, New, rename); the pinned header shows the doc id as its name (the revision API has no filename).
- #4: a doc that answers 404/410 while this browser holds its draft keeps the "Showing your local copy" notice and moves to the landing route (replaceState), where a local doc lives.
- Build order (orchestrator): #20 lands before #2 instead of after it. #20 changes no frontend code and its golden tests treat `mode` as an allowed additive field, so #2 adds `mode` directly on the SQLite storage instead of adding it to the JSON storage first.
- #5 (test author): `src/composables/useDocTitle.ts` exports `docTitle({sessionName, content, contentType, filename})` (00 §5 order, whitespace collapsed, no truncation), `truncateTitle(title, max=80)` (cut + `…`), `formatDocumentTitle(title)` → `<title> · md-review`.
- #8 (test author): `src/composables/useExternalChange.ts` exports `minimalChange(oldText, newText)` → `null` when equal, else one `{from, to, insert}` covering only the changed span.
- #3 (test author): `src/markdown/headingIds.ts` exports `slugify(text)`, `assignIds(texts[])`, `extractHeadings(source)` → `{level,id,text}[]` (same ids as rendered), `buildToc(headings)` → `{id,text,level,depth}[]` (drops a lone leading H1, levels 1–3, `[]` when < 2). Slugs match github-slugger@2.0.0.
- #9 (test author): `src/editor/markdownCommands.ts` exports CodeMirror state commands `toggleBold`, `toggleItalic`, `toggleStrikethrough`, `toggleCode`, `toggleLink`.
- Scope add (orchestrator): QA on #4 found two PRE-EXISTING sync bugs (also on master 65d5a29). (1) Major: after a 412 conflict, a reload/close+reopen forgets the conflict state ("Unsaved changes"), and the next save PUTs with the collaborator's hash as If-Match and overwrites their change. (2) Minor: with saves failing, typing then reloading within ~300 ms loses the text (draft not flushed on pagehide). Both are assigned to #8, which owns useSync's remote-change handling; the conflict state must persist with the draft and survive reload.
- Scope add: at 390 px the doc header overflows and the view toggle is unreachable — covered by #2 (header) / #5 (phone header).
