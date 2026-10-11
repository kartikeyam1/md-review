# Spec conventions (shared by every spec in docs/build/specs/)

Product: md-review is pivoting from a markdown *review* tool to a markdown/HTML *view & share* tool.
Backlog: `docs/roadmap-view-share.md` (items #1–#29). Docs are mostly AI-agent-authored (via the MCP server)
and read by engineers, PMs and leadership, sometimes on phones.

## Shared contracts (all specs must use these, never invent alternatives)
- **App base path**: production is GitHub Pages at `/md-review/`; dev is `/`. All routes below are relative to the base.
- **Routes** (History API, path-based; GitHub Pages uses a `404.html` SPA fallback):
  - `/` — upload / new doc landing.
  - `/library` — the library (replaces `#dashboard`).
  - `/d/:slugOrId` — a shared doc. `/d/:slugOrId/:fileName` — a file inside a multi-file session.
  - `/d/:slugOrId@:revHash` — a pinned revision (read-only).
  - Heading deep links: `/d/:slugOrId#heading-id` (the fragment is ONLY ever a heading/anchor id).
  - Query params: `?view=read|edit|split|slides|agent` (default `read`), `?edit=<editToken>` (grants edit capability; stored then stripped from the URL), `?embed=1`.
  - Legacy `#shared=<id>`, `#dashboard`, `#github=` URLs must keep working by redirecting to the new routes.
  - Dev-only `?filePath=` loader must keep working (e2e fixtures depend on it).
- **Doc modes** (per doc, set by author, stored on backend as `mode`): `publish` (default for new docs) or `review` (legacy behaviour: comments, approval, must-fix, prompt generator visible). Existing sessions default to `review`.
- **Viewer capability**: `viewer` (no edit token) vs `editor` (has edit token, or doc is a legacy session that is link-editable).
- **Test hooks**: interactive/landmark elements get `data-testid="<area>-<thing>"` in kebab case (e.g. `toc-panel`, `toc-link`, `code-copy-btn`, `theme-style-menu`). Specs MUST list every testid they rely on.
- **Themes**: `ThemeMode` = `light | dark | github-light | github-dark | locus-light | locus-dark`. Switcher = light/dark toggle + "Style" menu (Default / GitHub / Locus).
- **Viewports** for verification: desktop 1400×900, tablet 820×1180, phone 390×844.
- **Persistence of reader preferences** (font size, width, theme, collapsed state): localStorage, wrapped in try/catch.
- **Backend**: Node `node:sqlite` (DatabaseSync) with FTS5; JSON files migrated by a script, never at boot against live data.

## Spec file format (`docs/build/specs/NN-short-name.md`, NN = backlog item number)
```
# NN — Title
## Goal (1–3 sentences, user value)
## Scope / Out of scope
## Current state (cite file:line from the code you read)
## Behaviour (numbered rules — precise, testable)
## Acceptance criteria
AC-NN.1 Given … When … Then …   [verify: e2e | unit | server | visual | a11y | manual-agent]
…
## Test hooks (data-testid list) and API/MCP contract changes
## Edge cases the adversarial verifier must try
## Dependencies on other items (by number) and files likely touched
```
Acceptance criteria must be **observable** (DOM, URL, network, response body, computed style, file content) — never "code is clean".
Every AC gets a verification method. Aim for 6–15 ACs per item; more for risky items.
