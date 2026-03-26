# Comment Replies — Design Spec

Single-level, plain-text replies on review comments. Wired across data model, paste service API, MCP server, and sidebar UI.

## Decisions

- **Threading depth:** single-level only (no reply-to-reply)
- **Reply content:** plain text, no categories
- **Storage model:** replies embedded in parent comment as `Reply[]`
- **MCP approach:** separate `add_reply` / `edit_reply` / `delete_reply` tools
- **Sync:** replies travel with parent comment through existing poll cycle
- **UI pattern:** inline expand/collapse in sidebar, collapsed by default

## Data Model

### New `Reply` interface

```typescript
export interface Reply {
  id: string        // UUID, server-generated in shared mode, client-generated in local mode
  body: string      // Plain text
  author?: string   // Optional agent identifier (e.g., "claude-code")
  createdAt: number // Date.now()
}
```

### Extended `Comment` interface

```typescript
export interface Comment {
  id: string
  startLine: number
  endLine: number
  selectedText: string
  body: string
  category: 'suggestion' | 'question' | 'must-fix' | 'nit'
  createdAt: number
  author?: string
  replies: Reply[]  // New field. Default: []
}
```

### Backwards compatibility

Any comment loaded without a `replies` field gets initialized to `[]`. Applies to:
- localStorage deserialization in `usePersistence`
- Server responses in `useSync`
- JSON import in `CommentsSidebar`

## API Layer

### New paste service endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/paste/:id/comments/:commentId/replies` | `{ body, author? }` | `{ id, body, author, createdAt }` |
| `PUT` | `/paste/:id/comments/:commentId/replies/:replyId` | `{ body }` | Updated reply object |
| `DELETE` | `/paste/:id/comments/:commentId/replies/:replyId` | — | `{ ok: true }` |

### Server behavior

- `POST`: Generate UUID + `createdAt`, push to parent comment's `replies` array, write session JSON, return reply.
- `PUT`: Find reply in parent's `replies` array, update `body`, write session JSON, return reply.
- `DELETE`: Splice reply from parent's `replies` array, write session JSON, return `{ ok: true }`.
- All three return 404 `{ error: "..." }` if parent comment or reply not found.
- Deleting a parent comment via `DELETE /paste/:id/comments/:commentId` automatically removes all embedded replies.

### `useShare` composable additions

```typescript
postReply(pasteId: string, commentId: string, reply: { body: string; author?: string }): Promise<Reply>
putReply(pasteId: string, commentId: string, replyId: string, updates: { body: string }): Promise<Reply>
deleteReplyApi(pasteId: string, commentId: string, replyId: string): Promise<{ ok: true }>
```

Same patterns as existing `postComment` / `putComment` / `deleteCommentApi`.

## MCP Server

### New tools

**`add_reply`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | yes | Session ID |
| `commentId` | string | yes | Parent comment ID |
| `body` | string | yes | Reply text |
| `author` | string | no | Agent identifier |

Returns full `Reply` object.

**`edit_reply`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | yes | Session ID |
| `commentId` | string | yes | Parent comment ID |
| `replyId` | string | yes | Reply ID |
| `body` | string | yes | New body text |

Returns updated reply object.

**`delete_reply`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | yes | Session ID |
| `commentId` | string | yes | Parent comment ID |
| `replyId` | string | yes | Reply ID |

Returns `{ ok: true }`.

### Existing tools — no changes

- `list_comments` — replies embedded in comment objects, returned automatically
- `delete_comment` — embedded replies deleted with parent, no special handling
- `add_comment` / `edit_comment` — unchanged

## UI Components

### CommentsSidebar.vue

**Thread toggle:**
- Comments with 0 replies: show a "Reply" text link below the comment body
- Comments with 1+ replies: show "▸ N replies" (collapsed) / "▾ N replies" (expanded)
- Clicking toggles the thread open/closed
- Collapsed by default

**Expanded thread view:**
- Replies render below the parent, indented, separated by a subtle border
- Each reply shows: author label (if present), relative timestamp, body text
- Reply input at the bottom: text input + Send button
- Submit on Enter key, collapse on Escape

**Reply editing:**
- Double-click reply body to enter edit mode (same pattern as comment editing)
- Delete button appears on hover (same pattern as comments)

**Reactive updates:**
- Reply count updates when replies are added/deleted
- Thread stays expanded after adding a reply

### useComments.ts additions

```typescript
addReply(commentId: string, reply: Omit<Reply, 'id' | 'createdAt'>): Reply
editReply(commentId: string, replyId: string, body: string): void
deleteReply(commentId: string, replyId: string): void
```

In local mode, `addReply` generates `id` (UUID) and `createdAt` client-side. In shared mode, `useSync` calls the API instead and uses the server-generated values.

### useSync.ts additions

```typescript
addReply(commentId: string, reply: { body: string; author?: string }): Promise<void>
editReply(commentId: string, replyId: string, body: string): Promise<void>
deleteReply(commentId: string, replyId: string): Promise<void>
```

In shared mode, each calls the corresponding `useShare` method, then reloads comments from the response. In local mode (no `pasteId`), each delegates directly to the `useComments` method — same branching pattern as existing `addComment` / `editComment` / `deleteComment` in `useSync`.

### No changes to

- `EditorPane.vue` — comment decorations unaffected by replies
- `PreviewPane.vue` — highlight logic unaffected
- `SelectionActionBar.vue` — only creates top-level comments
- `CommentPopover.vue` — only creates top-level comments

## Persistence & Sync

- **localStorage:** No changes. `usePersistence` serializes the full comment array; embedded replies come along automatically.
- **Polling:** No changes. The 5-second poll fetches the full session; embedded replies are included in comment objects.
- **Export/import:** Replies included in JSON export. Import initializes missing `replies: []` for backwards compatibility with old exports.

## Error Handling

- Reply to nonexistent comment: API returns 404, UI shows sync error indicator (existing pattern)
- Edit/delete nonexistent reply: API returns 404, same error handling
- Network failure during reply: falls back to local state, next successful poll re-syncs (existing pattern)
