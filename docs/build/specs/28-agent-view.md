# 28 — Human view vs agent view of one doc

## Goal
One document serves two readers: humans get the concise narrative, agents get the full evidence. Authors (mostly AI agents via MCP)
wrap supporting material in agent-only markers; the default reader view hides it, `?view=agent` and raw/MCP endpoints expose it.

## Scope / Out of scope
In scope: marker syntax + parsing (FE and server), human/agent rendering, the "hidden sections" affordance, `?view=agent`,
raw markdown endpoints (`GET /d/:slug.md`, `GET /paste/:id/markdown?view=`), `view` on `GET /paste/:id`, MCP `get_session` `view` arg,
`/llms.txt`, TOC/downloads/print/in-page find respecting the view, `<link rel="alternate">` to the raw markdown.
Out of scope: access control (agent sections are **not secret** — anyone with the link can read the raw source), HTML docs,
raw endpoints for pinned revisions (`@rev`) and for files inside multi-file sessions, per-section placeholders in human view.

## Current state
- Markdown is rendered with raw HTML enabled (`src/composables/useMarkdown.ts:168` `html: true`), so `<!-- … -->` lines become
  `html_block` tokens that print as invisible comments; the content between two comment lines is parsed as ordinary markdown.
- Heading ids are assigned over the whole token stream with a dedupe counter (`useMarkdown.ts:70-91`); block tokens get
  `data-line-start/end` (`useMarkdown.ts:95-131`), used by comment highlights and scroll-to-line (`src/components/PreviewPane.vue:198-218,364-391`).
- `renderHtml` is a single code path with no view concept (`useMarkdown.ts:186-192`; consumed at `PreviewPane.vue:51`).
- `GET /paste/:id[/markdown|/comments]` is one handler (`server/server.cjs:1141-1219`); `/markdown` returns JSON `{filename, markdown}`;
  the ETag is content-hash + meta (`server.cjs:1164-1175`) — currently view-independent.
- MCP `get_session` takes `sessionId`, `fields` (`server/mcp-server.js:407-418`, `server/mcp-server-http.js:44-55`), handler at
  `mcp-server.js:119-124` returns a legacy `#shared=` URL.
- Slugs are `[a-z0-9-]` (`server.cjs:56-58`), ids hex, so a `.md` suffix is unambiguous. The root-level asset fallback
  (`server.cjs:1695+`) catches every other GET, so new routes must be matched before it.

## Behaviour
1. **Syntax (one primary form).** An agent-only section is opened by a line that is exactly `<!-- agent -->` or
   `<!-- agent: <label> -->` and closed by a line that is exactly `<!-- /agent -->`. Matching is case-insensitive, whitespace
   inside the comment is flexible (`<!--agent-->` works), up to 3 leading spaces and any trailing whitespace allowed. Regexes:
   open `^ {0,3}<!--\s*agent(?:\s*:\s*(.*?))?\s*-->\s*$`, close `^ {0,3}<!--\s*/agent\s*-->\s*$`.
2. Markers are recognised only at the document top level: not inside fenced/indented code blocks, lists, blockquotes, or front matter.
   A marker in those places is literal (inside code it is shown as text; elsewhere it is an invisible comment).
3. No nesting: an opener inside an open section is ignored; the first closer ends the section. A closer with no open section is ignored.
   An unclosed opener extends to the end of the document.
4. The label (if any) is plain text, HTML-escaped, max 80 chars (truncated with `…`).
5. The reserved marker pair `<!-- notes -->…<!-- /notes -->` belongs to #29 and is not an agent section.
6. **View resolution** (full table: 00 §1.3). For markdown docs the effective view is `agent` when the URL has `view=agent`, otherwise `read` (default, also with `?embed=1`) renders the human view. In `edit`/`split` the editor shows the full source and the preview shows agent sections (rule 9).
   `slides` excludes agent sections (#29). `agent-sections-show` and the rule-12 switch use `replaceState`; `agent-view-exit` removes `view`.
7. **Human view.** Agent sections and their markers produce **no DOM at all** (not `display:none`), so they are absent from in-page
   find, copy, print, word/reading-time counts, TOC (#3), collapsible-section outlines (#17) and comment highlights.
8. **Line fidelity.** Every rendered block keeps `data-line-start/end` equal to its line in the full source in every view; heading ids are
   computed over the full document in both views (a heading id never changes between human and agent view).
9. **Agent view / edit preview.** Each section renders as `<section class="agent-only" data-testid="agent-section" data-agent-index="i">`
   (i = 0-based source order) containing a label chip `agent-section-label` reading `Agent-only` or `Agent-only · <label>`, followed by
   the section's markdown rendered normally (tables, code, mermaid, callouts). Styling: dashed 2px left border in `--accent` and a
   subtly tinted background, visibly distinct in all six themes.
10. **Hidden affordance.** In human view, when N ≥ 1 sections exist, a single subtle line `agent-sections-notice` appears directly above
    the document body: `N agent-only section(s) hidden` (singular for 1) plus a `Show` button `agent-sections-show`. N = 0 → no element.
    Clicking Show changes the URL to include `view=agent` (other params and the fragment preserved, no reload) and renders agent view.
11. **Agent view banner.** In agent view a banner `agent-view-banner` reads `Agent view — showing N agent-only section(s)` with a
    `Reader view` button `agent-view-exit` (removes `view`, back to human view) and, for shared docs, a link `agent-raw-link` whose href is
    `<API>/d/<slugOrId>.md` (opens in a new tab).
12. **Deep links into hidden content.** If the URL fragment (or a TOC/comment scroll target) points at a heading/line inside an agent section
    while in human view, the app switches to `view=agent` via `history.replaceState` (fragment kept) and scrolls to it.
13. **Downloads (#19).** `.md` download in human view = human-stripped markdown (rule 15); in agent view/edit = full source. `.html`/PDF
    export what the current view renders. Filenames are unchanged.
14. **Head link.** For a shared markdown doc the SPA adds `<link rel="alternate" type="text/markdown" href="<API>/d/<slugOrId>.md">`
    to `<head>` (removed when leaving the doc). This item also adds the same tag to #22's server-rendered page, and switches
    #22's title/description extraction (and the server `docTitle`, 00 §5) to the human-stripped source (`shared/agentSections.mjs`).
    The FE `docTitle` (#5) likewise uses the first human-visible H1. Search (00 §8) keeps indexing the full source.
15. **Stripping (server + FE, identical algorithm).** Human markdown = source with every line from an opener through its closer
    (inclusive; to EOF if unclosed) removed, then any run of ≥ 2 consecutive blank lines created at a removal point collapsed to 1.
    Notes markers (#29) are kept. Front matter is untouched.
16. **`GET <API>/d/:slugOrId.md`** → 200, `Content-Type: text/markdown; charset=utf-8`, `Access-Control-Allow-Origin: *`,
    `Cache-Control: no-cache`, `X-Agent-Sections: <N>`, `ETag`. Body: stored source byte-for-byte (default and `?view=agent`) or the
    human-stripped text (`?view=human`). Any other `view` value → 400 `text/plain`. Unknown → 404, expired → 410 (both `text/plain`).
    HTML docs: body is the stored HTML source with `Content-Type: text/plain; charset=utf-8` (never served as `text/html` on the API
    origin); `view=human` is accepted but changes nothing; `X-Agent-Sections: 0`.
17. **`GET /paste/:id/markdown?view=human|agent`** keeps its JSON shape and adds `view` and `agentSections` fields. No param = `agent`
    (byte-identical `markdown` to today). **`GET /paste/:id?view=…`** (with or without `fields`) applies the same to the `markdown` field only.
18. **ETags are view-specific**: the human variant's ETag differs from the agent variant's (e.g. suffix `-h` inside the quotes), so an
    `If-None-Match` from one view never yields a 304 for the other.
19. **MCP `get_session`** gains `view: 'agent' | 'human'` (optional, default `agent`). Result adds `view`, `agentSections` and `rawUrl`
    (`<public API>/d/<slugOrId>.md`). `create_session`, `update_markdown` and `patch_markdown` descriptions mention the marker syntax
    (contain the literal `<!-- agent -->`).
20. **`GET <API>/llms.txt`** → 200 `text/plain; charset=utf-8`: a short static guide (H1 `# md-review`, how to fetch `/d/<slug>.md`,
    `?view=human`, the marker syntax, the MCP tools). It lists **no documents** (docs are unlisted; an index would enumerate them).
21. **HTML docs**: agent sections are not supported. `?view=agent` on an HTML doc behaves as `read`; no notice or banner is rendered.

## Acceptance criteria
AC-28.1 Given a doc with two agent sections (one labelled "Raw SQL") When opened at `/d/:slug` Then no `[data-testid=agent-section]` exists, text from inside the sections is absent from `document.body.innerText`, and `agent-sections-notice` reads `2 agent-only sections hidden`.   [verify: e2e]
AC-28.2 Given AC-28.1 When `agent-sections-show` is clicked Then the URL contains `view=agent`, the page did not reload, two `agent-section` elements render in source order, and the second's label reads `Agent-only · Raw SQL`.   [verify: e2e]
AC-28.3 Given a doc with no agent markers When opened in read view Then `agent-sections-notice` is absent; in `?view=agent` `agent-view-banner` reads `showing 0 agent-only sections`.   [verify: e2e]
AC-28.4 Given an agent section containing a table, a fenced code block with ``` and a mermaid diagram When viewed with `?view=agent` Then the table renders as `<table>`, the code as `<pre>`, and the mermaid as an `<svg>`.   [verify: e2e]
AC-28.5 Given a fenced code block whose body contains `<!-- agent -->` lines When rendered in human view Then the marker text is visible inside the `<pre>` and following content is not hidden.   [verify: unit]
AC-28.6 Given an unclosed opener at line 10 When stripped Then lines 10..EOF are removed; given a document with only a stray closer Then the stripped output equals the input unchanged and `count` is 0.   [verify: unit]
AC-28.7 Given a heading "Details" inside an agent section and another "Details" after it When rendered in human and agent views Then the visible later heading has id `details-1` in both views, and every element's `data-line-start` matches the full-source line.   [verify: unit]
AC-28.8 Given a heading inside an agent section When the reader opens `/d/:slug#that-id` Then the URL becomes `?view=agent#that-id` (replaceState: history length unchanged) and the heading is scrolled into view.   [verify: e2e]
AC-28.9 Given a shared doc with sections When `GET <API>/d/<slug>.md` Then 200, `Content-Type` starts `text/markdown`, body equals the stored source byte-for-byte, `X-Agent-Sections: 2`; with `?view=human` the body equals the rule-15 stripped text; `?view=bogus` → 400; unknown slug → 404; expired → 410.   [verify: server]
AC-28.10 Given `GET /paste/<id>/markdown` with no view Then the response JSON `markdown` is identical to today's and includes `view:"agent"`; with `?view=human` `markdown` has no agent text and `agentSections` is 2.   [verify: server]
AC-28.11 Given the ETag from `GET <API>/d/<slug>.md` When `GET …?view=human` is sent with that `If-None-Match` Then the status is 200 (not 304), and repeating with the human ETag yields 304.   [verify: server]
AC-28.12 Given MCP `get_session({sessionId, view:'human'})` Then `markdown` excludes agent text, `view` is `human`, `agentSections` ≥ 1, `rawUrl` ends `/d/<slugOrId>.md`; omitting `view` returns the full source. `tools/list` descriptions of `create_session`, `update_markdown`, `patch_markdown` contain `<!-- agent -->`.   [verify: server]
AC-28.13 Given `GET <API>/llms.txt` Then 200 `text/plain`, body contains `/d/`, `.md`, `view=human` and `<!-- agent -->`, and contains none of the existing slugs from `/paste/list`.   [verify: server]
AC-28.14 Given a shared markdown doc in human view When the `.md` download (#19) is used Then the file has no agent text; in agent view the file equals the full source.   [verify: e2e]
AC-28.15 Given a shared markdown doc Then `head link[rel=alternate][type="text/markdown"]` exists with href ending `/d/<slugOrId>.md`; after navigating to `/library` it is gone.   [verify: e2e]
AC-28.16 Given an HTML doc opened with `?view=agent` Then the iframe preview renders normally and neither `agent-sections-notice` nor `agent-view-banner` exists; `GET /d/<slug>.md` returns `text/plain` with the HTML source.   [verify: e2e]
AC-28.17 Given the split/edit view (#7) of a doc with sections Then the preview shows `agent-section` elements and the editor shows the marker lines.   [verify: e2e]
AC-28.18 Given human and agent views in each of the 6 themes Then `agent-section` has a visible dashed left border and the notice text contrast ≥ 4.5:1.   [verify: visual]
AC-28.19 Given a doc whose first H1 is inside an agent section and a second H1 "Visible" after it (no sessionName) Then `document.title` is `Visible · md-review` and `GET /d/<slug>` with a Slackbot UA has `og:title` "Visible" and an `og:description` containing no agent-section text.   [verify: e2e + server]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `agent-section`, `agent-section-label`, `agent-sections-notice`, `agent-sections-show`, `agent-view-banner`, `agent-view-exit`, `agent-raw-link`.
New: `GET /d/:slugOrId.md[?view=human|agent]`, `GET /llms.txt`. Changed (additive): `GET /paste/:id/markdown` and `GET /paste/:id` accept `view` and
return `view`, `agentSections`. MCP `get_session` input `view`, output `view`, `agentSections`, `rawUrl`; three tool descriptions mention the syntax.
A shared pure function `stripAgentSections(src) -> {markdown, count}` (and a section-range finder) lives in `shared/agentSections.mjs`
(00 §4.8: ESM, no deps, `require()`d by the server, imported by the FE) so FE and server are identical by construction; one fixture table tests it.
`/d/:x.md` route precedence per 00 §6; `X-Agent-Sections` is in the CORS expose list (00 §9).

## Edge cases the adversarial verifier must try
CRLF line endings; `<!--AGENT-->` uppercase/no spaces; marker indented 4 spaces (code block → literal); marker inside a list item or blockquote
(literal); marker on the same line as text (`foo <!-- agent -->` — not a marker); `~~~` fences containing markers; opener inside front matter;
two adjacent sections; a section that is the whole document (human view shows only the notice); section that contains an H1 used as `document.title`
(title must come from human-visible content); label with `<script>`; 1 section (singular wording); comments (#2 review mode) anchored inside a hidden
section — sidebar click switches to agent view; `?view=agent&embed=1`; `?view=AGENT` (treated as unknown → read); `/d/<slug>.md` for a slug that is
all-hex; `/d/<slug>.MD` (404 — suffix is case-sensitive); live update via polling while in human view adds a section (notice count updates).

## Dependencies on other items (by number) and files likely touched
Depends on #4 (routes, `view` param), #3 (TOC filtering), #19 (downloads), #22 (server page head tag + OG description must use human view only),
#2 (review-mode comments), #7 (split preview), #29 (reserves `notes` marker, excludes agent sections). #26 library search indexes the full text
(agent sections included — search is discovery, not a privacy boundary).
Files: `src/composables/useMarkdown.ts` (register), new `src/markdown/agentSections.ts` (renderer plugin) + `shared/agentSections.mjs` (strip/range
finder), `src/components/PreviewPane.vue`, `src/components/DocView.vue`, `src/composables/useDocTitle.ts`, `src/composables/useDownload.ts`,
new `server/routes/raw.cjs` (`/d/:x.md`, `/llms.txt`), `server/routes/meta.cjs` (#22 head link + human-view title/description),
`server/mcp-server.js`, `server/mcp-server-http.js`, tests under `tests/composables`, `tests/e2e`, `server/test.mjs`.

## Decisions
- HTML-comment marker pair is the single primary syntax; fenced ```` ```agent ```` is NOT supported (renders as an ordinary code block). Rationale:
  inner content stays full markdown (nested code fences, tables, mermaid); markers are invisible in every renderer; line-oriented and trivial to strip.
  Note the honest trade-off: plain renderers (GitHub, VS Code) hide the markers but **show** the content — degrading to "show everything" never loses evidence.
- Default view for raw/MCP/API reads is `agent` (full): backward compatible and agents are the main API consumers.
- Hidden sections leave no DOM in human view so find/copy/print/counts are consistent without per-feature filtering.
- Heading ids and line numbers are computed on the full source so links and comment anchors are stable across views.
- Unclosed opener runs to EOF: matches author intent; nothing is secret, so over-hiding is the lower-cost failure for a human reader.
- `/llms.txt` is a static guide only; listing docs would make unlisted links enumerable.
- HTML docs unsupported (sandboxed iframe, no markdown token stream); raw `.md` of an HTML doc is `text/plain` to avoid serving user HTML on the API origin.
