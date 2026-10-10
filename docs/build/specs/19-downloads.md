# 19 — Download as `.md`, self-contained `.html`, and PDF (print)

## Goal
Readers need to take a doc with them — attach it to an email, archive it, open it offline, hand a PDF to leadership.
Any reader (viewer or editor) can download the raw markdown, a single self-contained HTML file that looks like what
they see, or a PDF via the browser's print dialog.

## Scope / Out of scope
- In scope: a Download menu in the doc header for markdown and HTML docs; client-side generation; viewer and editor
  capability; read/split/focus layouts; pinned revisions (`/d/:slug@:rev`); files inside multi-file sessions.
- Out of scope: server-side rendering/PDF generation, zip of a whole multi-file session, embedding web fonts,
  including review comments in exports (the existing comments-JSON export stays as is), HTML-doc PDF (see Decisions).

## Current state
- The only export is comments JSON: `handleExportComments` builds a Blob and clicks an `<a download>`
  (`src/App.vue:571-589`), triggered from the comments sidebar (`App.vue:743`). It names the file
  `<basename>.comments.json` from `filename` (`App.vue:586-587`).
- Doc source lives in the `markdown` ref and the name in `filename` (`App.vue:30-33`); content type in `contentType`
  (`App.vue:33`, detected by `src/composables/useContentType.ts:29-32`).
- Preview HTML is produced by `useMarkdown().renderHtml` (`src/composables/useMarkdown.ts:185-191`) and styled by
  scoped `:deep()` rules in `src/components/PreviewPane.vue:411-711` plus theme tokens in `src/style.css:1-62`;
  GitHub themes load `github-markdown-css` as `<link>` (`src/composables/useTheme.ts:32-55`).
- Mermaid renders in place to inline SVG in the live DOM (`PreviewPane.vue:226-245`).
- HTML docs render from a Blob URL in a sandboxed iframe (`PreviewPane.vue:118-150`, `:399-407`).
- Header actions live in `src/components/HeaderBar.vue:140-200`; no `@media print` rules exist yet (#5 adds them).

## Behaviour
1. A "Download" button `data-testid="download-menu-btn"` (`aria-haspopup="menu"`, `aria-expanded`) appears in the doc
   header whenever a doc is open, for viewers and editors alike, in publish and review modes. Placement per 00 §2.2:
   desktop in the bar; tablet and phone as a "Download" group of items (same item testids) inside
   `header-overflow-menu`, with no `download-menu-btn`. It opens a menu `data-testid="download-menu"` (an `AppMenu`,
   00 §3.2: `role="menu"`, items `role="menuitem"`, arrow-key navigation, Esc closes and returns focus to the button).
2. Markdown docs show three items: "Markdown (.md)" `download-md`, "HTML (.html)" `download-html`,
   "PDF (print)" `download-pdf`. HTML docs show one item: "HTML source (.html)" `download-html-source`.
3. **What is exported** is the content the reader is currently looking at: the current revision, or the pinned
   revision when viewing `/d/:slug@:rev`, or the selected file of a multi-file session; for an editor with unsaved
   edits, the current editor content.
4. **Filename**: base = the doc's `filename` with characters `/ \ : * ? " < > |` and control chars replaced by `-`,
   trimmed; empty → `document`.
   - `.md`: if base ends in `.md`/`.markdown` (case-insensitive) use it as-is; else strip a `.txt` extension if
     present and append `.md` (`notes` → `notes.md`, `pasted.md` → `pasted.md`, `a.txt` → `a.md`).
   - `.html` export: base with its extension replaced by `.html` (`plan.md` → `plan.html`).
   - HTML source: original filename if it ends in `.html`/`.htm`, else base + `.html`.
5. **`.md` download**: the bytes are exactly the source string encoded as UTF-8 with no BOM and no newline
   normalisation (frontmatter included). MIME `text/markdown;charset=utf-8`.
6. **HTML source download** (HTML docs): exactly the stored HTML source (no bridge script, no theme injection),
   UTF-8, MIME `text/html;charset=utf-8`.
7. **Self-contained `.html` export** (markdown docs) is a single file that:
   a. starts with `<!doctype html>`, has `<html lang="en">`, `<meta charset="utf-8">`, a viewport meta, and `<title>`
      equal to `docTitle` (00 §5; without the ` · md-review` suffix);
   b. contains the rendered doc body (same `renderHtml` output, with heading ids preserved so `#id` links work) inside
      `<main class="preview-pane …">` with the current theme's classes (`markdown-body` for GitHub themes) and the theme
      class(es) on `<html>` (e.g. `dark`, `github-theme`, `locus-theme`);
   c. inlines, in `<style>` blocks, all CSS needed to match the on-screen look of the **current theme**: theme tokens,
      preview typography, hljs colours, tables, task lists, callouts and RAG badges (#16), `<details>` styling (#17),
      and for GitHub themes the full github-markdown-css content — no `<link rel="stylesheet">`, no `@import`;
   d. contains every mermaid diagram as its rendered inline `<svg>` (the exporter waits for pending mermaid renders,
      up to 10 s; a diagram that failed or timed out is exported as `<pre><code>` of its source);
   e. contains **no `<script>` elements and no inline event-handler attributes** of our own; app chrome is stripped:
      #14 code toolbars, #17 fold toggles/ellipses (all folds expanded, no `hidden` attributes), #15 zoom-trigger
      attributes (`tabindex`, `role="button"`, `data-testid="zoom-trigger"`), comment highlights (`comment-highlight`
      class), selection highlights, and the comment/approval UI;
   f. keeps `<details>` elements as-is (they work without JS);
   g. images: `data:` URIs kept; images served by the md-review backend (attachments, same origin as `PASTE_API`)
      and relative URLs are fetched and inlined as `data:` URIs when the fetch succeeds and the total inlined size stays
      ≤ 15 MB; external `http(s)` images and failed fetches keep their original absolute URL;
   h. includes `@media print` rules so printing the file looks like printing from the app;
   i. renders correctly when opened from disk with network disabled (except external images) and fonts falling back
      to the declared font stacks.
8. **PDF (print)**: closes the menu, ensures mermaid diagrams are rendered and folds/details are expanded for print
   (#17 rule 15), then calls `window.print()`. Print styling (chrome hidden, content full width) is owned by #5.
9. Downloads are generated client-side; no network request to the backend is made for `.md`, HTML source or PDF.
   The `.html` export may fetch images per rule 7g only.
10. Each download triggers exactly one file download via an `<a download>` click (object URL revoked afterwards). A
    failure (e.g. export throws) shows an error `app-toast` (00 §3.1) "Download failed" and does not navigate.
11. Large docs: `.md`/HTML-source download completes < 300 ms for a 5 MB doc; `.html` export < 3 s for a doc with
    20 diagrams (excluding image fetches) and shows a busy state on `download-html` while working.

## Decisions
- HTML docs get no PDF item: printing the parent page prints only the iframe's visible viewport, the sandbox
  (no `allow-modals`) blocks `print()` inside it, and opening the document unsandboxed in a new tab would run its
  scripts on the app's origin. Readers can open the downloaded source and print it.
- Export is a static snapshot of the current theme (no theme toggle, ignores `prefers-color-scheme`) — WYSIWYG.
- No web fonts embedded (size); font stacks degrade gracefully.
- Comments are not included; review users keep the existing comments-JSON export.
- Viewers can download (the backlog says "available to viewers"); a doc link already grants read access.

## Acceptance criteria
AC-19.1 Given a viewer (no edit token) opens a markdown doc Then `download-menu-btn` is visible and the menu lists
  `download-md`, `download-html`, `download-pdf`.   [verify: e2e]
AC-19.2 Given a doc named `Weekly Update.md` whose source contains frontmatter, CRLF lines, emoji and a trailing
  newline When `download-md` is clicked Then one download named `Weekly Update.md` occurs and its bytes equal the
  source exactly (UTF-8, no BOM).   [verify: e2e]
AC-19.3 Given filenames `notes`, `a.txt`, `x/y:z.md`, `` (empty) Then `.md` names are `notes.md`, `a.md`, `x-y-z.md`,
  `document.md`.   [verify: unit]
AC-19.4 Given an HTML doc `report.html` Then the menu shows only `download-html-source` and the downloaded bytes equal
  the stored source (no `__mdreview` bridge string).   [verify: e2e]
AC-19.5 Given a markdown doc with 2 mermaid diagrams When `download-html` is clicked Then the file contains 2 `<svg`
  diagrams, zero `class="mermaid"` elements holding raw source, zero `<script`, zero `<link rel="stylesheet"`.   [verify: e2e]
AC-19.6 Given theme `github-dark` When exported Then the file's `<style>` contains github-markdown-css dark rules and,
  opened in a browser offline, the body background computes to `#0d1117`.   [verify: e2e]
AC-19.7 Given theme `locus-light` vs `light` When exported Then the two files' computed `h1` font-family and body
  background differ and each matches the app's on-screen computed values for that theme.   [verify: e2e]
AC-19.8 Given a doc with code blocks, a callout, a RAG badge, a folded section and a closed `<details>` When exported
  Then the file has no `code-copy-btn`, no `heading-fold-toggle`, no `hidden` attribute on content, the callout and
  badge render styled, and the details is present and closed.   [verify: e2e]
AC-19.9 Given a doc with a backend attachment image and an external `https://` image When exported Then the attachment
  `src` starts with `data:image/` and the external one is unchanged.   [verify: e2e]
AC-19.10 Given the exported file opened offline Then clicking an in-doc `[x](#section-id)` link scrolls to that heading.   [verify: e2e]
AC-19.11 Given `download-pdf` is clicked (with `window.print` stubbed) Then `window.print` is called exactly once after
  all mermaid SVGs exist in the DOM.   [verify: e2e]
AC-19.12 Given `/d/<slug>@<oldRev>` Then `download-md` yields the old revision's source, not the latest.   [verify: e2e]
AC-19.13 Given keyboard only Then the menu opens with Enter, items are reachable with arrow keys, Enter downloads, Esc
  closes and focus returns to `download-menu-btn`.   [verify: e2e, a11y]
AC-19.14 Given phone 390×844 Then the download menu is reachable and all items are tappable (≥ 44px high).   [verify: e2e]
AC-19.15 Given `.md`/HTML-source/PDF actions Then no network request is issued to the backend.   [verify: e2e]
AC-19.16 Given the `.html` export throws (forced) Then an `app-toast` with `data-kind="error"` contains "Download failed", no download occurs and the URL is unchanged.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`download-menu-btn`, `download-menu`, `download-md`, `download-html`, `download-html-source`, `download-pdf`.
No API/MCP changes (optional later: server `GET /paste/:id/raw` — not required).

## Edge cases the adversarial verifier must try
- Doc with an XSS payload in markdown (`<img onerror>` raw HTML): export must not add *our* scripts; author HTML is
  exported as rendered on screen (same trust as viewing) — verify no new script is introduced.
- Mermaid diagram never scrolled into view / mermaid still loading at click time; mermaid syntax error.
- Filename with emoji, leading dot (`.env.md`), very long name (> 200 chars → truncated to 200 + extension).
- Theme switched just before export; split view with unsaved edits; multi-file session file 2 selected.
- Attachment 404, CORS failure, 20 MB image (exceeds cap → URL kept).
- Double-click on `download-html` (one download only, busy state).

## Dependencies on other items (by number) and files likely touched
- #1 (Locus theme CSS), #2/#23 (viewer capability), #4 (routes, pinned revision), #5 (print CSS, `document.title`),
  #14/#15/#17 (chrome to strip), #16 (callout/badge CSS), #10 (attachments), #26 (multi-file sessions).
- Files: new `src/composables/useDownload.ts` (filename rules, blob/anchor, HTML assembly — unit-testable),
  new `src/components/DownloadMenu.vue` (one line in `DocHeader.vue` and the overflow menu), `src/components/DocView.vue`
  (wiring). Preview styles are already in `src/styles/preview.css` (extracted by #1, 00 §4.6); import with `?inline`.
  #28 later makes the `.md` download view-aware (#28 rule 13).
