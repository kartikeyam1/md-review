# 00 — Cross-cutting contract (read this before any item spec)

Specs 01–29 were written in parallel. This file is the single source of truth for everything more than one item touches.
**Where an item spec and this file disagree, this file wins.** Item specs point here with "See 00 §x". Build order and
lanes are in `docs/build/BUILD-ORDER.md`.

## §1 View × mode × capability

### §1.1 Axes (from #2 rule 1)
- **View** — `read | edit | split | slides | agent`, from `?view=` (#4). The canonical read URL has **no** `view` param;
  `view=read` is accepted.
- **Mode** — per doc, `publish | review` (#2). Publish hides all review UI for everyone (#2 rule 6).
- **Capability** — `viewer | editor`. All UI reads one computed value from `useDocState` (§4.1); nothing else decides it.

### §1.2 Capability sources
| Situation | Capability |
|---|---|
| Local, never-shared doc (file picker, drop, paste, `#github=`, `?filePath=`) | editor |
| Shared doc **before #23 lands** | editor (every shared doc is link-editable) |
| Shared doc after #23: legacy session (no `edit_token_hash`) | editor |
| Shared doc after #23: protected doc | editor iff a valid token is held (`access.can_edit` from the latest GET), else viewer |
| Pinned revision `/d/:x@:rev`, or `?embed=1` | viewer, whatever the doc's capability |
| File route `/d/:x/:file` | the doc's capability. Only the read view exists there (§1.3). Editors keep file add/remove (#26) |

**Before #23.** The only viewers are pinned revisions and embeds. A viewer AC in #2/#4/#6/#7/#13/#19 that runs before #23
uses `/d/<id>@<hash>` as its viewer. After #23 the same ACs must also pass for a protected doc opened without a token.

### §1.3 View resolution (one rule; owner #4, extended by #7/#28/#29)
| Requested `view` | Allowed when | Otherwise |
|---|---|---|
| absent / `read` | always | — |
| `edit`, `split` | capability editor, and not pinned/file/embed | render read and `replaceState` to `view=read` |
| `agent` | markdown doc, and not a file route | render read and `replaceState` to `view=read` |
| `slides` | markdown doc, and not a file route | render read and `replaceState` to `view=read` |
| anything else (incl. `AGENT`) | — | render read and `replaceState` to `view=read` |

- A view whose item has not shipped yet renders read **without** rewriting the URL (#4 rule 5).
- `?embed=1` forces the read view. Its `view` param is ignored and not rewritten.
- Every UI-driven view change uses `history.replaceState`. That covers the view toggle, `agent-sections-show`,
  `slides-enter-btn` and the exits. View changes never add history entries; only anchors (#4 rule 12) and route
  changes do.
- Exiting agent view (`agent-view-exit`) or slides (`slides-exit`/Esc) **removes** the `view` param.

### §1.4 Mode defaults (one table; owner #2, storage #20)
| Creation path | Stored mode |
|---|---|
| `POST /paste` without `mode` | `publish`, or `review` when `callback_url` is present |
| `PUT /paste/by-key/:key` create (#21) | body `mode`, else as `POST /paste` |
| `POST /templates/:id/instantiate` / MCP `create_from_template` (#27) | the template's `mode` |
| MCP `create_session` / `create_via_shell` without `mode` | `publish` |
| Stored session with no / invalid `mode` (legacy JSON) | reported as `review`, computed on read (#2) |
| #20 migration script | writes the stored value if valid, else `review` |
| Local doc: file picker, drop, paste, `#github=` | `publish` |
| Local doc: dev `?filePath=` loader, or a restored draft with no stored mode | `review` |

### §1.5 What each combination shows
#2 rule 5's table is normative for review UI. Placement in the header follows §2.

## §2 Canonical header and page chrome

### §2.1 Header element
One component family renders the header: `<header class="header" data-testid="doc-header" data-variant="reader|editor">`.
- `reader` = read, agent and slides entry.
- `editor` = edit and split views.
- The header is absent on the landing page (which keeps its own `nav-library` link, #26), in `?embed=1`, in slides view,
  and in focus mode (#13).
- Height ≤ 56px. It never wraps and never overflows (#5 rule 6). Sticky in read view (#5 rule 2).

**`.btn-icon` rule.** `theme-toggle` must be the first element in the document with class `btn-icon`, because existing
e2e tests click `.btn-icon`. No header control before it in DOM order may carry that class.

### §2.2 Order, left → right (✓ in bar · ☰ in overflow menu · — absent)
| Control (testid) | Shown when | Desktop ≥1100 | Tablet 641–1099 | Phone <641 |
|---|---|---|---|---|
| `toc-toggle` (#3) | read view, TOC exists; on desktop only while the rail is collapsed | ✓ | ✓ | ✓ |
| `app-home-link` (#2) | always | ✓ | ✓ icon only | ☰ ("Home") |
| `nav-library` (#26/#2) | reader variant | ✓ | ✓ icon only | ☰ |
| `.filename` (rename), `.sync-indicator`, word/char counts | editor variant | ✓ | ✓ (counts hidden) | — |
| `save-state` | editor variant, state not idle/saved (#2) | ✓ | ✓ | ✓ (icon) |
| `doc-title` (flex 1, ellipsis) | reader variant | ✓ | ✓ | ✓ |
| `doc-updated`, `doc-local-badge`, `doc-mode-badge` (#2), `view-stats` (#25) | reader variant | ✓ after title | in `doc-meta-row` | in `doc-meta-row` |
| `reviewer-name` | review mode | ✓ | ☰ | ☰ |
| `view-toggle` group: `view-toggle-read`, `view-toggle-edit`, `view-toggle-split` (#7) | editors | ✓ text labels | ✓ text labels | ✓ icon-only, with `aria-label` |
| `slides-enter-btn` (#29) | reader variant, markdown, read/agent view | ✓ | ☰ | ☰ |
| `share-btn` (#2/#23) | editors, any shared or local doc | ✓ | ✓ | ☰ |
| `copy-link-btn` (#2) | shared doc | ✓ | ✓ icon only | ☰ |
| `download-menu-btn` (#19) | any doc | ✓ | ☰ as the "Download" group | ☰ as the "Download" group |
| `theme-toggle` (#1) | always | ✓ | ✓ | ✓ |
| `theme-style-menu` (#1) | always | ✓ | ✓ | ✓ |
| `reader-settings-btn` (#18) | doc open | ✓ | ✓ | ☰ (opens the panel as a sheet) |
| `header-overflow-btn` | always | ✓ | ✓ | ✓ |

- `focus-mode-btn` is **not** a header control. It lives in the editor toolbar (§3.3).
- A control shown in the overflow menu keeps **the same testid**. It is never in the bar and the menu at once.
- Below 1100px the meta items render in `doc-meta-row`, a slim row under the bar. This widens #5 rule 6, which had it on
  phone only.

### §2.3 Overflow menu (`header-overflow-menu`, an AppMenu §3.2) — fixed order, items only when applicable
1. Items demoted at the current width, in §2.2 order: `reviewer-name`, `slides-enter-btn`, `share-btn`,
   `copy-link-btn`, the Download group (`download-md`, `download-html`, `download-pdf` | `download-html-source`),
   `reader-settings-btn`, `nav-library`, `app-home-link`.
2. `menu-history` (shared docs).
3. `menu-generate-prompt` (review mode).
4. The "Document mode" group, for editors: `doc-mode-publish`, `doc-mode-review`, `doc-mode-hidden-comments`.
5. `doc-save-as-template` (#27; not on file routes or pinned revisions).
6. `menu-open-file`, `menu-new-doc`, `menu-refresh` (dev `filePath` only).

On phone the menu opens as a full-width sheet (#5 rule 7).

### §2.4 Below-header stack, top → bottom
1. `doc-meta-row` (<1100px)
2. `pinned-revision-banner` (#4)
3. `agent-view-banner` (#28)
4. `conflict-bar`, `persist-error`
5. notice bar
6. `.approval-banner`, `.summary-panel` (review mode)
7. `changes-banner`
8. `doc-breadcrumb`, then `file-tabs` (#26)

Then the body: `toc-panel` rail (#3) | content column | comments sidebar (review mode, ≥1100px). The content column runs
`agent-sections-notice` (#28) → rendered doc → `reaction-bar` (#24).

`?embed=1` shows only the content and `embed-open-link`.

### §2.5 Markdown heading anatomy (read view)
`<hN id>` then, in order:
1. `heading-fold-toggle` (#17, top-level H1–H4)
2. the heading text, including any `rag-badge`
3. `heading-fold-ellipsis` (folded only)
4. `section-reaction-chip`* (#24, h2/h3)
5. `section-reaction-trigger` (#24, h2/h3)
6. `heading-anchor` (#3)

`</hN>`.

Every control is `user-select: none` and contributes nothing to heading ids, TOC text, `docTitle` or copied text.
Those are always derived from markdown **tokens**, never from DOM `textContent` (§5).

## §3 Shared components and interaction rules

### §3.1 `AppToast` — `src/components/AppToast.vue` + `src/composables/useToast.ts`
Built by **#2**, its first consumer. The contract was originally #10 rule 15.
- Fixed bottom-centre stack; max 3 visible, newest at the bottom. Each toast is `data-testid="app-toast"`
  `data-kind="info|success|error"`, plus an optional `data-toast="<key>"` when an AC must target one toast.
- Role: `role="status"` for info/success, `role="alert"` for error.
- Auto-dismiss after 4 s (info/success) or 8 s (error); close button `app-toast-close`.
- API: `toast.info|success|error(text, {key?, action?: {label, href|onClick}})`.
- Registered `data-toast` keys: `view-only` (#23), `reaction-failed` (#24).
- Every user-facing transient message in 01–29 uses it: "Link copied" (#2/#3), mode-change failure (#2), upload and
  paste toasts (#10/#11), "Download failed" (#19), "This link is view-only" (#23), reaction failure (#24), library and
  file toasts (#26), template toasts (#27).
- Exception: #14's in-button "Copied" / "Copy failed" state is not a toast.
- No new code path may call `alert()`.

### §3.2 `AppMenu` — `src/components/AppMenu.vue` + `useMenu.ts`
Built by **#2**, for the overflow menu. Reused by #1 (Style menu), #19 (download menu), #26 (collection menu) and
#27 (template menu).
- Trigger: `<button aria-haspopup="menu" aria-expanded>`.
- List: `role="menu"`; items `menuitem` or `menuitemradio`, with roving `tabindex`.
- Keyboard model (from #1 rule 6, now shared):
  - Enter, Space or ArrowDown on the trigger opens the menu and focuses the checked (or first) item; ArrowUp opens it
    on the last item.
  - In the menu: arrows move with wrap; Home/End jump; Enter/Space select.
  - Esc closes and returns focus to the trigger. Tab closes. An outside click closes.
- Placement: right-aligned under the trigger and fully inside the viewport. Opaque `--bg-surface`, 1px `--border`,
  radius 8px.

### §3.3 `EditorToolbar` — `src/components/EditorToolbar.vue`
Built by **#8**. Part of the lazy editor chunk (#6).
- One `editor-toolbar` row (36px) at the top of the editor pane. In split view it sits inside `split-pane-editor`.
- Left → right: `editor-undo-btn`, `editor-redo-btn` (#8) | `editor-shortcuts-btn` (#9) | spacer | `focus-mode-btn` (#13).
- Titles include the platform shortcut. Clicking a button returns focus to the editor.
- No B/I/link formatting buttons (out of scope per #9). "Format table" stays keyboard/slash only (#11).
- Visible at all viewports and in focus mode. Absent while the editor chunk loads (`editor-loading`).

### §3.4 Esc layering (canonical; from #13 rule 9)
One Esc closes exactly one layer, innermost first, and is not propagated further:
1. zoom viewer (#15)
2. modal dialogs: share, history, prompt, `shortcuts-overlay`, `share-required-dialog`, `library-confirm-dialog`,
   `template-picker`, `template-save-dialog`
3. AppMenus and non-modal panels: `reader-settings-panel`, `readers-panel`, `reaction-picker`
4. `toc-drawer`, `comments-drawer`
5. comment popover and selection action bar
6. `slash-menu` (#12)
7. CodeMirror search panel
8. CodeMirror multi-selection simplify
9. browser fullscreen
10. focus mode exit (#13), or slides exit (#29)

Modals and drawers trap focus using `src/composables/useFocusTrap.ts`, built by #3 (first drawer) and reused by later
dialogs.

### §3.5 Global keyboard shortcuts
Registered through `src/composables/useGlobalShortcuts.ts` (built by #2, which moves App.vue's Mod+S into it).
| Keys | Active where | Owner |
|---|---|---|
| Mod+S | doc open, editor capability | existing |
| Mod+Z, Mod+Shift+Z, Mod+Y (Ctrl+Y) | editor focused | #8 |
| Mod+B/I/K/E, Mod+Shift+X, Enter, Backspace, Tab/Shift+Tab, Alt+↑/↓, Shift+Alt+↑/↓, Mod+/ | editor focused, markdown | #9 |
| Shift+Alt+F; Ctrl/Cmd+Shift+V (paste chord) | editor focused | #11 |
| `/` typed | editor, markdown | #12 |
| Mod+Shift+Enter | edit/split views, any focus | #13 |
| `?` | edit/split views, focus not in an editable element | #9 (**not** in read/slides views) |
| `+ - 0 arrows Esc Tab` | zoom viewer open (swallows everything else) | #15 |
| `→ ← ↑ ↓ Space PageUp/Down Enter Backspace Home End F N Esc` | slides view only | #29 |

### §3.6 Undo contract (the #8 rules apply everywhere)
| Edit | Undo steps |
|---|---|
| Typing | grouped at 500 ms |
| Paste, SVG paste, image paste incl. placeholder→final (#10), each markdown shortcut (#9), revision restore | 1 step each |
| Pasted table (#11) | 2 steps: undo 1 → the raw pasted text, undo 2 → before the paste |
| Slash insert (#12) | 1 step: undo → `/query` as typed, menu closed |
| Remote update | not in history; clears history (#8 rule 4e) |

### §3.7 Stacking order (z-index)
TOC rail 90 · header 100 · AppMenus/panels/slash menu 200 · drawers + backdrops 300 · slides root 350 ·
modal dialogs 400 · zoom viewer 500 · toasts 600.

## §4 Architecture seams (keep hot files cold)
These are binding. Without them App.vue, PreviewPane.vue, EditorPane.vue, useMarkdown.ts and server.cjs serialise the
whole build.

1. **`src/composables/useDocState.ts`** (#2). The only place that computes `view`, `mode`, `capability`, `contentType`,
   `isShared` and `routeKind` (`doc|pinned|file|embed`). #4 supplies the parsed route; #23 swaps the capability source;
   #7/#28/#29 add views.
2. **`src/components/DocView.vue`** (#2) holds the doc layout. `App.vue` becomes a router shell: landing, library, doc,
   not-found.
3. **Header controls are one component each.** #2 builds `DocHeader.vue` (both variants), `HeaderOverflowMenu.vue` and
   `ViewToggle.vue`. Later items add their own file and insert one line: `ThemeSwitcher.vue` (#1), `ReaderSettings.vue`
   (#18), `DownloadMenu.vue` (#19), `ViewStats.vue` (#25).
4. **Markdown plugins** live in `src/markdown/<name>.ts`, one per feature, registered in one list in `useMarkdown.ts`.
   #5 creates the directory with the table wrapper, autolink class and `plainText.ts`. Plugins: `headingIds` (#3),
   `codeBlock` (#14), `alerts` + `rag` (#16), `inlineToc` (#12), `agentSections` (#28), `slides` split (#29).
   Wrapper elements carry no `data-line-*`, except where they replace a token that had one (the #16 callout carries its
   blockquote's range).
5. **Preview enhancers** live in `src/preview/<name>.ts`. Each is a function `(container, ctx) => cleanup` that runs
   after every render via one `runEnhancers` call in PreviewPane. #3 creates the pipeline with `headingAnchors`. Others:
   `codeCopy` (#14), `zoom` (#15), `folding` (#17), `sectionReactions` (#24). Enhancers use event delegation on the
   container.
6. **Preview CSS** lives in `src/styles/preview.css`: non-scoped, every selector under `.preview-pane`. #1 extracts it,
   as a no-visual-change refactor commit first. #18 converts it to em; #19 inlines it via `?inline`.
7. **Editor extensions** live in `src/editor/<name>.ts`, assembled by `src/editor/extensions.ts`, which #8 creates:
   `history` (#8), `markdownCommands` (#9), `imagePaste` (#10), `tablePaste` (#11), `slashMenu` (#12). The paste handler
   order is plain-text chord → image → SVG text → table → default. No module statically reachable from `src/main.ts`
   may import `@codemirror/*` (#6).
8. **FE + server pure modules** live in `shared/<name>.mjs`: ESM, no dependencies. The server loads them with
   `require()` (Node 26 `require(esm)`); the FE imports them through a Vite alias. First user: `shared/agentSections.mjs`
   (#28).
9. **Server** (#20): `server/db.cjs` plus `server/routes/<area>.cjs`, registered from one ordered table in `server.cjs`.
   Later server items add a module and one table line: `meta.cjs` (#22), `edit-tokens.cjs` (#23), `by-key.cjs` (#21),
   `reactions.cjs` (#24), `views.cjs` (#25), `library.cjs` (#26), `templates.cjs` (#27), `raw.cjs` (#28).
   MCP tools follow the same idea: one handler per tool in `createHandlers`, registered in both servers.

## §5 Doc title and derived text (one rule; FE `useDocTitle.ts` owner #5, server owner #22, used by #2/#19/#26/#27)
`docTitle` = the first non-empty value of:
1. `sessionName` (trimmed).
2. Markdown: front-matter `title:` (surrounding quotes stripped). HTML: the `<title>` text (parsed, never executed).
3. Markdown: the plain text of the first **human-visible** H1 (#28 human view; plain text per #3 rule 2). HTML: the first
   `<h1>` text.
4. The filename without a trailing `.md|.markdown|.txt|.html|.htm`.
5. `Untitled`.

Whitespace is collapsed. Consumers truncate: `document.title` and `doc-title` at 80 characters plus `…` (#5); meta tags
and the cover at 200 (#22); library rows by CSS ellipsis. This **replaces** the orderings in #5 rule 17 (H1 before
sessionName), #22 rule 3 and #26 rule 4. The server version (#22/#26, which has no markdown-it) may be line-based: front
matter, then the first ATX `# ` line outside fences and agent sections, with inline markdown stripped.

**Human view versus full text.**
- Display derivations use the human view (#28 stripped source): `docTitle`, #22 description and cover, TOC, slides, the
  #19 `.md` download in human view.
- The full source is used for the search index (§8), default raw/MCP reads, and heading-id and line numbering (#28 rule 8).

## §6 URLs
- **FE-built links** use the origin the user is on: copy-link, heading copy-link, share-dialog links, the recent list.
  Form: `location.origin + BASE_URL + "d/" + (slug || id)`. The edit link appends `?edit=<token>`. They never include
  `view`, a fragment (except heading copy-link) or other params.
- **Server-built links** in REST, MCP and CLI responses, with `x` = slug if set, else id:
  - `app_url(x)` = `FRONTEND_URL/d/x`.
  - `share_url(x)` = `PUBLIC_BASE_URL/d/x` (#22).
  - The handed-out `url`, `viewUrl` and MCP `shareUrl` = `share_url(x)` **only when `PUBLIC_BASE_URL` is explicitly set
    in the environment**, otherwise `app_url(x)`. Before #22 they are always `app_url(x)` (#4 rule 17, AC-04.16).
  - `editUrl` = `app_url(x) + "?edit=" + token`, always.
- **Reserved slugs**: `list` and `by-key` are never assigned (a `-2` suffix is applied), because they collide with
  `/paste/list` and `/paste/by-key/:key`.
- **Server `/d/` route precedence** (#22/#28), all matched before the hosted-site asset fallback:
  `/d/:x.md` → `/d/:x/cover.png` → `/d/:x@:rev` → `/d/:x/:file…` → `/d/:x`. A session file named exactly `cover.png`
  at top level has no server meta page; its SPA route still works.

## §7 Reader identity (one definition; module `src/composables/useReader.ts`, built by the first of #24/#25/#26 — planned #24)
- **`reader_id`** — `anon-` + `crypto.randomUUID()`, created once per browser in localStorage `md-review-reader-id`
  (try/catch; in-memory fallback for the page lifetime). Server validation: `^[A-Za-z0-9_-]{8,64}$`.
- **`reader_name`** — the existing self-declared reviewer name (localStorage `md-review-reviewer`, `useReviewer.ts`),
  trimmed, ≤ 80 characters. Empty means anonymous.
- **`reader_key`** — used for server-side per-person state, i.e. pins (#26). It is `name:` + lower-cased `reader_name`
  when a name is set, else `reader_id`.
  - Sent as header `X-MdReview-Reader: encodeURIComponent(reader_key)`. Headers must be ISO-8859-1, so this works for
    non-ASCII names.
  - The server decodes it and validates `^(name:.{1,80}|[A-Za-z0-9_-]{8,64})$`, else 400.
- **What keys on what**:
  - Reactions (#24) and views (#25) send `reader_id` plus `name` in the body; a toggle is per browser.
  - Pins (#26) use `reader_key`. When a name is first set, the FE calls `POST /library/pins/merge {from: <reader_id>}`.
  - The recent list (#26) is local only.
- This is not authentication: names are self-declared (DECISIONS).

## §8 Library / search API (one endpoint; implemented by #20, extended by #24/#25/#26)
There is **no** `GET /search`. `GET /library/docs` is the only list and search endpoint for docs. MCP `list_sessions`
keeps using the unchanged `GET /paste/list`.

**Request.** `GET /library/docs?q=&collection=&tag=&mode=&type=&updated_after=&sort=&cursor=&limit=`, with optional
header `X-MdReview-Reader` (§7), which affects `pinned` only.
- `q` — trimmed. Empty means list mode. Non-empty means FTS:
  - each user token is quoted and prefix-matched (`"tok"*`), and tokens are ANDed;
  - FTS syntax in `q` (`" * : ( ) - ^ NEAR AND OR`) never causes a 4xx/5xx;
  - ranking is `bm25(doc_fts, 10, 5, 1)` (title > filename > content);
  - a session and its document files collapse into one item: the best-ranked row wins and decides `match`.
- `collection` (id | slug | `none`), `tag` (case-insensitive), `mode` (`publish|review`), `type` (`md|html`) and
  `updated_after` (ISO) combine with AND. An unknown collection or tag gives `items: []`, not an error.
- `sort` — `updated` (default without `q`), `created`, `title` (case-insensitive A→Z), `views`, `relevance` (default
  with `q`).
  - `relevance` without `q`, or `views` while view counts are unavailable, falls back to `updated`.
  - Any other value → 400 `{error:'invalid sort'}`.
- `limit` — 1–100, default 50.
- `cursor` — opaque. A cursor reused with different filters → 400 `{error:'invalid cursor'}`.
- Expired sessions are excluded; deleted sessions never appear.

**Response 200.**
```
{ query: string|null, total: number, next_cursor: string|null,
  items: [{ id, slug, title /* §5 */, filename, contentType: 'markdown'|'html', mode, created_by: string|null,
            created_at, updated_at, collection: {id, name}|null, tags: string[], file_count,
            reaction_count: number|null /* null until #24 */, view_count: number|null /* null until #25 */,
            must_fix_unresolved: number, pinned: boolean /* false until #26 */,
            match: null | { field: 'title'|'filename'|'content'|'file', file: string|null,
                            snippet: [{ text: string, hit: boolean }] } }] }
```
- `match` is null in list mode.
- `snippet` is plain text segments (≤ ~32 tokens, `…` at cut edges) that concatenate to the excerpt; `hit` marks matched
  tokens. Clients render the segments as text (#26 AC-26.3).
- `total` = matching sessions before paging.

**Index.** `doc_fts(title, filename, content, session_id UNINDEXED, file_name UNINDEXED)`, with
`tokenize='unicode61 remove_diacritics 2'`, `prefix='2 3'`.
- One row per session with `file_name = ''`. Created by #20.
- One row per document file (`.md .markdown .html .htm .txt`). Added by #26.
- `content` = the **full** source, agent sections included (#28; search is discovery, not a privacy boundary). For HTML,
  tags, scripts and styles are stripped.
- Rows are kept in sync in the same transaction as every write.

## §9 CORS and shared headers (the full list is set once by #20)
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS` (PATCH is for #26/#27)
- `Access-Control-Allow-Headers: Content-Type, If-None-Match, If-Match, X-MdReview-Client, Authorization, X-Edit-Token, X-MdReview-Reader`
- `Access-Control-Expose-Headers: ETag, X-Agent-Sections`

Edit tokens (#23): `Authorization: Bearer <t>` or `X-Edit-Token: <t>`; if both are present and they disagree → 403.

## §10 Registries

### §10.1 data-testid registry
Each id is unique in the DOM at any moment, except ids marked * (one per item in a list). Owner = the item that creates
it; other items may only reference it.

| testid | owner | element |
|---|---|---|
| `theme-toggle` | 01 | light/dark toggle button, first `.btn-icon` in the document |
| `theme-style-menu` | 01 | Style trigger (AppMenu trigger, no `.btn-icon`) |
| `theme-style-menu-list` | 01 | `role=menu` list (only while open) |
| `theme-style-option`* | 01 | `menuitemradio` with `data-style=default|github|locus` |
| `doc-header` | 02 | header root, `data-variant=reader|editor` (§2.1) |
| `doc-title` | 02 | title text in the reader header (§5) |
| `doc-updated` | 02 | `<time>` "Updated … by …" |
| `doc-local-badge` | 02 | "Not shared" badge (local docs, editors) |
| `doc-mode-badge` | 02 | "Review" badge |
| `app-home-link` | 02 | logo/home link |
| `copy-link-btn` | 02 | copy doc link (header button or overflow item) |
| `share-btn` | 02 | opens `share-dialog` (editors) |
| `view-toggle` | 02 | `role=group` `aria-label="View"` segmented control |
| `view-toggle-read` | 02 | Read segment (`aria-pressed`) |
| `view-toggle-edit` | 02 | Edit segment (text "Edit") |
| `header-overflow-btn` | 02 | ☰ trigger |
| `header-overflow-menu` | 02 | overflow AppMenu (§2.3) |
| `menu-history` | 02 | opens revisions modal (replaces `history-button`) |
| `menu-generate-prompt` | 02 | prompt generator (review mode) |
| `menu-open-file` / `menu-new-doc` / `menu-refresh` | 02 | overflow items |
| `doc-mode-publish` / `doc-mode-review` | 02 | `menuitemradio` mode switch |
| `doc-mode-hidden-comments` | 02 | "N comments hidden in Publish mode" |
| `app-toast`* | 02 (§3.1) | toast, `data-kind`, optional `data-toast` |
| `app-toast-close`* | 02 (§3.1) | toast close button |
| `save-state`, `reviewer-name`, `reviewer-input`, `restore-revision`, `changes-banner`, `conflict-bar`, `persist-error`, `revisions-modal`, `view-changes`, `diff-stats`, `diff-table` | existing | unchanged |
| `toc-panel` | 03 | `<nav aria-label="Table of contents">` rail |
| `toc-link`* | 03 | TOC entry (`aria-current="location"` on the active one) |
| `toc-collapse-btn` | 03 | collapse the rail |
| `toc-toggle` | 03 | header button that opens the drawer or reopens the rail |
| `toc-drawer` / `toc-drawer-close` / `toc-backdrop` | 03 | drawer below 1100px |
| `heading-anchor`* | 03 | copy-link button in each heading |
| `not-found` | 04 | unknown route view |
| `doc-not-found` | 04 | 404/410 doc state |
| `pinned-revision-banner` / `pinned-revision-latest-link` | 04 | pinned revision banner and link to latest |
| `embed-open-link` | 04 | "Open in md-review" in `?embed=1` |
| `table-scroll`* | 05 | horizontal-scroll wrapper per table |
| `doc-meta-row` | 05 | meta row under the header below 1100px |
| `comments-toggle` / `comments-drawer` / `comments-drawer-close` | 05 | comments bottom sheet below 1100px |
| `editor-loading` / `editor-load-error` / `editor-load-retry` / `editor-load-reload` | 06 | lazy editor states |
| `view-toggle-split` | 07 | Split segment |
| `split-view` / `split-pane-editor` / `split-pane-preview` / `split-divider` / `split-sync-toggle` | 07 | split layout |
| `split-tabs` / `split-tab-edit` / `split-tab-preview` | 07 | narrow split tabs |
| `editor-toolbar` | 08 (§3.3) | editor toolbar row |
| `editor-undo-btn` / `editor-redo-btn` | 08 | toolbar undo/redo |
| `editor-shortcuts-btn` | 09 | toolbar button that opens the overlay |
| `shortcuts-overlay` / `shortcuts-row`* / `shortcuts-close-btn` | 09 | shortcuts dialog |
| `share-required-dialog` / `share-required-confirm` / `share-required-cancel` | 10 | "share to add images" dialog |
| `slash-menu` / `slash-menu-item`* / `slash-menu-empty` / `slash-menu-lang-input` / `slash-menu-lang-option`* | 12 | slash menu |
| `inline-toc` / `inline-toc-link`* | 12 | rendered `[[toc]]` |
| `focus-mode-btn` | 13 | toolbar toggle (§3.3) |
| `focus-controls` / `focus-save-state` / `focus-exit-btn` | 13 | floating focus cluster |
| `code-block`* / `code-toolbar`* / `code-lang-label`* / `code-copy-btn`* | 14 | code block wrapper and toolbar |
| `code-copy-status` | 14 | one polite live region per preview pane |
| `zoom-trigger`* | 15 | zoomable diagram/image (`data-zoomable`) |
| `zoom-viewer` / `zoom-content` / `zoom-toolbar` / `zoom-level` / `zoom-in-btn` / `zoom-out-btn` / `zoom-reset-btn` / `zoom-close-btn` / `zoom-copy-source` | 15 | viewer |
| `callout`* / `callout-title`* | 16 | GitHub alert (`data-callout`) |
| `rag-badge`* | 16 | RAG pill (`data-rag`) |
| `heading-fold-toggle`* / `heading-fold-ellipsis`* | 17 | fold controls in headings |
| `fold-collapse-all` / `fold-expand-all` | 17 | in the TOC panel or drawer header |
| `preview-pane` | 18 | the `.preview-pane` element (`data-reader-font-scale`, `data-reader-width`) |
| `reader-settings-btn` / `reader-settings-panel` / `font-decrease` / `font-increase` / `font-size-value` / `font-reset` / `width-narrow` / `width-wide` / `reader-settings-note` | 18 | reading settings |
| `download-menu-btn` / `download-menu` / `download-md` / `download-html` / `download-html-source` / `download-pdf` | 19 | downloads |
| `revision-note`* | 21 | note under a revisions-modal entry |
| `share-dialog` / `share-view-url` / `share-copy-view` / `share-edit-url` / `share-copy-edit` / `share-edit-warning` / `share-protect-btn` / `share-expiry-select` / `share-expiry-label` | 23 | share dialog |
| `reaction-bar` / `reaction-btn`* / `reaction-count`* / `reaction-who` | 24 | doc reactions |
| `section-reaction-trigger`* / `section-reaction-chip`* / `reaction-picker` / `reaction-picker-option`* | 24 | section reactions |
| `view-stats` / `readers-panel` / `reader-row`* / `reader-latest-badge`* / `reader-stale-badge`* / `readers-anonymous` / `readers-empty` | 25 | view counts |
| `nav-library` | 26 (rendered by 02 from day one) | link to `/library` |
| `library-page`, `library-search`, `library-filter-collection`, `library-filter-tag`, `library-filter-mode`, `library-filter-type`, `library-filter-updated`, `library-clear-filters`, `library-sort`, `library-count`, `library-filters-toggle`, `library-loading`, `library-empty` (`data-state`), `library-error`, `library-retry`, `library-new-doc`, `library-load-more` | 26 | library page controls |
| `library-row`* (`data-doc-id`), `library-row-snippet`*, `library-snippet-hit`*, `library-pin-toggle`*, `library-row-select`*, `library-row-tag-add`*, `library-tag-remove`*, `library-tag-error` | 26 | library rows |
| `library-pinned`, `library-recent`, `library-recent-item`*, `library-collections`, `library-collection-item`*, `library-collection-new`, `library-collection-menu`*, `library-collection-error` | 26 | library sections |
| `library-select-all`, `library-bulk-bar`, `library-bulk-tag`, `library-bulk-move`, `library-bulk-delete`, `library-confirm-dialog`, `library-confirm-ok`, `library-confirm-cancel` | 26 | bulk actions |
| `file-tabs`, `file-tab`*, `file-tab-remove`*, `file-add-btn`, `file-attachments-menu`, `file-attachment-item`*, `file-download-card`, `file-not-found` | 26 | multi-file sessions |
| `doc-breadcrumb`, `breadcrumb-library`, `breadcrumb-collection`, `breadcrumb-doc`, `breadcrumb-file` | 26 | breadcrumb |
| `landing-new-from-template`, `library-new-from-template`, `library-tab-templates` | 27 | template entry points |
| `template-picker`, `template-picker-item`*, `template-picker-filter`, `template-builtin-badge`*, `template-title-input`, `template-collection-select`, `template-author-input`, `template-preview`, `template-create-btn` | 27 | picker |
| `doc-save-as-template`, `template-save-dialog`, `template-save-name`, `template-save-description`, `template-save-collection`, `template-save-mode`, `template-save-title-var`, `template-save-error`, `template-save-replace` | 27 | save as template |
| `template-item`*, `template-use`*, `template-menu`*, `template-delete-confirm` | 27 | Templates tab |
| `agent-section`*, `agent-section-label`*, `agent-sections-notice`, `agent-sections-show`, `agent-view-banner`, `agent-view-exit`, `agent-raw-link` | 28 | agent view |
| `slides-enter-btn`, `slides-root`, `slides-slide`* (`data-slide-index`, `data-slide-kind`), `slides-canvas`, `slides-counter`, `slides-progress`, `slides-prev`, `slides-next`, `slides-fullscreen-btn`, `slides-notes-btn`, `slides-notes`, `slides-exit`, `slides-rotate-hint` | 29 | slides |

**Retired.**
- `history-button` → `menu-history`.
- `toast-view-only` → `app-toast[data-toast="view-only"]`.
- `toast-reaction-failed` → `app-toast[data-toast="reaction-failed"]`.

### §10.2 Attribute hooks
- `.app` root:
  - `data-view` (`read|edit|split|slides|agent`, #2/#7/#28/#29)
  - `data-mode` (#2)
  - `data-capability` (#2)
  - `data-focus-mode` (#13)

  Print rules for slides are scoped under `.app[data-view=slides]` (#29); #5's print rules exclude it.
- `<html>`: `data-theme-style` and the classes `dark` / `github-theme` / `locus-theme` (#1).

### §10.3 localStorage keys (all access in try/catch)
| Key | Owner |
|---|---|
| `md-review-theme` | existing / #1 |
| `md-review-reviewer` | existing |
| `md-review-toc-collapsed` | #3 |
| `md-review-split-ratio`, `md-review-split-sync` | #7 |
| `md-review-reader-prefs` | #18 |
| `md-review-fold:<docKey>` | #17 |
| `md-review-edit-tokens` | #23 |
| `md-review-reader-id` | §7 |
| `md-review-recent` | #26 |
| `md-review-slides-notes` (`"1"`/absent) | #29 |

### §10.4 iframe bridge messages
All messages are `{__mdreview:true, …}`, except the theme message:
- theme `{__mdreview_theme, __mdreview_style}` (#1)
- `anchor` (parent→frame) and `anchor-changed` (frame→parent) (#4)
- `scroll-ratio`, both directions (#7)
- existing selection and text `scroll` messages

The parent accepts only messages from its own iframe's `contentWindow`.

### §10.5 New server surface
| Kind | Items |
|---|---|
| Env | `DB_PATH`, `ALLOW_EMPTY_DB` (#20) · `FRONTEND_URL`, `PUBLIC_BASE_URL` (#22) · `MCP_TOKEN_STORE`, `MDREVIEW_EDIT_TOKEN` (#23) · `MDREVIEW_NOW` (#25, test clock) |
| Routes | `GET /library/docs` (#20; §8) · `GET /d/:x[@rev][/:file]`, `GET /d/:x/cover.png` (#22) · `POST /paste/:id/edit-token` (#23) · `PUT\|GET /paste/by-key/:key` (#21) · `POST\|GET /paste/:id/reactions` (#24) · `POST\|GET /paste/:id/views` (#25) · `/library/*` and `PUT /paste/:id/tags\|collection` (#26) · `/templates*` (#27) · `GET /d/:x.md`, `GET /llms.txt` (#28) |
| MCP (new or changed) | `create_session` (`mode`, link fields, `editToken`) · `update_session_meta` (`mode`) · `get_session` (`mode`, `access`, `view`, `agentSections`, `rawUrl`) · `list_sessions` (`mode`) · `upsert_session` (#21) · `get_reactions` (#24) · `get_views` (#25) · `list_templates`, `create_from_template` (#27) · `editToken` argument on every write tool (#23) · `note` in `list_revisions` (#21) |

## §11 Existing tests that must change (collected from the specs; the harness agent owns `tests/e2e/*`)
| Test (file:line) | Changed by | Why / new expectation |
|---|---|---|
| `tests/composables/useTheme.test.ts:19-28` | #1 | `nextTheme`/`THEME_CYCLE` removed → AC-01.16 |
| `app.test.mjs:67-79` | #1 | second `.btn-icon` click returns to light |
| `app.test.mjs:1114-1166`, `1183-1206`, `1208-1235` | #1 | four-mode cycle → toggle + Style menu |
| `button:has-text("Preview")` (app 130,155; durable-sync 71,110,185; selection-preservation 73,109; table-highlight 40) | #2 | the toggle segment is "Read" → click `[data-testid=view-toggle-read]` |
| `button:has-text("Edit")` (app 24; durable-sync 39,63,200; selection-preservation 40) | #2, #6 | still matches the "Edit" segment; after #6, wait for `.cm-content` before typing |
| `app.test.mjs:267` "Generate Prompt" | #2 | open `header-overflow-btn`, then `menu-generate-prompt` (review mode only) |
| `app.test.mjs:371,382` "New" | #2 | `header-overflow-btn` → `menu-new-doc` |
| `durable-sync.test.mjs:302,322` `history-button` | #2 | `header-overflow-btn` → `menu-history` |
| `.filename` in read view (app 49,402,422; shared-mode 40) and `.sync-indicator` (shared-mode 44) | #2 | editor-header only → switch to edit view, or assert `doc-title` |
| sessions created by `POST /paste` that expect comment, approval or reviewer UI (shared-mode, durable-sync, qa-gate-features incl. `.reviewer-input` 97,174, approval/summary) | #2 | send `mode:"review"` (default is now publish) |
| `qa-gate-features.test.mjs:217` hash starts with `#shared=` | #4 | assert `location.pathname` ends `/d/<slug or id>` |
| `#shared=` gotos (durable-sync, qa-gate, shared-mode) | #4 | keep working through the legacy redirect; no change needed |
| `qa-gate-features.test.mjs:189-218` dashboard (`.dashboard-header h2` "Pending Reviews", `.session-card`) | #4, then #26 | #4: `/#dashboard` → `/library?mode=review`, which still renders DashboardView. #26: the session must be created with `mode:"review"`; assert `library-page` / `library-row` |
| selection and popover coordinate tests (app 496-579, selection-preservation, tripleclick) | #5 | read view uses document scroll; recheck coordinates (expected to pass) |
| any test relying on full-width preview text | #5 | the read column is capped at 50em (narrow default, #18 rule 4, implemented by #5 rule 4); a known visual change |
| `tests/composables/useMarkdown.test.ts` front-matter cases (~:56-73) | #5 | absolute line numbers: body blocks offset by the front-matter length |
| `app.test.mjs:869-875` h4/h5/h6 sizes, code-block tests `125-170` | #18, #14 | must pass unchanged (#18 rule 3 keeps 100% sizes; AC-14.8) |
| `server/test.mjs:535-567`, `731-750` (JSON-file pokes) | #20 | move to migration-script tests |
| server tests asserting `#shared=` share URLs (MCP/CLI) | #4 | `…/d/<slug or id>` |

## §12 Breakpoints and viewports
- Phone < 641px · tablet 641–1099px · desktop ≥ 1100px (#5). Use these everywhere.
  - #26's "≤ 600px" becomes < 641px.
  - #24's "≤ 820px" becomes `(hover: none)` or < 1100px.
- The single documented exception is split view (#7), which switches at viewport 960px.
- Verification viewports: 1400×900, 820×1180, 390×844.
