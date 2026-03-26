# md-review

Review markdown files with Google Docs-style inline comments, then generate structured prompts for any AI agent.

A static SPA that runs entirely in the browser. No backend, no accounts, no tracking.

## Features

- **Upload or paste** markdown files (`.md`, `.markdown`, `.txt`)
- **Edit** with a full CodeMirror 6 editor (syntax highlighting, line numbers)
- **Preview** rendered markdown with proper typography, tables, code blocks, task lists
- **Comment** on any text selection in both edit and preview modes
- **Categorize** comments as Suggestion, Question, Must Fix, or Nit
- **Filter** the comment sidebar by category
- **Edit** comments inline after creation
- **Generate prompts** with all comments + full document, formatted for any LLM
- **Export/Import** comments as `.comments.json` sidecar files
- **Dark mode** with system preference detection
- **Syntax highlighting** in fenced code blocks (highlight.js)
- **Task list** checkbox rendering (`- [x]` / `- [ ]`)
- **Live word & character count**
- **LocalStorage persistence** across browser sessions

## Quick Start

```bash
git clone https://github.com/locus-taxy/share-mds.git
cd share-mds
npm install
npm run dev
```

Open [http://localhost:58747](http://localhost:58747) in your browser.

## Usage

1. **Upload** a markdown file by dragging it onto the page, clicking to browse, or pasting content directly
2. **Switch** between Edit and Preview modes using the toggle in the header
3. **Select text** in either mode to open the comment popover
4. **Choose a category** (Suggestion, Question, Must Fix, Nit) and type your comment
5. **Click "Generate Prompt"** to create a formatted prompt with all your comments
6. **Copy to clipboard** and paste into ChatGPT, Claude, or any other AI tool

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Enter` | Submit comment in popover |
| `Escape` | Cancel editing a comment |

### Export/Import Comments

Use the arrow buttons in the sidebar header to:
- **Export** all comments as `filename.comments.json`
- **Import** a previously exported `.comments.json` file

This lets you save reviews, share them with teammates, or resume later.

## Tech Stack

- [Vue 3](https://vuejs.org/) + TypeScript
- [CodeMirror 6](https://codemirror.net/) for the markdown editor
- [markdown-it](https://github.com/markdown-it/markdown-it) for rendering
- [highlight.js](https://highlightjs.org/) for code block syntax highlighting
- [Vite](https://vitejs.dev/) for build tooling

## Development

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run test         # Run unit tests
npm run test:watch   # Run unit tests in watch mode
npm run test:e2e     # Run Playwright e2e tests (requires dev server)
```

### Running E2E Tests

E2E tests require the dev server to be running:

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run test:e2e
```

### Project Structure

```
src/
├── App.vue                      # Main shell
├── main.ts                      # Entry point
├── style.css                    # Global styles + CSS custom properties
├── types/
│   └── index.ts                 # TypeScript interfaces
├── composables/
│   ├── useComments.ts           # Reactive comment store
│   ├── useMarkdown.ts           # markdown-it + highlight.js setup
│   ├── usePersistence.ts        # LocalStorage + theme persistence
│   └── usePromptGenerator.ts    # Comment → prompt formatting
└── components/
    ├── FileUpload.vue           # Drag-and-drop upload + paste
    ├── HeaderBar.vue            # Top bar with controls
    ├── EditorPane.vue           # CodeMirror wrapper
    ├── PreviewPane.vue          # Rendered markdown view
    ├── CommentsSidebar.vue      # Comment list + filters
    ├── CommentPopover.vue       # Floating comment input
    └── PromptModal.vue          # Generated prompt display
```

## Deployment

md-review is a static SPA. Build and deploy anywhere:

```bash
npm run build
```

The `dist/` folder can be deployed to GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any static file host.

### GitHub Pages

```bash
npm run build
npx gh-pages -d dist
```

### Netlify / Vercel

Point the build command to `npm run build` and the publish directory to `dist`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
