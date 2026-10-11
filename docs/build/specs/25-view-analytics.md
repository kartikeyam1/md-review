# 25 — View counts and named readers

## Goal
Authors want to know whether anyone read the doc they shared and whether the people who matter saw the latest
version. Show total views and unique readers to everyone, and the named reader list (who, when, which revision) to
editors.

## Scope / Out of scope
In: view recording (debounced, one per reader per doc per UTC day), aggregate counts, editor-only reader list,
REST + MCP read, header UI.
Out: per-section read depth, time-on-page, IP/geo tracking, counting unfurl bots or API/MCP reads, notifications,
historical charts (a library column for #26 is optional there).

## Current state
- No view tracking exists. Reader identity: reviewer name in `md-review-reviewer` (`src/composables/useReviewer.ts:3`);
  #24 introduces the anonymous `reader_id` (`md-review-reader-id`).
- Revisions are identified by `content_hash` (`server/server.cjs:214-218`), which the UI already holds as the
  If-Match token (`src/composables/useShare.ts:36-37`).
- Header bar hosts doc-level status (`src/components/HeaderBar.vue:118-173`, testids `reviewer-name`, `save-state`).
- `views` table created empty by #20.

## Behaviour
1. **Storage** `views(session_id, reader_id, day TEXT /*YYYY-MM-DD UTC*/, name, revision, first_viewed_at,
   last_viewed_at, is_editor INTEGER, PK(session_id, reader_id, day))`. Deleted with the doc. No IP or UA stored.
2. **Record** `POST /paste/:id/views` body `{reader_id, name?, revision?}` (identity per 00 §7, validation as #24 rule 2; `revision`
   must be 32 hex or omitted → defaults to current hash). First call for (doc, reader, UTC day) inserts; later calls
   that day update `last_viewed_at`, `revision`, and `name` (if non-empty). Response 204. No token required; if a
   **valid** edit token for a protected doc is presented, the row is stored with `is_editor=1`. 404/410 as usual.
3. **Client debounce.** The SPA records a view when a doc (or pinned revision) has been rendered and the tab visible
   for ≥ 2 s continuously; at most one POST per doc per page load, plus one more each time the rendered revision
   changes (live sync or opening `@rev`). Never in `?embed=1`, never from the dev `?filePath=` loader or for unsaved
   local docs. The backend `/d/` meta route (#22), `GET /paste/*`, and MCP tools never record views.
4. **Read** `GET /paste/:id/views` → 200 `{total_views, unique_readers, last_viewed_at}` for anyone, where
   `total_views` = number of (reader, day) rows with `is_editor=0`, `unique_readers` = distinct `reader_id` with
   `is_editor=0`, `last_viewed_at` = max over those rows (null if none).
   **Editors** (valid token, or legacy link-editable doc per #23) additionally get
   `readers: [{name, last_viewed_at, revision, is_current, views}]` and `anonymous_readers: number`:
   - rows grouped by name (case-insensitive, latest spelling shown); `views` = row count; `revision` and
     `last_viewed_at` from the most recent row; `is_current` = revision equals current content hash;
   - sorted by `last_viewed_at` desc; editor rows excluded; `anonymous_readers` = distinct reader_ids that never
     sent a name.
   Non-editors never receive `readers` or `anonymous_readers` keys.
5. **Header UI** (`ViewStats.vue`; placement per 00 §2.2 — reader header centre group after `doc-updated` on desktop,
   inside `doc-meta-row` below 1100px; not shown in the editor header). For shared docs it shows `view-stats`: "{total_views} views · {unique_readers} readers"
   (singular forms for 1; hidden when total is 0). For editors it is a button opening `readers-panel`:
   one `reader-row` per named reader with name, relative time ("2 h ago", full ISO in `title`), and either
   "latest" (`reader-latest-badge`) or "older version" (`reader-stale-badge`, title = short hash); a footer line
   "+ N anonymous" (`readers-anonymous`). Empty state "No named readers yet" (`readers-empty`). For viewers it is
   plain text, not focusable as a button. Panel works at phone width (full-width sheet).
6. Stats refresh on doc load and after the reader's own view is recorded; no extra polling.
7. **MCP `get_views({sessionId, editToken?})`** (both servers) → the REST body, using the #23 token store so the
   creating agent sees readers. The `list_sessions` output is unchanged.

## Acceptance criteria
AC-25.1 Given reader `r-aaaaaaaa` posting a view 3 times in one day, Then `GET /views` shows `total_views:1`, `unique_readers:1`.   [verify: server]
AC-25.2 Given the same reader posting on two different UTC days (test clock or seeded row), Then `total_views:2`, `unique_readers:1`.   [verify: server]
AC-25.3 Given views from "Ana" (2 browsers), "ana" and one anonymous reader on a protected doc, When `GET /views` with the token, Then `readers` has one "Ana"/"ana" entry with `views` = row count, `anonymous_readers:1`; without the token the body has only the three aggregate keys.   [verify: server]
AC-25.4 Given Ana viewed revision A and the doc then changed to B, Then her entry has `is_current:false` and `revision` = A.   [verify: server]
AC-25.5 Given a view posted with the doc's valid edit token, Then `total_views` and `unique_readers` do not change.   [verify: server]
AC-25.6 Given a legacy (unprotected) doc, When `GET /views` without any token, Then `readers` is present.   [verify: server]
AC-25.7 Given invalid `reader_id` or `revision:"xyz"`, Then 400; unknown doc 404; expired 410.   [verify: server]
AC-25.8 Given the app opens a shared doc and stays visible 3 s, Then exactly one `POST /views` is sent with the current `content_hash` as `revision`; a reload within the same day does not change `total_views`.   [verify: e2e]
AC-25.9 Given the app opens a doc and navigates away after 1 s, Then no `POST /views` is sent.   [verify: e2e]
AC-25.10 Given `/d/<slug>?embed=1` or a `?filePath=` fixture, Then no `POST /views` is sent.   [verify: e2e]
AC-25.11 Given an editor with 2 named readers recorded, When clicking `view-stats`, Then `readers-panel` lists 2 `reader-row`s, the stale one with `reader-stale-badge`.   [verify: e2e]
AC-25.12 Given a viewer (no token, protected doc), Then `view-stats` shows counts and clicking it opens nothing.   [verify: e2e]
AC-25.13 Given `GET /d/<slug>` by Slackbot and MCP `get_session`, Then view counts are unchanged.   [verify: server]
AC-25.14 Given MCP `get_views` after the agent created the doc, Then the result includes `readers`.   [verify: server]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `view-stats`, `readers-panel`, `reader-row`, `reader-latest-badge`, `reader-stale-badge`,
`readers-anonymous`, `readers-empty`. API: `POST|GET /paste/:id/views`. MCP: `get_views`. Server honours a
test-only env `MDREVIEW_NOW` (ISO timestamp) overriding the clock for day bucketing, ignored when unset.

## Edge cases the adversarial verifier must try
- View POST at 23:59:59 and 00:00:01 UTC → two rows.
- Name set after the first view of the day → the same row gains the name (anonymous count drops).
- Two tabs open on the same doc → still one row per day.
- localStorage blocked → in-memory reader id; a reload counts as a new reader (acceptable, documented).
- Doc deleted and slug re-used → counts start at 0.
- 5 000 view rows on a doc → `GET /views` < 100 ms.

## Dependencies on other items (by number) and files likely touched
Depends on #20 (table), #23 (editor gate, token store), #24 (`reader_id`), #4 (`/d/` routes, `@rev`, `embed`).
Consumer #26 (`view_count` in `GET /library/docs`, 00 §8 — this item fills it). Files: new `server/routes/views.cjs`,
`server/mcp-server.js`, `server/mcp-server-http.js`, `src/composables/useViews.ts` (new), `src/composables/useReader.ts`
(built by #24, 00 §7), new `src/components/ViewStats.vue` (one line in `DocHeader.vue` / `doc-meta-row`),
`src/components/ReadersPanel.vue` (new), `src/components/DocView.vue`.

## Decisions
- One view = one reader per doc per UTC day — robust to reloads and polling without server-side rate limiting.
- Reader list is editor-only; counts are public — readers see social proof without exposing who read what.
- Editors' own views (valid token on a protected doc) are excluded — authors re-opening their doc inflate counts.
- Readers grouped by name, not browser — the same person on laptop and phone is one reader in the list.
- 2 s visible-dwell before counting — filters link previews, prefetches and mis-clicks.
