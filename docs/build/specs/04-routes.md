# 04 — Path-based routes

## Goal
Every doc gets a stable, readable URL (`/d/:slug`) that survives reloads, Back/Forward and being pasted
into Slack, and heading links (`/d/:slug#heading`) work without ever losing the document. Old `#shared=`
links keep working.

## Scope / Out of scope
**In:** History-API router honouring the base path; route table from SPEC-CONVENTIONS; legacy hash
redirects; in-app navigation (library, new doc, share created, links between docs); fragment handling
for markdown and HTML (iframe) docs; `?view=` parsing; `?edit=` stripping hook; `?embed=1` minimal
chrome; GitHub Pages `404.html` fallback; share URLs in FE, MCP and CLI; not-found states.
**Out:** server-rendered `/d/:slug` meta (#22); token semantics behind `?edit=` (#23); library UI (#26);
split/slides/agent views themselves (#7/#29/#28); TOC/heading ids (#3, which this item consumes).

## Current state
- Hash routing only: `useShare.ts:144-148` `getShareIdFromHash()` accepts exactly `^#shared=<id>$`;
  `setShareHash`/`clearShareHash` (`:150-158`) and `getShareUrls` (`:160-164`) build `…#shared=<id>`.
- `App.vue:389-393` `onHashChange` → `loadSharedDoc()`; `App.vue:406` listens to `hashchange`.
  `#dashboard` (`App.vue:381-387`) and `#github=` (`App.vue:369-379`) share the same fragment.
- **Bug:** the rendered markdown has heading ids (`useMarkdown.ts:69-91`) and links like `[x](#intro)`.
  Clicking one replaces the fragment, so the URL becomes `/#intro`: the doc id is gone from the address
  bar, a reload or a copied link opens the upload screen / a stale local draft, and if the click happens
  while the share is still loading `loadSharedDoc` aborts (`App.vue:319` "navigated away meanwhile") and
  the doc never loads.
- `usePersistence.ts:72-74` re-attaches a restored draft by writing `#shared=<id>` when the URL is bare.
- `DashboardView.vue:40` navigates with `window.location.hash = '#shared=…'`.
- `App.vue:474` `handleNewDoc` clears search+hash with `replaceState`.
- HTML docs: sandboxed blob iframe (`PreviewPane.vue:124-147`); the bridge already intercepts in-frame
  `#anchor` clicks and scrolls (`PreviewPane.vue:68-85`) but never tells the parent.
- MCP/CLI share URLs: `server/mcp-server.js:116,123,347`, `server/cli.mjs:149,186` all `…/#shared=<id>`.
- `vite.config.ts:35` base `/md-review/` when `GITHUB_PAGES=true`; no `404.html` is emitted
  (`.github/workflows/deploy-pages.yml` uploads `dist` as-is), so any deep path 404s on Pages today.

## Behaviour
1. **Base.** All routing is relative to `import.meta.env.BASE_URL` (`/md-review/` on Pages, `/` in dev).
   `<base>/index.html` is treated as `<base>`. Implementation may use vue-router (`createWebHistory(BASE_URL)`)
   or a small composable; hash-mode routing is forbidden.
2. **Route table** (after stripping base; `ID = [a-zA-Z0-9][a-zA-Z0-9-]*`, same as the server):
   - `` (empty) → landing (upload / restored local draft, see rule 9).
   - `library` → library (#26 renders it; until #26 the existing dashboard component).
   - `d/<ID>` → shared doc. A trailing slash (`d/<ID>/`) is replaced (`replaceState`) by `d/<ID>`.
   - `d/<ID>@<HASH>` with `HASH = [0-9a-f]{32}` → pinned revision (rule 7).
   - `d/<ID>/<FILE…>` → file in a multi-file session; `FILE` is everything after the second slash,
     percent-decoded, may contain `/` (rule 8).
   - anything else → `not-found` view (`data-testid="not-found"`) with a link to the landing page. No fetch.
3. **Fragment = anchor only.** On every route except the landing route, the fragment is only ever a
   heading/anchor id, percent-decoded before lookup. `/d/x#dashboard` scrolls to a heading `dashboard`
   (if any) and never redirects.
4. **Legacy redirects** — evaluated only when the route is the landing route, before anything renders,
   using `history.replaceState` (no extra history entry). Query params other than `filePath` are kept:
   - `#shared=<ID>` → `d/<ID>` (e.g. `/md-review/?view=edit#shared=abc` → `/md-review/d/abc?view=edit`).
   - `#dashboard` → `library?mode=review` (aligned with #26).
   - `#github=<encoded url>` → stays on the landing route: the file is fetched via `/github`, opened as a
     local doc, then the fragment is removed. Fetch failure → the existing error notice, URL becomes `<base>`.
   - Any other fragment on the landing route is ignored and left alone.
5. **`?view=`** values: `read` (default), `edit`, `split`, `slides`, `agent`. Full resolution table: 00 §1.3 (this
   item owns it). Unknown values, or a view the user may not use (edit/split for a viewer, see #2), render `read` and
   rewrite the URL with `replaceState` to `view=read`. View changes made through the UI use `replaceState` (aligned
   with #07). Views not yet implemented render `read` without rewriting. `?embed=1` forces read and ignores `view`.
6. **`?edit=<token>`** is removed from the URL with `replaceState` before the first render completes and
   before any share/copy-link URL can be built; the value is handed to a single hook
   `onEditToken(slugOrId, token)` (no-op until #23). It must never appear in `history.state`, in copied
   links, or in a later `location.href`.
7. **Pinned revision** `d/<ID>@<HASH>`: loads `GET /paste/<ID>/revisions/<HASH>` (never `GET /paste/<ID>`),
   renders read-only (capability `viewer`, no polling, no autosave, no comments UI, no Edit), and shows
   `pinned-revision-banner` "You're viewing a version from <local date-time>" with
   `pinned-revision-latest-link` → `d/<ID>`. 404 → `doc-not-found`; 410 → `doc-not-found` with text
   containing "no longer stored".
8. **File route** `d/<ID>/<FILE>`: fetches `GET /paste/<ID>/files/<encodeURIComponent-per-segment FILE>`;
   `.md/.markdown/.txt` render as markdown and `.html/.htm` in the HTML iframe, both read-only; images are
   shown in an `<img>`; anything else shows a download link. 404 → `doc-not-found`. (#26 adds tabs/breadcrumb.)
9. **Landing + restored draft.** At the landing route with no redirect fragment and no `filePath`:
   if the persisted draft belongs to a shared doc **and is dirty** (unsaved edits), `replaceState` to
   `d/<pasteId>` (recovers the edits as today). A clean shared draft does not redirect (the landing page
   shows). A never-shared local draft is shown at the landing route as today. `usePersistence` must no
   longer write `#shared=`.
10. **Doc not found.** `d/<ID>` answering 404/410 with no local copy of that doc shows `doc-not-found`
    ("This document doesn't exist or has expired") with a link home — never the upload screen. With a
    local copy, the existing "Showing your local copy" notice behaviour is kept.
11. **In-app navigation** uses `pushState` and never reloads the page: library row/card → `d/<slug||id>`;
    New → landing; after a share is created the URL is `replaceState`d to `d/<slug||id>` (prefer `slug`).
    Share-dialog links and copied links prefer the slug when the payload has one, else the id.
12. **Links inside a markdown doc** (click handler on the reader; plain left click without modifiers only —
    modified/middle clicks keep browser default):
    - `href="#id"`: if an element with that id exists in the doc, `preventDefault`, `pushState` to the same
      path + current query + `#<encodeURIComponent(id)>`, then scroll the target into view (instant when
      `prefers-reduced-motion: reduce`, else smooth), honouring the sticky-header offset (#3/#5).
      Unknown id → nothing happens (no URL change). `href="#"` → scroll to top, URL fragment removed (push).
    - An absolute or root-relative URL that resolves to this app's origin+base and a doc route (same doc
      with a fragment, another doc, library) → SPA navigation with `pushState`, no reload.
    - Everything else (external URLs, `mailto:`) → unchanged browser behaviour.
13. **Back/Forward** (`popstate`): same doc, different fragment → scroll to that anchor, **no reload, no
    refetch-and-rerender, local edits untouched**. Different doc → load it (shared dirty doc: flush autosave
    first; if it cannot be saved, `confirm()`; on cancel `pushState` the previous URL back). Library ↔ doc
    work in both directions. The `hashchange` listener is removed; manual fragment edits in the address bar
    are handled as rule 13 same-doc navigation.
14. **Initial fragment.** On load of `d/<ID>#<id>`, after the doc renders, the target heading is scrolled to
    the top of the reading area (below the sticky header). If layout shifts afterwards (mermaid, images) and
    the reader has not scrolled, re-align once after those finish (≤ 3 s after load). Missing id → stay at
    top, no error, fragment kept.
15. **HTML docs (iframe).** Parent → frame: after each iframe `load`, if the URL has a fragment, post
    `{__mdreview:true, type:'anchor', id}`; the bridge scrolls to `getElementById(id)` or first
    `[name=id]`. Frame → parent: when the bridge handles an in-frame `#anchor` click it also posts
    `{__mdreview:true, type:'anchor-changed', id}`; the parent accepts it only from that iframe's
    `contentWindow`, only if `id` is a string of 1–256 chars, and updates the URL fragment with
    **`replaceState`** (HTML docs add no history entries for anchors). `href="#"` inside the frame clears
    the fragment.
16. **`?embed=1`**: read view only; no app header, TOC, banners, comments, or notices; content plus a small
    `embed-open-link` ("Open in md-review") linking to the same URL without `embed` (target `_blank`).
17. **Share URLs** (00 §6 is canonical). FE share links: `<origin><BASE_URL>d/<slug||id>`. MCP `create_session`/`get_session`
    `shareUrl` and the `create_via_shell` instruction, and CLI output: `<frontendUrl>/d/<slug||id>`
    (one slash between, trailing slash on `frontendUrl` tolerated). After #22, server-built links follow 00 §6
    (`share_url` only when `PUBLIC_BASE_URL` is explicitly set).
18. **GitHub Pages fallback.** `npm run build` emits `dist/404.html` byte-identical to `dist/index.html`;
    asset URLs are absolute under the base so the app boots from any depth. `index.html` `<title>` is
    `md-review` (see #5).
19. **Dev loader.** `/?filePath=<abs path>` keeps working exactly as today (landing route, local doc).

## Acceptance criteria
AC-04.1 Given a shared doc with slug `weekly`, When `/d/weekly` is opened in a fresh context Then the doc renders, `location.pathname` ends with `/d/weekly` and `location.hash` is empty.   [verify: e2e]
AC-04.2 Given `/#shared=<id>` (and `/?view=read#shared=<slug>`) When opened Then the URL becomes `/d/<id>` (resp. `/d/<slug>?view=read`), `history.length` did not grow, and the doc renders.   [verify: e2e]
AC-04.3 Given `/#dashboard` When opened Then the URL is `/library?mode=review` and the library/dashboard view renders.   [verify: e2e]
AC-04.4 Given a doc with `## Intro` and a link `[go](#intro)` When the link is clicked Then the URL is `/d/<slug>#intro`, the doc is still rendered, the `Intro` heading top is within 0–48px below the header bottom, and `history.length` grew by 1.   [verify: e2e]
AC-04.5 Given AC-04.4 done When the page is reloaded Then the same doc renders and is scrolled to `Intro`.   [verify: e2e]
AC-04.6 Given AC-04.4 done When Back is pressed Then the URL is `/d/<slug>` with no fragment, the doc is still rendered, and a `window.__probe` value set before the click still exists (no reload).   [verify: e2e]
AC-04.7 Given an editor typed text in edit view and switched back to read view (autosave blocked by a stalled API) When an in-doc anchor is clicked, then Back and Forward are pressed Then the rendered doc still contains the typed text and no reload occurred.   [verify: e2e]
AC-04.8 Given the share is still loading (API delayed 2 s) When the user changes the fragment to `#intro` Then the doc still finishes loading and renders.   [verify: e2e]
AC-04.9 Given `/library` When a doc row is clicked and then Back is pressed Then the URL goes `/d/<slug||id>` → `/library`, both views render, and no full reload happened (`__probe` survives).   [verify: e2e]
AC-04.10 Given `/d/does-not-exist` (404) in a fresh context Then `doc-not-found` is visible and no upload drop zone is shown; `/nope/x` shows `not-found`.   [verify: e2e]
AC-04.11 Given `/d/<id>?edit=tok123` When loaded Then within the first render `location.search` has no `edit`, `history.state` serialised contains no `tok123`, and the share/copy-link URLs contain no `tok123`.   [verify: e2e]
AC-04.12 Given a viewer opens `/d/<id>?view=edit` (and `?view=bogus`) Then the read view renders and the URL query reads `view=read`. (Before #23 the viewer is a pinned revision: `/d/<id>@<hash>?view=edit`; 00 §1.2.)   [verify: e2e]
AC-04.13 Given an HTML doc with `<h2 id="part-2">` far down When `/d/<id>#part-2` is opened Then inside the iframe `part-2` is scrolled into view; When an in-frame link `href="#part-1"` is clicked Then the parent URL fragment becomes `#part-1` and `history.length` is unchanged.   [verify: e2e]
AC-04.14 Given an iframe document that posts `{__mdreview:true,type:'anchor-changed',id:'x'.repeat(300)}` and another window posting a valid message Then the parent URL fragment is unchanged in both cases.   [verify: e2e]
AC-04.15 Given a revision hash H of an older version When `/d/<id>@H` is opened Then that version's text renders, `pinned-revision-banner` is visible, `view-toggle-edit` and the comments sidebar are absent, and clicking `pinned-revision-latest-link` shows the current text at `/d/<id>`.   [verify: e2e]
AC-04.16 Given MCP `create_session` Then `shareUrl` equals `<FRONTEND_URL>/d/<slug||id>` and contains no `#`; the CLI prints the same form.   [verify: server]
AC-04.17 Given `GITHUB_PAGES=true npm run build` Then `dist/404.html` exists, equals `dist/index.html`, and every script/link src in it starts with `/md-review/`.   [verify: unit]
AC-04.18 Given `/?filePath=<fixture>` Then the fixture renders as today and the path stays `/`.   [verify: e2e]
AC-04.19 Given a doc linking to another doc as `<origin>/<base>d/other` When clicked Then `/d/other` renders without reload; Back returns to the first doc.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `not-found`, `doc-not-found`, `pinned-revision-banner`, `pinned-revision-latest-link`, `embed-open-link`.
Bridge messages: parent→frame `{__mdreview:true,type:'anchor',id}`; frame→parent `{__mdreview:true,type:'anchor-changed',id}`.
MCP: `shareUrl` format change only (`create_session`, `get_session`, `create_via_shell` instruction text). CLI `url` same.
Build: `dist/404.html`. No server route changes.

## Edge cases the adversarial verifier must try
- Heading ids that look like legacy routes: `#shared=abc`, `#dashboard`, `#github=x` on `/d/<id>`.
- Unicode fragment (`#über-café`) typed raw and percent-encoded; fragment with `%` that is not valid encoding (no crash).
- `/d/<id>/` trailing slash; `/d/<id>@` + 31-hex hash (→ not-found); slug containing only digits.
- Rapid Back/Forward across 3 docs while one is still loading — the last URL's doc wins.
- Middle-click / Cmd-click a TOC or in-doc link → new tab opens the full `/d/<id>#x` URL.
- Offline: `/d/<id>` with server down and a persisted copy → local copy + notice; without → `doc-not-found` is NOT shown (it is a network error: show the existing "Cannot reach the review server" notice).
- An HTML doc whose script `postMessage`s spoofed `anchor-changed` floods (100/s) — URL updates stay bounded, no history growth.
- `#github=` with an invalid URL; legacy link with both `?filePath=` and `#shared=` (filePath is dropped).

## Dependencies on other items (by number) and files likely touched
Consumes #3 (heading ids, scroll offset), #2 (capability for `?view` gating), #23 (`onEditToken`), #26 (library
page), #22 (may later host `/d/:slug` server-side; FE URLs stay identical). First item of the build (no FE deps):
it works with today's heading ids and #3 swaps the slugger later. Existing e2e tests that assert
`location.hash.startsWith('#shared=')` (`tests/e2e/qa-gate-features.test.mjs:217`) must be updated (00 §11).
Files: `src/App.vue`, new `src/composables/useRouter.ts` (or vue-router), `src/composables/useShare.ts`,
`src/composables/usePersistence.ts`, `src/components/DashboardView.vue`, `src/components/PreviewPane.vue` (bridge),
`src/components/ShareModal.vue`, `server/mcp-server.js`, `server/cli.mjs`, `vite.config.ts` (404.html), `index.html`.

## Decisions
- View changes use `replaceState`; anchors use `pushState` (markdown) — Back should step through sections, not toggles.
- HTML-doc anchors use `replaceState`: the parent cannot restore iframe scroll reliably on popstate.
- Clean shared drafts no longer auto-redirect from `/`: readers visiting `/` to create a doc should see the landing page; only unsaved work is worth hijacking the landing for.
- Offline is not "not found": only a definitive 404/410 shows `doc-not-found`.
- Heading-link compatibility with old hash URLs is unnecessary: heading links never survived hash routing.
