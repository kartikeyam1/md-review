# md-review

Review markdown **and HTML** files with Google Docs-style inline comments, then generate structured prompts for any AI agent.

A static SPA that runs entirely in the browser. No backend, no accounts, no tracking.

## Features

- **Upload or paste** markdown (`.md`, `.markdown`, `.txt`) or HTML (`.html`, `.htm`) files — the type is auto-detected from the extension or the pasted content
- **Edit** with a full CodeMirror 6 editor (Markdown or HTML syntax highlighting, line numbers)
- **Preview** rendered markdown with proper typography, tables, code blocks, task lists — or a faithful, **sandboxed render of full HTML documents** (their styles/scripts are isolated from the review app)
- **Comment** on any text selection in both edit and preview modes — for HTML, preview selections are anchored back to source lines
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
git clone https://github.com/kartikeyam1/md-review.git
cd md-review
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

The shared-session suites (`tests/e2e/shared-mode.test.mjs`, `durable-sync.test.mjs`,
`qa-gate-features.test.mjs`) also need the paste backend. Run it against a throwaway
data directory so tests never touch real sessions, and point both the dev server and
the tests at it:

```bash
# Terminal 1 — backend on a test port with its own data dir
cd server && PORT=3111 DATA_DIR=/tmp/md-review-test-data node server.cjs

# Terminal 2 — frontend that talks to that backend
VITE_PASTE_API_URL=http://localhost:3111 npm run dev

# Terminal 3
PASTE_API=http://localhost:3111 node --test tests/e2e/durable-sync.test.mjs
PASTE_API=http://localhost:3111 node --test server/test.mjs          # backend API tests
```

## Shared sessions: autosave and conflicts

When a document is shared (`#shared=<id>`), the browser keeps it in sync with the
paste backend and the header shows the state: **Saved**, **Unsaved changes**,
**Saving…**, **Save failed**, or **Conflict**.

- **Autosave.** Edits are written to the server ~2 s after you stop typing, and
  immediately when you switch from Edit to Preview, before a comment is added (so
  its line anchors match what the server holds), when the tab is hidden or closed,
  and on `Ctrl/Cmd + S`. The Save button is a manual trigger, not a requirement.
- **Never clobbered by polling.** The 5-second poll only replaces your text when you
  have no unsaved edits. Comments added by you or by an agent no longer reset the
  document to the server copy.
- **Conflicts are explicit.** Every save carries `If-Match: <content_hash>`. If the
  server copy changed under you (an agent rewrote the file, another reviewer edited),
  the save is refused, your text is kept, and a bar offers **Use server version** or
  **Keep my version**. The same happens when a poll notices the server moved while
  you had unsaved edits.
- **Drafts survive a reload.** Unsaved edits are kept in this browser (IndexedDB, with
  a localStorage fallback — so multi-megabyte HTML reviews are covered too) together
  with the server copy they were based on. Reloading the page restores them (and flags
  a conflict if the server has since moved on). If the browser refuses to store the
  draft, a warning bar says so instead of failing silently. Closing the tab with
  unsaved edits prompts first.
- **Autosave sends only what changed.** When the server's `content_hash` is known,
  a save carries the changed span (`delta`) instead of the whole document, guarded by
  `If-Match` so it can only ever apply to the exact base it was computed from. If the
  server ignores or refuses the delta, the full document is sent instead.
- **Signed comments.** Set your name once in the header (👤). Comments, replies,
  resolves and approvals made in this browser carry it as `author` / `resolved_by`,
  alongside the names agents already use.
- **Revision history & "what changed since I last looked".** Every content change is
  kept as a revision (who, when, content hash); consecutive writes by the same author
  within a few minutes fold into one. Open **History** in the header to compare any two
  versions (line diff with word-level highlighting) or restore an earlier one as unsaved
  edits. When the document changes while you are away — an agent revises it, another
  reviewer edits — a banner says how many changes and by whom, and jumps you to the diff
  from the exact version you last acknowledged. The browser remembers what you
  acknowledged per session, so a reload never loses your place.
- **Comment changes queue when offline.** A comment add/edit/delete/reply/resolve
  that fails is kept locally, shown as *Offline · n pending*, and retried on every
  poll. Polls never wipe queued changes.
- **Opening another file detaches.** Loading a local file, a paste, or a GitHub URL
  while a shared session is open leaves that session first (with a prompt if you
  have unsaved edits), so the old session is never overwritten with the new file.

### Backend API notes (`server/server.cjs`)

- `PUT /paste/:id/markdown` accepts `If-Match: <content_hash>` (or `base_hash` in the
  body). A stale hash returns **412** with the current `content_hash` and `markdown`.
  Successful writes return `{ ok, content_hash, filename }` and an `ETag`.
- `{ delta: { keepStart, keepEnd, insert } }` replaces `base[keepStart .. len-keepEnd)`
  with `insert`. It **requires** `If-Match`/`base_hash` (400 otherwise) and returns
  **409** if it does not fit the current content. Clients detect a server without
  delta support by the missing `content_hash` in the 200 response and resend in full.
- Every handler runs under a crash guard: a failing request (or a corrupt session file
  on disk) returns a JSON 4xx/5xx instead of killing the process. Unparseable session
  metadata reads as 404; an unreadable content file is a 500, never empty content.
- `{ patch: "<unified diff>" }` is validated: removed/context lines must match the
  document, otherwise **409** and nothing is written (previously a mismatching patch
  was applied blindly).
- Request bodies are read before session state is loaded, so two overlapping writes
  can no longer drop each other's changes (a slow agent `PUT` used to erase a comment
  posted meanwhile). All files are written atomically (temp file + rename).
- MCP tools `update_markdown` / `patch_markdown` take an optional
  `expectedContentHash` that maps to `If-Match`; the `content_hash` comes from
  `get_session`.
- Revision history: `GET /paste/:id/revisions` lists revisions (oldest first);
  `GET /paste/:id/revisions/:hash` (or `.../current`) returns one version's content
  (410 if no longer stored). Writes attribute an author via the `author` body field and
  a client via the `X-MdReview-Client` header (`ui`/`mcp`/`api`); content is only
  re-stored when it actually changed, so comment edits don't create revisions. Retention
  is `REVISIONS_MAX` (default 100); coalescing window is `REVISION_COALESCE_MS`
  (default 5 min). MCP tools `list_revisions` / `get_revision` expose this to agents, and
  the write tools take an optional `author`.
- The HTTP MCP server (`server/mcp-server-http.js`) expires idle sessions
  (`MCP_SESSION_TTL_MS`, default 30 min, swept every `MCP_SWEEP_INTERVAL_MS`) and caps
  them (`MCP_MAX_SESSIONS`, default 200). Before this, sessions were only dropped when a
  client sent a close — most never do — and the process eventually died of V8 OOM.
  `GET /health` reports `sessions: { active, evicted }`.
- Deploy order matters: the backend must run the new code before the frontend is
  deployed, because the browser now sends `If-Match` and the old backend's CORS
  preflight rejects that header (saves would fail).

### Bundle

Mermaid is loaded on demand (only documents containing a diagram fetch it) and
highlight.js ships as core plus a curated language set instead of every language.
Unknown fence languages render as plain code; add one in `useMarkdown.ts` if needed.

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
│   ├── usePersistence.ts        # LocalStorage (incl. unsaved-draft recovery) + theme persistence
│   ├── useShare.ts              # Paste-backend HTTP client (ETag/If-Match aware)
│   ├── useSync.ts               # Shared-session sync: autosave, conflicts, retry outbox
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
