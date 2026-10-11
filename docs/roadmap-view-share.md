# md-review → view & share: product backlog

Agreed 2026-10-10. Security hardening is deliberately deprioritised (tracked separately).

## Brand decisions (Locus theme)
- Button text on purple: `#280A38` (contrast), not white.
- Dark-mode table header: `#533B60` + white text.
- Code font stays JetBrains Mono; comment-highlight keeps its 2px stripe (review UI only).

## Branch 1 — reader + editor (FE)
| # | Feature | Notes |
|---|---|---|
| 1 | Locus theme (light/dark) | `locus-theme` class + tokens, Montserrat, mermaid `base` theme w/ chart series, switcher = light/dark toggle + Style menu |
| 2 | Reading mode by default | editor/comments/approval hidden for readers; review mode per doc |
| 3 | Sticky TOC + copy-link per heading | needs path routes so `#heading` stops clobbering `#shared=` |
| 4 | Path-based routes | `/d/:slug`, `/d/:slug#heading` |
| 5 | Mobile layout, print CSS, `document.title` from doc | no `@media` exists today |
| 6 | Lazy-load the editor | CodeMirror currently ships to every reader (`App.vue:15`) |
| 7 | Side-by-side edit + preview, synced scroll | line attrs already emitted (`useMarkdown.ts:95`) |
| 8 | Undo/redo fix | **root cause:** `EditorPane.vue:182` has no `history()` extension or `historyKeymap`, so Ctrl/Cmd+Z does nothing; also the `modelValue` watcher replaces the whole doc on every external sync — should apply a minimal diff with `addToHistory: false` and keep the cursor |
| 9 | Markdown shortcuts | Ctrl+B/I/K, list continuation, Tab indent, Alt+↑/↓ move line |
| 10 | Paste/drop image → upload as attachment + insert `![](…)` | uses existing `/paste/:id/files` |
| 11 | Format a pasted table | TSV/CSV from sheets → markdown table |
| 12 | Slash menu | `/table`, `/mermaid`, `/callout`, `/rag`, `/code`, `/toc` |
| 13 | Focus mode | full-width, chrome hidden |
| 14 | Copy button + language label on code blocks | |
| 15 | Full-screen zoom/pan for mermaid + images | phone readability |
| 16 | Callouts | `> [!NOTE] / [!TIP] / [!WARNING] / [!IMPORTANT] / [!CAUTION]` |
| 17 | Collapsible sections (GitHub-style) | fold by heading + `<details>`; collapse/expand all |
| 18 | Font size + width control | A−/A+, narrow/wide, remembered per reader |
| 19 | Download `.md` / self-contained `.html` / PDF (print) | only comments JSON today |

## Branch 2 — backend
| # | Feature | Notes |
|---|---|---|
| 20 | SQLite + FTS5 | unblocks search, view counts, reactions, named readers |
| 21 | MCP `upsert(key)` | stable URL per recurring doc, each run = new revision |
| 22 | `/d/:slug` server-rendered OG/meta + cover image | Slack unfurls; GitHub Pages can't |
| 23 | View link vs edit link + expiry picker | FE share dialog + BE tokens |
| 24 | Reactions | per doc + per section |
| 25 | View counts + named readers | |

## Branch 3 — library + AI-native
| # | Feature | Notes |
|---|---|---|
| 26 | Library dashboard | collections, tags, pins, search, multi-file sessions in UI |
| 27 | Save as template / new from template | weekly update, design doc, QA findings |
| 28 | Human view vs agent view of one doc | twofold-style markers; `/agent` serves full evidence |
| 29 | `?view=slides` | each H2 = slide |
