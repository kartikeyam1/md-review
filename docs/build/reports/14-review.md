# #14 Code copy — code review

Verdict: **PASS — no blockers.** Diff matches spec rules 1–13 and 00 §4.4/§4.5/§3.1 (plugin in `src/markdown/`, enhancer in `src/preview/` with delegation on the container, in-button state rather than a toast, wrapper has no `data-line-*`). Print (rule 11) comes from #5's `print.css`, which already hides `[data-testid='code-toolbar']` and pre-wraps `pre`.

## Evidence
- `VERIFY_ITEMS=14 scripts/verify.sh --only typecheck,unit` gave typecheck PASS (0 errors) and unit PASS (385/385).
- Implementer's last run (`.verify/runs/20261010-211035-*`): e2e/14-code-copy 19/19 PASS.
- I found no run in this worktree of the existing suites AC-14.8 depends on (`app`, `tripleclick-selection`, `selection-preservation`, `05-print-title`, `01-locus-theme`, `03-toc-anchors`). I started one, but it was still waiting for a browser slot when the time-box ran out, so it is **unverified**. The orchestrator gate must cover these suites.

## BLOCKER
None.

## SHOULD-FIX
1. `src/preview/codeCopy.ts:57-61`: `swallow` stops **every** `mouseup` whose target is inside a toolbar. A drag-selection that starts in code and ends over the toolbar (selecting upwards from the code) never reaches `PreviewPane.onMouseUp`, so no comment action bar appears even though text is selected. Fix: only swallow a `mouseup` when the matching `mousedown` also landed in the toolbar (keep a `downInToolbar` flag), or when `getSelection().isCollapsed`.
2. `src/preview/codeCopy.ts:57-61` (side effect): stopping `mousedown` propagation at the container means `CommentPopover`'s bubble-phase `document` mousedown handler (`CommentPopover.vue:74`) never sees a copy click. The popover stays open. `SelectionActionBar` uses a capture listener and still closes. The behaviour is arguably right, since it keeps the draft and fits rule 9, but it is inconsistent. Add a DECISIONS line (`#14: copy click leaves an open comment popover open`) so #23/#24 don't "fix" it.

## NIT
3. `src/preview/codeCopy.ts:33-44`: the live region is appended **inside** the `v-html` container. Its text ("Copied to clipboard") becomes part of `container.textContent`/`innerHTML`. Spec #19 (line 60) strips "#14 code toolbars" on export but doesn't mention `code-copy-status`. Either name it in the #19 strip list, or mark the region `data-export-strip` now so #19 has one selector.
4. Rule 10 names `--text-muted`; the code uses `--text-secondary` (`preview.css` `.code-toolbar`, `.code-lang-label`, `.code-copy-btn`). This is correct, because `--text-muted` fails 4.5:1 in light (#8a8480 on #f0ebe2 ≈ 3.3:1). Record it in DECISIONS (`#14: toolbar text uses --text-secondary — --text-muted fails AC-14.9`).
5. GitHub themes: `.code-toolbar` uses `padding-left: 12px` and `.code-block` uses `margin-bottom: 12px`, but github-markdown-css `pre` uses 16px padding and 16px block spacing. The label therefore sits 4px left of the code's text column, and block spacing tightens. Scope a `.github-mode .code-toolbar { padding-left: 16px }` and a `.github-mode .code-block { margin-bottom: 16px }`.
6. `src/composables/useCopyLink.ts:13-25` (pre-existing, now touched): if `execCommand` throws, `ta` is never removed. Move `ta.remove()` into the new `finally` (hoist `ta`). The focus-restore change itself is good, and it also benefits `copy-link-btn` and heading anchors.
7. `src/markdown/codeBlock.ts:35`: the mermaid exclusion depends on `html.startsWith('<pre')`, i.e. on `lineDataPlugin`'s output shape and on plugin order. A one-line comment noting "must stay after lineDataPlugin and before any later fence wrapper (#16/#29)" would prevent silent breakage.

## Checked, no issue
Label regex/escaping (including `"><script>`, `{…}` suffix and unescapeAll then escapeHtml; the aria-label is attribute-safe); copy text = `pre code` textContent minus one `\n`; re-click restarts the timer; detached buttons are a no-op (`isConnected`); listener cleanup is symmetric; opacity-hidden button stays tabbable; `(hover:none)` 44px; `prefers-reduced-motion`; the comment-highlight negative margin is neutralised inside the wrapper; specificity of `:root .preview-pane .code-block > pre` beats both the locus and github `pre` rules; no frozen tests edited (all three 14-* files are new); no new deps.
