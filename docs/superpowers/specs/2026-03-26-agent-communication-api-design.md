# Agent Communication API — Design Spec

## Overview

Extend the existing paste service (`/home/ubuntu/paste-service/server.js`) with mutable comment and markdown endpoints so that external agents (CI bots, Claude Code, scripts) and the md-review frontend can collaborate on review sessions in real time.

The paste service is already the backend for sharing. This design adds:
1. Comment-level CRUD endpoints
2. Markdown update endpoint
3. ETag-based polling for frontend sync
4. A `useSync` composable in the frontend for shared-mode behavior

**Future extension:** An MCP server wrapping these endpoints for native agent tool-call integration.

---

## Paste Service: New Endpoints

All endpoints operate on the existing JSON files in `data/`. Single-process Node.js with synchronous file I/O — no race conditions.

### Comment CRUD

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `POST` | `/paste/:id/comments` | `{ startLine, endLine, selectedText, body, category, author? }` | `201` + full comment object (server adds `id`, `createdAt`) |
| `PUT` | `/paste/:id/comments/:commentId` | Partial: `{ body?, category? }` | `200` + updated comment |
| `DELETE` | `/paste/:id/comments/:commentId` | — | `204` |

- `author` is optional. Agents should set it (e.g. `"claude-code"`, `"ci-lint"`). The UI omits it for human comments.
- `id` is generated server-side via `crypto.randomUUID()`.
- `createdAt` is `Date.now()`.

### Markdown Update

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `PUT` | `/paste/:id/markdown` | `{ markdown, filename? }` | `200` + `{ ok: true }` |

- `filename` is optional — if omitted, the existing filename is preserved.

### ETag Support

All `GET /paste/:id*` responses include an `ETag` header — a hash of the JSON file content (e.g. MD5 hex of the file bytes).

If the request includes `If-None-Match` matching the current ETag, the server returns `304 Not Modified` with no body.

### CORS Update

The existing CORS headers need to allow:
- Methods: `GET, POST, PUT, DELETE, OPTIONS`
- Headers: `Content-Type, If-None-Match`
- Exposed headers: `ETag`

### Error Cases

- Paste not found: `404 { error: "not found" }`
- Comment not found: `404 { error: "comment not found" }`
- Invalid JSON body: `400 { error: "Invalid JSON" }`
- Missing required fields on POST comment: `400 { error: "Missing required fields" }`

---

## Data Model

The paste JSON file structure is unchanged. The only addition is an optional `author` field on comments:

```json
{
  "markdown": "...",
  "filename": "...",
  "sharedAt": "...",
  "comments": [
    {
      "id": "uuid",
      "startLine": 0,
      "endLine": 5,
      "selectedText": "...",
      "body": "...",
      "category": "suggestion",
      "createdAt": 1711440000000,
      "author": "claude-code"
    }
  ]
}
```

- `author` is `null`/absent for human comments, a string for agent comments.
- No schema migration needed — existing pastes without `author` continue to work.

---

## Frontend: Shared Mode Sync

### Two Modes

1. **Local mode** (no share ID) — current behavior unchanged. Comments in local state + localStorage.
2. **Shared mode** (URL has `#shared=<id>`) — comments and markdown synced through the paste service.

### Shared Mode Behavior

**Comments:** Every local action immediately hits the API:
- Add comment → `POST /paste/:id/comments` → update local state from response
- Edit comment → `PUT /paste/:id/comments/:commentId` → update local state from response
- Delete comment → `DELETE /paste/:id/comments/:commentId` → remove from local state

**Markdown editing:**
- Opens in **preview mode** by default (not edit)
- Edit tab acts as a **draft** — edits are local only until saved
- A **"Save" button** appears in the header bar when there are unsaved markdown changes
- Save calls `PUT /paste/:id/markdown` and syncs
- Switching to preview without saving discards local edits (next poll restores server state)

**Polling:**
- `GET /paste/:id` with `If-None-Match` every 5 seconds
- On `200`: replace local comments and markdown with server state, store new ETag
- On `304`: no-op
- On error: skip, retry next interval

**Error handling:** If an API call fails (network), fall back to local-only and show a brief indicator. Next successful poll re-syncs.

### useSync Composable

`useSync(pasteId: Ref<string | null>)` wraps the sync logic:

- When `pasteId` is set, starts polling and routes comment mutations through the API
- When `pasteId` is null, does nothing (local mode)
- Exposes: `addComment`, `editComment`, `deleteComment`, `saveMarkdown`, `syncStatus`
- The rest of the app calls the same functions regardless of mode — `useSync` decides whether to hit the API or just mutate local state

### Header Bar Indicators

In shared mode:
- A sync status indicator (dot/icon) showing the session is live
- "Save" button visible only in edit tab when unsaved markdown changes exist

### Author Display

The comments sidebar shows the `author` field when present — a small label like "claude-code" or "ci-bot" on the comment card. Human comments (no author) show nothing extra.

---

## Agent Developer Experience

No SDK needed. Any HTTP client works:

```bash
# Create a session
curl -X POST http://localhost:3100/paste \
  -H 'Content-Type: application/json' \
  -d '{"markdown": "# Doc\n\nContent", "filename": "doc.md", "comments": [], "sharedAt": "2026-03-26T00:00:00Z"}'
# → {"id": "a1b2c3d4e5f6"}

# Add a comment
curl -X POST http://localhost:3100/paste/a1b2c3d4e5f6/comments \
  -H 'Content-Type: application/json' \
  -d '{"startLine": 2, "endLine": 3, "selectedText": "Content", "body": "Needs more detail", "category": "suggestion", "author": "claude-code"}'

# Human opens: https://<host>/#shared=a1b2c3d4e5f6
```

---

## Testing

### Paste Service

A test file `test.mjs` alongside `server.js` using Node's built-in test runner:

- CRUD: add comment, edit comment, delete comment, update markdown
- ETag: GET → GET with `If-None-Match` → verify `304`
- Errors: nonexistent paste, nonexistent comment, invalid JSON, missing required fields

### Frontend

- **Unit:** `useSync` composable — mock fetch, verify correct endpoints called, state updated
- **E2E:** Load shared session, add comment via direct fetch to paste service, wait for poll, assert comment appears in UI

---

## Scope Boundaries

**In scope:**
- Paste service endpoint additions
- ETag support
- Frontend `useSync` composable
- Shared mode UI behavior (preview default, save button, sync indicator, author display)
- Tests for both

**Out of scope (future):**
- MCP server wrapping the API
- WebSocket/SSE upgrade (replace polling)
- Authentication / per-paste tokens
- Conflict resolution beyond "server wins"
