# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **HTML file support** — upload, paste, load-from-GitHub, and share `.html`/`.htm` documents in addition to Markdown
  - Content type is auto-detected from the filename extension, or sniffed from pasted content
  - HTML documents render faithfully in a sandboxed `<iframe>` (`allow-scripts` only, opaque origin) so their styles and scripts are fully isolated from the review app
  - Comment on HTML in both the source editor (line-based) and the rendered preview — preview text selections are mapped back to source lines
  - Editor switches to HTML syntax highlighting (`@codemirror/lang-html`) for HTML documents
  - `contentType` is persisted with shared sessions and localStorage, and accepted by the MCP server (`create_session`, `create_via_shell`) and CLI (`--content-type`)

### Fixed
- HTML preview: in-page anchor links (a table of contents, `href="#section"`) now scroll within the preview instead of reloading the app inside the sandbox. The document is loaded from a Blob object URL (which has its own base URL) rather than `srcdoc`, so fragment links resolve as native same-document navigations and `:target` CSS works.

### Changed
- HTML preview: theme-aware documents (e.g. claude.ai artifacts that ship `[data-theme]` CSS) now follow the app's dark/light toggle. The app forwards the resolved theme into the iframe and the injected bridge stamps `data-theme` on the document root. Single-theme documents render exactly as authored.

## [0.1.0] - 2026-03-24

### Added
- Upload markdown files via drag-and-drop, file picker, or paste
- Start with a blank document
- CodeMirror 6 editor with markdown syntax highlighting
- Rendered markdown preview with markdown-it
- Inline commenting in both edit and preview modes
- Comment categories: Suggestion, Question, Must Fix, Nit
- Comment filtering by category in the sidebar
- Inline comment editing (double-click or Edit button)
- Prompt generation with line-referenced comments + full document
- Copy prompt to clipboard
- Export/Import comments as JSON sidecar files
- Dark mode with system preference detection
- LocalStorage persistence for document and comments
- Syntax highlighting in fenced code blocks (highlight.js)
- Task list checkbox rendering
- Live word and character count
- Styled headings (h1-h6), tables, blockquotes, code blocks, images
- Viewport-aware comment popover positioning
- Dev server file loading via `?filePath=` URL parameter
- Unit tests (Vitest) and E2E tests (Playwright)
