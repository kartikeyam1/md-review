# #28 agent view — code review

Scope: `git diff` vs HEAD 265756a plus untracked #28 files in `lane/agent`. Method: read the diff. A differential script compared `shared/agentSections.mjs` `topLevelLines` with the markdown-it 14 token stream (`html: true`) on 24 edge-case docs. A perf script ran ~1 MB adversarial inputs through `stripAgentSections`. No files were edited. Last server gate in `.verify/last-summary.txt`: `server/28-agent-view.test` 39/39, server 429/430 (1 skip).

**No blockers.**

## SHOULD-FIX

1. **The scanner and markdown-it disagree on CommonMark type-7 HTML blocks.** A type-7 block is a line holding only a tag outside the type-6 list: `<img …>`, `<span>`, `<a …>`, `<br>`, custom elements. `shared/agentSections.mjs:67,146-153` only tracks type-6 tags, so the scanner reports a marker line as top-level. markdown-it puts that same line inside the html_block, which runs until the next blank line. The result was confirmed with the differential script:
   - `<img src="a.png">\n<!-- agent -->\nSECRET\n<!-- /agent -->`: the server's `?view=human` / MCP strip removes SECRET. The FE human view still shows SECRET, because the level-0 html_block's `map[0]` falls outside the section (`src/markdown/agentSections.ts:49,63`). The notice still says "1 hidden". The agent view renders no `agent-section` wrapper while the banner says "showing 1".
   - The reverse case: `<!-- agent -->\n<span>\n<!-- /agent -->\nVISIBLE`. The FE hides VISIBLE; the server keeps it.
   - This is realistic: a badge or image line followed directly by a marker.
   - **Fix:** in `topLevelLines`, open `html = {kind:'block'}` for a type-7 line, i.e. one that is entirely a single complete open or close tag. Use a linear tag matcher, not a backtracking attribute regex. Apply it only when `prevBlank` or the previous line ended a block, because type 7 cannot interrupt a paragraph. Add both docs to `tests/items/28-agent-fixtures.mjs`, plus a test asserting that FE token membership equals the server ranges.
   - Types 3–5 (`<?`, `<!X`, `<![CDATA[`) diverge the same way, but they are exotic: see NIT 1.
2. **The raw link on a pinned route points at the latest version.** `agent-raw-link` (`src/components/AgentViewBanner.vue:19-25`) shows whenever `rawMarkdownUrl` is set (`src/composables/docState.ts:218`), and 00 §1.3 allows agent view on `/d/x@rev`. On a pinned revision the link opens the live source, not the revision on screen. The head link (`DocView` `route.kind === 'doc'`) and the meta page (`!rev`) already exclude pinned routes. **Fix:** null out `rawMarkdownUrl` (or hide the link) when `pinnedInfo` is set.
3. **Full scan on every agent-view read.** `viewOf` (`server/agent-view.cjs:31`) always runs `countAgentSections`, i.e. the full line scan. It hits every `GET /paste/:id/markdown`, every `/d/x.md`, and every MCP `get_session`. `humanMarkdown` already has the `MAYBE_OPENER` precheck. Measured: about 90 ms per 1.1 MB of dense list/marker lines. **Fix:** short-circuit to `{markdown: text, count: 0}` when `!MAYBE_OPENER.test(text)`, in both `viewOf` branches.

## NIT

1. `shared/agentSections.mjs:136-157`: HTML block types 3/4/5 are not tracked, so markers inside `<?php … ?>`, `<!DOCTYPE …` or `<![CDATA[` count as top-level. Add three cheap `kind:'raw'`-style states, ending at `?>`, `>` and `]]>`.
2. `server/routes/raw.cjs:94-95`: the ETag hashes only the source. If an update changes `contentType` (md ↔ html) but keeps the same bytes, the old ETag is reused while `Content-Type` changes. Fold `html` into the hash input.
3. `server/routes/session.cjs:113,118`: `GET /paste/:id` and `?view=agent` share an ETag but return different bodies (only the latter carries `view`/`agentSections`). Browser caches key by URL, so the practical risk is low. A `-a` suffix when `viewed` would make the ETag honest.
4. The section count is computed twice. `docState.ts:216` runs a second full scan of the markdown that `PreviewPane`'s render already counted (`env.agentSections`). It is only read in read/agent view, so this is fine for now. If profiling shows it, lift the count out of the render.
5. #4's frozen test `tests/composables/useRouter.test.ts:116-124` was edited. The edit is necessary, because "agent not shipped" is no longer true, but it is not logged in DECISIONS.md. The `server/test-items/lib/20-golden.mjs` `ADDITIVE` change is sanctioned by 00 §10.5.
6. #29 reuse:
   - `findNotesSections` reuses the grammar, which is good.
   - Agent and notes ranges are found independently, so they can overlap (`<!-- notes -->…<!-- agent -->…<!-- /notes -->`). #29 needs a precedence rule.
   - The core rule in `agentSections.ts` hardcodes agent filtering. When #29 lands, extract `filterSections(state, sections, mode)` so slides and notes do not copy the token walk.
   - The human token stream from `renderWithHeadings(src, {agentView:'human'})` is directly reusable for slides.

## Checked, OK

- **Line scanner:** agrees with markdown-it for paragraphs, tables, lazy list/quote continuation, list items with blank lines, fences in lists, `~~~` and backtick-info fences, indented code, setext, ref definitions, type-6 and raw blocks, and front matter. The FE and server front-matter rules match.
- **ReDoS:** every regex in the shared module is anchored or linear. Measured on ~1 MB inputs: worst 31 ms for `hr`, 1.8 ms for an unclosed long opener.
- **Reveal logic:** `alignToFragment` → `hiddenIds`, and `scrollToLine` → `hiddenRanges` → `reveal-agent` → `setView('agent')` (replaceState). `flushReveal` runs after the re-render. Embeds have no listener, so no reveal there.
- **Entry chunk:** the notice and banner are lazy. The eager parts are the shared module, the plugin, and `PASTE_API`, as intended. `downloadActions` is already lazy.
- **ETag variants:** the `-h` variant is right for both raw and session routes. The 304 response carries `X-Agent-Sections`.
- **Route precedence:** `raw.cjs` runs before `meta.cjs`, and `.MD` falls through to a 404.
- **CORS:** `X-Agent-Sections` is in the expose list.
- **MCP back-compat:** a plain `get_session` keeps its legacy URL. Older backends get the strip on the client side.
- `/llms.txt` lists no docs.
