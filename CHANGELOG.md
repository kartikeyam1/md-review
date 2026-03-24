# Changelog

All notable changes to this project will be documented in this file.

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
