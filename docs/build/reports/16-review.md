# #16 Callouts + RAG badges — code review

Scope: `git diff bae76c3` (useMarkdown.ts, style.css, preview.css, print.css, mcp-server*.js) plus untracked
`src/markdown/alerts.ts`, `src/markdown/rag.ts`, `tests/items/16-callouts.test.ts`, `tests/e2e/items/16-callouts.test.mjs`.

Evidence (run by reviewer):
- `VERIFY_ITEMS=16 scripts/verify.sh --only typecheck,unit` → typecheck PASS 0 errors, unit PASS 397/397.
- `VERIFY_ITEMS=16 E2E_FILES=16-callouts scripts/verify.sh --only e2e` → e2e/16-callouts PASS 9/9.

**Verdict: PASS — no blockers.**

## BLOCKER
None.

## SHOULD-FIX
1. **Dark themes print unreadable RAG labels and Locus-dark callout titles** — `src/styles/print.css:184-200`.
   Print resets only the callout *accents* for `html.dark:not(.locus-theme)`. Nothing sets `print-color-adjust`, so
   browsers drop backgrounds by default, and the page goes white (print.css:7-27). Result: in Default-dark, GitHub-dark
   and Locus-dark, RAG text keeps its dark-mode fg (`--rag-green-fg: #8ef0b5`, amber `#ffd27a`, red `#ffb3aa`) on white,
   about 1.3–1.8:1. Locus-dark callout titles keep `--callout-*-fg` (#3DE89A, #FFB84D, …) on near-white, under 2:1. The
   rule-9 e2e checks only borders and break-inside, so it passes anyway.
   Fix: in the print block, set `html.dark, html.dark.locus-theme` back to the light `--rag-*-bg/fg/dot` values and the
   light Locus `--callout-*-fg` values plus `--callout-tint: 8%`. Simplest is to list the dark selectors next to the
   existing light-palette reset at print.css:7-12.
2. **GitHub-theme deviation not recorded** — `src/styles/preview.css:741-749`. `:root .preview-pane .callout >
   .markdown-alert-title { display:block }` and the octicon margin override github-markdown-css's `display:flex` in the
   GitHub themes. Spec rule 3 says GitHub themes need "no extra CSS". The reason holds: flex turns the custom title's
   inline markup into separate items and drops the spaces between them. But `docs/build/DECISIONS.md` has no entry for
   it. Add `- #16: callout title is display:block in all themes (incl. GitHub) — flex collapses spaces around inline
   markup in custom titles`.

## NIT
3. `src/styles/print.css:194-200` — the print `border-color: var(--callout) !important` and the octicon colour also hit
   GitHub themes, replacing GitHub's alert palette with our tokens in print. Scope them to `:not(.github-mode)`, or accept
   it and note it.
4. `src/markdown/rag.ts:43` — `md.utils.unescapeAll` decodes HTML entities as well as backslash escapes, so
   `:rag-green[AT&amp;T]` shows "AT&T". Harmless (the output is still escaped), but it differs slightly from "plain
   text". If literal entities matter, use `raw.replace(/\\([!-\/:-@\[-`{-~])/g, '$1')`.
5. `src/markdown/rag.ts:20` — no word-boundary check, so `foo:rag-red[x]` makes a badge in the middle of a word. The
   spec doesn't forbid this. Mention it in the #12 slash-menu notes only if it ever surprises anyone.
6. `src/style.css:196-216` — the Locus hues are repeated as hex literals. `--callout-important: #B066FF` equals the
   Locus `--accent`, so `var(--accent)` would keep it tied to #1. Low value: #1 has no named green/orange tokens to reuse.
7. Commenting on the marker line itself (`> [!NOTE]`, line N): the body `<p>` starts at N+1 and the title has no range,
   so only the wrapper covers line N. That matches the spec (the wrapper has the blockquote's range). Just be aware that
   a comment anchored to line N highlights the whole callout.

## Checked, no issue
- Core rule order: `callouts` is inserted right after `inline` and before `linkify`, `heading_ids`, `replacements` and
  `smartquotes`. Rebuilt title and body tokens get typographer processing, and heading ids inside callouts are correct.
- Line ranges: the wrapper keeps the blockquote map (00 §4.4). The body paragraph's map is shifted +1, and the title has
  no map. `getLineMap` skips tokens with no map.
- Not-a-callout cases (`[NOTE]`, code span, marker on line 2, lazy line 2, `[!DANGER]`): first-line check plus
  `pOpen.map[0] === open.map[0]`. Nested quotes are handled by the forward scan. CRLF is normalised by markdown-it.
- RAG: `:` is a markdown-it terminator, so the rule fires after `text`. Escape, code span, 80/81 chars, newline, `\]`
  and inside link text (via skipToken in silent mode) all behave. The label is escaped on render.
  `plainText` recurses into the `rag` token's children, so slug and TOC read "Status On track" (no sr-only prefix).
- a11y: `role="note"` is present, SVGs are `aria-hidden` and `focusable="false"`, and `.sr-only` already exists
  (preview.css:564).
- The MCP description change is text only, identical in both servers, and documents exactly the #16 syntax that #12
  and #27 must emit.
- No frozen tests edited; the #16 test files are new.
