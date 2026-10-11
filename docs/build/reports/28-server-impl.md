# #28 server/MCP half — implementation report

**Verdict:** DONE.

## Gate
`VERIFY_ITEMS=28 scripts/verify.sh --only server`:
`server PASS 429/430 pass, 0 fail, 1 skip`, `OVERALL: PASS` (run 20261011-011251). That run was after
the captain's fix to `shared/agentSections.mjs`. `server/28-agent-view.test` passes 39/39, and every
pre-existing server suite passes.

## ReDoS found during the build (fixed by the captain)
The original `AGENT_OPEN_RE` was roughly cubic on a line `<!-- agent: ` + spaces with no `-->`
(2000 spaces → 1.2 s, 4000 → 11 s). The server strips on every write (`syncSearchRow → docTitle`), on
meta pages and on `?view=human` reads, so one doc could stall the backend. The captain replaced the
regex with a linear hand-written matcher. The regression test `#28 — pathological marker input stays
linear` now passes.

## Files
- **New `server/routes/raw.cjs`:** `GET|HEAD /d/:x.md` (rule 16) and `GET /llms.txt` (rule 20).
  It is registered in `server.cjs` before `meta.cjs` and `site-assets.cjs` (00 §6).
- **New `server/agent-view.cjs`:** `readView`, `viewEtag` (`-h`), `viewOf` and `humanMarkdown`. It
  wraps `require('../shared/agentSections.mjs')`.
- **`server/routes/session.cjs`:** `view` on `GET /paste/:id[/markdown]` (rule 17), with
  view-specific ETags (rule 18).
- **`server/routes/meta.cjs`:** alternate `text/markdown` link (rule 14), and `rawHref` added to the
  page ETag.
- **`server/doc-text.cjs`:** `docTitle` and `docDescription` now read the human view. #22's ad-hoc
  agent skipping was removed.
- **`server/mcp-server.js` and `server/mcp-server-http.js`:**
  - `get_session` takes `view` (zod enum) and returns `view`, `agentSections` and `rawUrl`.
  - `AGENT_MARKER_HINT` (containing `<!-- agent -->` and `<!-- /agent -->`) is appended to the
    `create_session`, `update_markdown` and `patch_markdown` descriptions in both servers.
- **New test `server/test-items/28-agent-view.test.mjs`:** 39 tests covering the fixture table via
  `require()`, AC-28.9, 28.10, 28.11, 28.12 (stdio and HTTP), 28.13, the server half of 28.19,
  AC-28.16's raw endpoint for HTML docs, and the pathological-input test. Before implementation it
  failed with 404s, missing fields and a missing link, as expected.

## Design notes
- HTML docs:
  - `/d/:x.md` serves them as `text/plain; charset=utf-8` with `X-Agent-Sections: 0`.
  - `view=human` is accepted and changes nothing.
  - `/paste` `view` does not strip HTML.
- `.MD` falls through to `meta.cjs`, which treats it as unparseable and returns 404.
- The search index (FTS content) still uses the full source.

## Pre-existing test changes
- `server/test-items/lib/20-golden.mjs`: added `view` and `agentSections` to `ADDITIVE`. Rule 17 makes
  them additive keys on `/paste/:id/markdown`, and 00 §10.5 lists them.

## Frozen test changes
None.

## Decisions
Six lines were appended to `docs/build/DECISIONS.md` (`#28: …`).

## Fix round (findings from 28-review.md / 28-qa.md)

### QA N1
`GET /paste/:id` adds `view` and `agentSections` only when a `markdown` field is in the response.
That means:
- always on `/markdown`;
- on the full response when `?view=` is given;
- on `?fields=…` only when `content` is requested.

`?fields=meta&view=human` now returns the plain body with the plain ETag. A bogus `view` is still
400. This is in `server/routes/session.cjs`. The MCP `get_session` fallback already sets `view` when
the server omits it.

### Review SF3
`viewOf` in `server/agent-view.cjs` short-circuits to `{markdown, count: 0}` when the
`/<!--\s*agent/i` precheck fails, for both views. The precheck is now shared by `viewOf` and
`humanMarkdown`.

### NIT2
The `/d/:x.md` ETag hash input now includes the content type (`html` or `markdown` + `\n` + source).
A markdown doc and an HTML doc with the same bytes get different ETags.

### NIT3
`viewEtag(etag, variant)` now covers three variants, each with its own suffix:
- `human` → `-h`;
- `agent` → `-a`, used for an explicit `?view=agent` on `GET /paste/:id` that echoes
  `view`/`agentSections`;
- plain → no suffix.

`/markdown`'s default agent body keeps the unsuffixed session ETag, so its default read is unchanged.
`If-None-Match` returns 304 only for a request's own variant: the new test tries all 3×3 pairs.

### Tests
Four tests were added to `server/test-items/28-agent-view.test.mjs` under
`#28 fix round — review/QA findings (server)`. The file now has 43 tests.

### Gate
`VERIFY_ITEMS=28 scripts/verify.sh --only server` gives `server PASS 437/438 pass, 0 fail, 1 skip`,
`OVERALL: PASS` (run 20261011-012625).
