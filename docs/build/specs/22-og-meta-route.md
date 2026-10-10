# 22 — `/d/:slug` server-rendered meta route + PNG cover

## Goal
When a doc link is pasted into Slack/Teams/etc., the unfurl shows the doc's real title, a one-line summary and a
branded cover image. GitHub Pages cannot vary HTML per doc, so the backend serves a tiny meta page per doc and sends
humans on to the SPA.

## Scope / Out of scope
In: `GET /d/:slugOrId` (+ `@rev` and `/:fileName` variants), `GET /d/:slugOrId/cover.png`, title/description
extraction, bot detection, cache headers, cover cache, `PUBLIC_BASE_URL`/`FRONTEND_URL` config and the canonical
share-URL rule other items reuse.
Out: testing real Slack unfurls (owner instruction), oEmbed, per-section covers, making the backend reachable from
the internet (deployment concern — see Decisions).

## Current state
- Backend has no HTML routes; unknown GETs fall through to the hosted-site asset fallback and then 404
  (`server/server.cjs:1694-1737`). The new route must be matched before that fallback.
- Share links today are `${FRONTEND_URL}/#shared=<slugOrId>` built in the MCP server (`server/mcp-server.js:116`,
  `123`) and in the UI (`src/composables/useShare.ts:153-159`); the backend knows no frontend URL.
- Titles: `sessionName` or `filename` (`server.cjs:1049-1050`); content type in `contentType` meta key
  (`mcp-server.js:109`). Revision authors/clients are recorded (`server.cjs:378`).
- No image tooling in `server/package.json`; Montserrat is not bundled (it happens to exist in `~/.fonts` only).

## Behaviour
1. Config (env): `FRONTEND_URL` (default `https://kartikeyam1.github.io/md-review`) and `PUBLIC_BASE_URL` (the
   backend's externally reachable origin, default `http://localhost:${PORT}`). Trailing slashes are ignored.
   - `app_url(x)` = `${FRONTEND_URL}/d/${x}`; `share_url(x)` = `${PUBLIC_BASE_URL}/d/${x}`, where `x` = slug or id.
   - **Canonical rule reused by #21/#23/#27/MCP/CLI** (refined in 00 §6): responses that hand out a link return
     `app_url` = `app_url(x)` and `url` = `share_url(x)` **only when `PUBLIC_BASE_URL` is explicitly set in the
     environment**, else `app_url(x)` (the default `http://localhost:PORT` is used for this page's own `og:*` tags but
     never handed out). MCP `shareUrl` = `url`. The meta page itself always uses `PUBLIC_BASE_URL` (default included).
2. `GET /d/:slugOrId` (also `/d/:slugOrId@:rev` and `/d/:slugOrId/:fileName`): resolves like `/paste/:id`. Responds
   200 `text/html; charset=utf-8` with, in `<head>`, all HTML-escaped:
   - `<title>{title} · md-review</title>`; `<meta name="description" content="{description}">`;
     `<meta name="robots" content="noindex, nofollow">`; `<link rel="canonical" href="{share_url}">`.
   - `og:site_name`=`md-review`, `og:type`=`article`, `og:title`={title}, `og:description`, `og:url`={share_url},
     `og:image`=`{PUBLIC_BASE_URL}/d/{x}/cover.png?v={cover_key}`, `og:image:type`=`image/png`,
     `og:image:width`=`1200`, `og:image:height`=`630`, `og:image:alt`={title},
     `article:modified_time`={ISO updated_at}.
   - `twitter:card`=`summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image` (same URL).
   - `<body>` contains an `<h1>` with the title, the description in a `<p>`, and an `<a>` to the app URL.
   - (#28 adds `<link rel="alternate" type="text/markdown" href="{API}/d/{x}.md">` to this head.)
3. Title = the server `docTitle` (**00 §5**: `sessionName` → front-matter `title:` / HTML `<title>` → first
   human-visible `# ` H1, inline markdown stripped / HTML first `<h1>` → filename without extension → `Untitled`).
   Max 200 chars.
4. Description (plain text, whitespace collapsed, ≤200 chars, cut at a word boundary with `…`):
   a) the paragraph following a heading whose text matches `/^tl;?dr\b/i`, or a paragraph starting with `TL;DR`
   (bold or not; the label itself removed); b) else HTML `<meta name="description">` for HTML docs; c) else the first
   paragraph of body text (skipping headings, front-matter, code fences, tables, images, HTML comments);
   d) else `"{Markdown|HTML} document shared on md-review"`. Markdown syntax (`**`, links → link text, backticks)
   is stripped. Title and description are computed on the **human view** (agent-only sections removed, 00 §5); until
   #28 lands there are no agent sections, and #28 owns switching this extraction to `stripAgentSections` output.
5. Humans vs bots: if the `User-Agent` matches (case-insensitive) any of `Slackbot`, `Slack-ImgProxy`,
   `Twitterbot`, `facebookexternalhit`, `LinkedInBot`, `Discordbot`, `WhatsApp`, `TelegramBot`,
   `SkypeUriPreview`, `Microsoft Teams`, `Googlebot`, `bingbot`, `Embedly`, `redditbot`, `Applebot`, the page has
   **no** redirect. Otherwise it also includes `<meta http-equiv="refresh" content="0; url={app_url}">` and
   `<script>location.replace(TARGET + location.hash)</script>` where `TARGET` (JSON-encoded, `<` escaped) =
   `app_url` + the request's query string verbatim (e.g. `?view=slides`, `?edit=…`). The JS appends the
   browser-side `location.hash`, so heading anchors survive; the meta refresh goes to `TARGET` without hash. `@rev` and `/:fileName` suffixes are carried into the app URL path.
6. Not found → 404 HTML, title `Document not found · md-review`, no `og:image`, humans still redirected to the app
   URL (which renders its own not-found state). Expired → 410 HTML, title `Expired document · md-review`,
   description `This document has expired.`, no `og:image`, same redirect rule. Neither leaks the stored title.
7. Caching for the HTML: `Cache-Control: public, max-age=60`, `ETag` = hash of (title, description, cover_key,
   bot-or-human variant), `Vary: User-Agent`; matching `If-None-Match` → 304.
8. Cover: `GET /d/:slugOrId/cover.png` → 200 `image/png`, exactly 1200×630, rendered from an SVG template with
   `@resvg/resvg-js` using a bundled Montserrat font (`server/assets/fonts/`, OFL) — no system-font dependency.
   Template (Locus palette): background `#280A38`; small `md-review` wordmark in `#B066FF`; title in white,
   Montserrat 600, auto-sized 64→40 px, wrapped to ≤3 lines with `…`; a meta line in `#9B8FA8`:
   `{Markdown|HTML} · by {first revision author or client} · Updated {D Mon YYYY}`; a `#B066FF` pill with the doc
   type. No gradients, no title underline bars. Text is XML-escaped before entering the SVG.
9. `cover_key` = first 12 hex of md5(`template_version` | title | meta line). Covers are cached on disk as
   `DATA_DIR/covers/{id}-{cover_key}.png`; when a new key is generated, older `{id}-*.png` files are deleted; doc
   deletion removes them. If `?v=` equals the current key → `Cache-Control: public, max-age=31536000, immutable`;
   otherwise (missing/stale `v`) the current cover is served with `public, max-age=300`. `ETag` = `"{cover_key}"`.
   Not found / expired → 404 / 410 (JSON error, no image).
10. Rendering failure (e.g. font load error) → 500 JSON, and the meta page omits `og:image` rather than failing.
11. Hosted sites (`/site/*`) and the asset fallback are unaffected; `/d/…` never falls through to them. Route
    precedence within `/d/` (shared with #28): 00 §6.

## Acceptance criteria
AC-22.1 Given a doc with sessionName "Q3 routing review", When `GET /d/<slug>` with UA `Slackbot-LinkExpanding 1.0`, Then 200 HTML whose `og:title` is "Q3 routing review", `twitter:card` is `summary_large_image`, and the body contains no `http-equiv="refresh"` and no `location.replace`.   [verify: server]
AC-22.2 Given the same doc, When fetched with a Chrome desktop UA, Then the HTML contains a meta refresh and script whose target is `{FRONTEND_URL}/d/<slug>`; with `?view=slides` the target ends `/d/<slug>?view=slides`.   [verify: server]
AC-22.3 Given markdown `# Title\n\n## TL;DR\nShipped the thing. More text…`, Then `og:description` = "Shipped the thing. More text…" (TL;DR wins over the first paragraph).   [verify: server]
AC-22.4 Given a doc without TL;DR whose first paragraph is 400 chars with `**bold**` and `[link](x)`, Then description ≤200 chars, ends with `…`, contains "bold" and "link" without `**`, `[`, `](`.   [verify: server]
AC-22.5 Given sessionName `<script>alert(1)</script> & "q"`, Then the HTML contains no unescaped `<script>alert` and `og:title` content attribute is correctly escaped.   [verify: server]
AC-22.6 Given `og:image` from AC-22.1, When fetched, Then 200 `image/png`, bytes start with the PNG signature, IHDR width 1200 height 630, size < 500 KB, `Cache-Control` contains `immutable`.   [verify: server]
AC-22.7 Given the doc's content and title change, When `/d/<slug>` is refetched, Then `og:image` `?v=` differs; the old `?v=` URL returns the new image with `max-age=300`; only one cover file for the id exists in `DATA_DIR/covers`.   [verify: server]
AC-22.8 Given a 300-char title with emoji and CJK, When the cover renders, Then 200 valid 1200×630 PNG (no 500).   [verify: server]
AC-22.9 Given an unknown slug, Then 404 HTML with title "Document not found · md-review" and no `og:image`; an expired doc gives 410 with "Expired document" and its real title absent.   [verify: server]
AC-22.10 Given a second GET with the returned ETag in `If-None-Match` (same UA), Then 304.   [verify: server]
AC-22.11 Given an HTML doc (`contentType: html`) with `<title>Report</title><meta name="description" content="Desc">` and no sessionName, Then `og:title` "Report", `og:description` "Desc", cover meta line starts "HTML".   [verify: server]
AC-22.12 Given a cover PNG rendered for a known fixture, When an agent views it, Then title, type pill, meta line and wordmark are legible and on-palette.   [verify: manual-agent]
AC-22.13 Given `PUBLIC_BASE_URL=https://mdr.example.com`, Then `og:url`, `canonical` and `og:image` are absolute URLs on that origin, and MCP `create_session` returns `shareUrl` `https://mdr.example.com/d/<slug>`; with `PUBLIC_BASE_URL` unset, `shareUrl` is `{FRONTEND_URL}/d/<slug>` (AC-04.16 unchanged).   [verify: server]

## Test hooks (data-testid list) and API/MCP contract changes
No SPA testids. New routes `GET /d/:slugOrId[@rev][/:fileName]`, `GET /d/:slugOrId/cover.png`. New env
`FRONTEND_URL`, `PUBLIC_BASE_URL`. New dependency `@resvg/resvg-js` in `server/package.json`; bundled font file.
Canonical `url`/`app_url` rule (rule 1) consumed by #21, #23 and MCP tools.

## Edge cases the adversarial verifier must try
- Slug that collides with a hosted site's slug; id vs slug for the same doc give the same canonical URL (slug form).
- Doc whose whole content is a code block or a table (description falls back to rule 4d).
- Title containing newlines, RTL text, `&amp;`, a 10 KB single line.
- `/d/<slug>%2F..%2F` and `/d/<slug>/cover.png/extra` → 404, no traversal.
- UA strings `""`, missing UA, `slackbot` lowercase.
- 50 parallel cover requests for a cold cache: all 200, identical bytes, one cache file.

## Dependencies on other items (by number) and files likely touched
Depends on #20 (lookup, updated_at, revision author), #4 (SPA `/d/` routes must exist for the redirect to land).
#23 share URLs and #21 upsert responses use rule 1. Lands **before** #23. Files: new `server/routes/meta.cjs` +
`server/cover.cjs` (00 §4.9), `server/assets/fonts/Montserrat-SemiBold.ttf` (+ Regular), `server/package.json`,
`server/mcp-server.js` (URL builders).

## Decisions
- Bots get meta only, humans get meta + refresh + JS — some unfurlers follow meta refresh and would unfurl the
  generic SPA instead.
- `noindex` on every meta page — docs are internal; we want unfurls, not search-engine indexing.
- Not-found/expired pages never expose the stored title — an expired doc should stop leaking content.
- Unfurls only work if `PUBLIC_BASE_URL` is internet-reachable; today's backend is on a private IP, so Slack will
  not be able to fetch it until it is exposed. The feature is verified by fetching the route, per the owner.
