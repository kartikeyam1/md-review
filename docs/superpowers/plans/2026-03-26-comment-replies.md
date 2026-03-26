# Comment Replies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add single-level, plain-text reply threads to review comments across the full stack: data model, paste service API, MCP server, frontend composables, and sidebar UI.

**Architecture:** Replies are embedded as a `Reply[]` array on each `Comment` object. Three new paste service endpoints handle reply CRUD. Three new MCP tools wrap those endpoints. The sidebar gets inline expand/collapse threading. Existing sync/persistence flows carry replies for free since they're embedded.

**Tech Stack:** Vue 3 + TypeScript (frontend), Node.js/HTTP (paste service), `@modelcontextprotocol/sdk` + `zod` (MCP server), Vitest (frontend tests), Node built-in test runner (MCP tests)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/types/index.ts` | Add `Reply` interface, extend `Comment` with `replies` field |
| Modify | `src/composables/useComments.ts` | Add `addReply`, `editReply`, `deleteReply`, ensure `replies` init |
| Modify | `src/composables/useShare.ts` | Add `postReply`, `putReply`, `deleteReplyApi` HTTP methods |
| Modify | `src/composables/useSync.ts` | Add `addReply`, `editReply`, `deleteReply` with local/shared branching |
| Modify | `src/components/CommentsSidebar.vue` | Thread toggle, reply list, reply input, reply edit/delete |
| Modify | `src/App.vue` | Wire reply events from sidebar to sync composable |
| Modify | `/home/ubuntu/paste-service/server.js` | Add 3 reply endpoints (POST/PUT/DELETE) |
| Modify | `/home/ubuntu/paste-service/mcp-server.js` | Add `add_reply`, `edit_reply`, `delete_reply` handlers + tools |
| Modify | `tests/composables/useComments.test.ts` | Tests for reply CRUD operations |
| Modify | `tests/composables/useSync.test.ts` | Tests for reply sync (local + shared mode) |

---

### Task 1: Add Reply type and extend Comment interface

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Add Reply interface and extend Comment**

In `src/types/index.ts`, add the `Reply` interface before the `Comment` interface, and add `replies` to `Comment`:

```typescript
export interface Reply {
  id: string
  body: string
  author?: string
  createdAt: number
}

export interface Comment {
  id: string
  startLine: number
  endLine: number
  selectedText: string
  body: string
  category: CommentCategory
  createdAt: number
  author?: string
  replies: Reply[]
}
```

- [ ] **Step 2: Verify the project compiles**

Run: `cd /home/ubuntu/locus-repos/md-review && npx tsc --noEmit 2>&1 | head -20`

Expected: Compilation errors in files that create `Comment` objects without `replies` — this is expected and will be fixed in subsequent tasks. The type definition itself should be valid.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add Reply interface and replies field to Comment type"
```

---

### Task 2: Add reply CRUD to useComments with tests

**Files:**
- Modify: `tests/composables/useComments.test.ts`
- Modify: `src/composables/useComments.ts`

- [ ] **Step 1: Write failing tests for reply operations**

Append these tests to `tests/composables/useComments.test.ts` inside the existing `describe('useComments', ...)` block, after the last `it(...)`:

```typescript
  it('adds a comment with empty replies array', () => {
    const { comments, addComment } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    expect(comments.value[0].replies).toEqual([])
  })

  it('adds a reply to a comment', () => {
    const { comments, addComment, addReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    const reply = addReply(commentId, { body: 'looks good' })
    expect(comments.value[0].replies).toHaveLength(1)
    expect(comments.value[0].replies[0].body).toBe('looks good')
    expect(comments.value[0].replies[0].id).toBeTruthy()
    expect(comments.value[0].replies[0].createdAt).toBeGreaterThan(0)
    expect(reply.id).toBe(comments.value[0].replies[0].id)
  })

  it('adds a reply with author', () => {
    const { comments, addComment, addReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    addReply(commentId, { body: 'fixed', author: 'claude-code' })
    expect(comments.value[0].replies[0].author).toBe('claude-code')
  })

  it('edits a reply body', () => {
    const { comments, addComment, addReply, editReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    addReply(commentId, { body: 'original' })
    const replyId = comments.value[0].replies[0].id
    editReply(commentId, replyId, 'updated')
    expect(comments.value[0].replies[0].body).toBe('updated')
  })

  it('deletes a reply', () => {
    const { comments, addComment, addReply, deleteReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    addReply(commentId, { body: 'first' })
    addReply(commentId, { body: 'second' })
    expect(comments.value[0].replies).toHaveLength(2)
    const replyId = comments.value[0].replies[0].id
    deleteReply(commentId, replyId)
    expect(comments.value[0].replies).toHaveLength(1)
    expect(comments.value[0].replies[0].body).toBe('second')
  })

  it('loadComments initializes missing replies to empty array', () => {
    const { comments, loadComments } = useComments()
    loadComments([
      { id: 'x', startLine: 0, endLine: 1, selectedText: 'hi', body: 'test', category: 'question', createdAt: 1 } as any,
    ])
    expect(comments.value[0].replies).toEqual([])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run tests/composables/useComments.test.ts 2>&1 | tail -20`

Expected: FAIL — `addReply` is not returned from `useComments()`, `replies` not on Comment objects.

- [ ] **Step 3: Implement reply methods in useComments**

Replace the full content of `src/composables/useComments.ts`:

```typescript
import { computed, ref } from 'vue'
import type { Comment, Reply } from '@/types'

type NewComment = Omit<Comment, 'id' | 'createdAt' | 'replies'>

export function useComments() {
  const _comments = ref<Comment[]>([])

  const comments = computed(() =>
    [..._comments.value].sort((a, b) => a.startLine - b.startLine)
  )

  function addComment(input: NewComment) {
    _comments.value.push({
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      replies: [],
    })
  }

  function editComment(id: string, updates: Partial<Pick<Comment, 'body' | 'category'>>) {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx !== -1) {
      _comments.value[idx] = { ..._comments.value[idx], ...updates }
    }
  }

  function deleteComment(id: string) {
    _comments.value = _comments.value.filter((c) => c.id !== id)
  }

  function clearComments() {
    _comments.value = []
  }

  function loadComments(loaded: Comment[]) {
    _comments.value = loaded.map((c) => ({
      ...c,
      replies: c.replies ?? [],
    }))
  }

  function addReply(commentId: string, input: { body: string; author?: string }): Reply {
    const idx = _comments.value.findIndex((c) => c.id === commentId)
    if (idx === -1) throw new Error(`Comment ${commentId} not found`)
    const reply: Reply = {
      id: crypto.randomUUID(),
      body: input.body,
      createdAt: Date.now(),
      ...(input.author !== undefined && { author: input.author }),
    }
    _comments.value[idx] = {
      ..._comments.value[idx],
      replies: [..._comments.value[idx].replies, reply],
    }
    return reply
  }

  function editReply(commentId: string, replyId: string, body: string) {
    const idx = _comments.value.findIndex((c) => c.id === commentId)
    if (idx === -1) return
    _comments.value[idx] = {
      ..._comments.value[idx],
      replies: _comments.value[idx].replies.map((r) =>
        r.id === replyId ? { ...r, body } : r
      ),
    }
  }

  function deleteReply(commentId: string, replyId: string) {
    const idx = _comments.value.findIndex((c) => c.id === commentId)
    if (idx === -1) return
    _comments.value[idx] = {
      ..._comments.value[idx],
      replies: _comments.value[idx].replies.filter((r) => r.id !== replyId),
    }
  }

  return {
    comments, addComment, editComment, deleteComment,
    clearComments, loadComments,
    addReply, editReply, deleteReply,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run tests/composables/useComments.test.ts 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useComments.ts tests/composables/useComments.test.ts
git commit -m "feat: add reply CRUD to useComments composable"
```

---

### Task 3: Add reply HTTP methods to useShare

**Files:**
- Modify: `src/composables/useShare.ts`

- [ ] **Step 1: Add postReply, putReply, deleteReplyApi**

In `src/composables/useShare.ts`, add these three functions after the `deleteCommentApi` function (after line 127), before the `putMarkdown` function:

```typescript
  async function postReply(pasteId: string, commentId: string, reply: {
    body: string; author?: string
  }): Promise<Reply | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reply),
      })
      if (!res.ok) return null
      return await res.json() as Reply
    } catch { return null }
  }

  async function putReply(pasteId: string, commentId: string, replyId: string, updates: {
    body: string
  }): Promise<Reply | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}/replies/${replyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) return null
      return await res.json() as Reply
    } catch { return null }
  }

  async function deleteReplyApi(pasteId: string, commentId: string, replyId: string): Promise<boolean> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}/replies/${replyId}`, {
        method: 'DELETE',
      })
      return res.status === 204
    } catch { return false }
  }
```

- [ ] **Step 2: Update the import and return statement**

Add `Reply` to the import at the top of the file:

```typescript
import type { Comment, Reply } from '@/types'
```

Add the three new methods to the return object (line ~160):

```typescript
  return {
    sharing, shareError, createShare, loadShare, fetchGithub,
    getShareIdFromHash, setShareHash, getShareUrls,
    postComment, putComment, deleteCommentApi,
    postReply, putReply, deleteReplyApi,
    putMarkdown, pollPaste,
  }
```

- [ ] **Step 3: Verify compilation**

Run: `cd /home/ubuntu/locus-repos/md-review && npx tsc --noEmit 2>&1 | head -20`

Expected: No new errors from this file.

- [ ] **Step 4: Commit**

```bash
git add src/composables/useShare.ts
git commit -m "feat: add reply HTTP methods to useShare composable"
```

---

### Task 4: Add reply sync methods to useSync with tests

**Files:**
- Modify: `tests/composables/useSync.test.ts`
- Modify: `src/composables/useSync.ts`

- [ ] **Step 1: Write failing tests for reply sync**

In `tests/composables/useSync.test.ts`, add mock variables after the existing mocks (after line 10):

```typescript
const mockPostReply = vi.fn()
const mockPutReply = vi.fn()
const mockDeleteReplyApi = vi.fn()
```

Update the `useShare` mock (inside `vi.mock(...)`) to include the new methods:

```typescript
    postReply: mockPostReply,
    putReply: mockPutReply,
    deleteReplyApi: mockDeleteReplyApi,
```

Update the `makeComment` helper to include `replies`:

```typescript
function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1', startLine: 0, endLine: 1, selectedText: 'text',
    body: 'test', category: 'suggestion', createdAt: Date.now(),
    replies: [],
    ...overrides,
  }
}
```

Update `makeLocalOps` to include reply operations:

```typescript
function makeLocalOps(comments: { value: Comment[] }) {
  return {
    addComment: vi.fn((input: any) => {
      comments.value = [...comments.value, { ...input, id: crypto.randomUUID(), createdAt: Date.now(), replies: [] }]
    }),
    editComment: vi.fn((id: string, updates: any) => {
      comments.value = comments.value.map(c => c.id === id ? { ...c, ...updates } : c)
    }),
    deleteComment: vi.fn((id: string) => {
      comments.value = comments.value.filter(c => c.id !== id)
    }),
    loadComments: vi.fn((c: Comment[]) => { comments.value = c }),
    addReply: vi.fn((commentId: string, input: any) => {
      const reply = { id: crypto.randomUUID(), createdAt: Date.now(), ...input }
      comments.value = comments.value.map(c =>
        c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c
      )
      return reply
    }),
    editReply: vi.fn((commentId: string, replyId: string, body: string) => {
      comments.value = comments.value.map(c =>
        c.id === commentId
          ? { ...c, replies: c.replies.map(r => r.id === replyId ? { ...r, body } : r) }
          : c
      )
    }),
    deleteReply: vi.fn((commentId: string, replyId: string) => {
      comments.value = comments.value.map(c =>
        c.id === commentId
          ? { ...c, replies: c.replies.filter(r => r.id !== replyId) }
          : c
      )
    }),
  }
}
```

Append these test cases inside the `describe('useSync', ...)` block:

```typescript
  it('in local mode, addReply delegates to localOps', () => {
    const pasteId = ref<string | null>(null)
    const existing = makeComment({ id: 'c1' })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    const sync = useSync(pasteId, comments, ref(''), ops)

    sync.addReply('c1', { body: 'reply text' })

    expect(ops.addReply).toHaveBeenCalledWith('c1', { body: 'reply text' })
    expect(mockPostReply).not.toHaveBeenCalled()
  })

  it('in shared mode, addReply calls API and updates via loadComments', async () => {
    const pasteId = ref<string | null>('abc123')
    const existing = makeComment({ id: 'c1' })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    const serverReply = { id: 'r1', body: 'reply text', createdAt: Date.now() }
    mockPostReply.mockResolvedValue(serverReply)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addReply('c1', { body: 'reply text' })

    expect(mockPostReply).toHaveBeenCalledWith('abc123', 'c1', { body: 'reply text' })
    expect(ops.loadComments).toHaveBeenCalled()
  })

  it('in shared mode, editReply calls PUT API', async () => {
    const pasteId = ref<string | null>('abc123')
    const reply = { id: 'r1', body: 'original', createdAt: Date.now() }
    const existing = makeComment({ id: 'c1', replies: [reply] })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPutReply.mockResolvedValue({ ...reply, body: 'updated' })

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.editReply('c1', 'r1', 'updated')

    expect(mockPutReply).toHaveBeenCalledWith('abc123', 'c1', 'r1', { body: 'updated' })
  })

  it('in shared mode, deleteReply calls DELETE API', async () => {
    const pasteId = ref<string | null>('abc123')
    const reply = { id: 'r1', body: 'text', createdAt: Date.now() }
    const existing = makeComment({ id: 'c1', replies: [reply] })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockDeleteReplyApi.mockResolvedValue(true)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.deleteReply('c1', 'r1')

    expect(mockDeleteReplyApi).toHaveBeenCalledWith('abc123', 'c1', 'r1')
  })

  it('falls back to local on addReply API failure', async () => {
    const pasteId = ref<string | null>('abc123')
    const existing = makeComment({ id: 'c1' })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPostReply.mockResolvedValue(null)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addReply('c1', { body: 'reply' })

    expect(ops.addReply).toHaveBeenCalledWith('c1', { body: 'reply' })
    expect(sync.syncStatus.value).toBe('error')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run tests/composables/useSync.test.ts 2>&1 | tail -20`

Expected: FAIL — `sync.addReply` is not a function.

- [ ] **Step 3: Implement reply methods in useSync**

In `src/composables/useSync.ts`, update the `localOps` parameter type (add after line 15):

```typescript
    addReply: (commentId: string, input: { body: string; author?: string }) => Reply
    editReply: (commentId: string, replyId: string, body: string) => void
    deleteReply: (commentId: string, replyId: string) => void
```

Add `Reply` to the import:

```typescript
import type { Comment, CommentCategory, Reply } from '@/types'
```

Destructure the new share methods (update line 18):

```typescript
  const { postComment, putComment, deleteCommentApi, postReply, putReply, deleteReplyApi, putMarkdown, pollPaste } = useShare()
```

Add the three reply methods after the `deleteComment` function (after line 74) and before `saveMarkdown`:

```typescript
  async function addReply(commentId: string, input: { body: string; author?: string }) {
    if (!pasteId.value) {
      localOps.addReply(commentId, input)
      return
    }
    const result = await postReply(pasteId.value, commentId, input)
    if (result) {
      localOps.loadComments(comments.value.map(c =>
        c.id === commentId ? { ...c, replies: [...c.replies, result] } : c
      ))
      syncError.value = false
    } else {
      localOps.addReply(commentId, input)
      syncError.value = true
    }
  }

  async function editReply(commentId: string, replyId: string, body: string) {
    if (!pasteId.value) {
      localOps.editReply(commentId, replyId, body)
      return
    }
    const result = await putReply(pasteId.value, commentId, replyId, { body })
    if (result) {
      localOps.loadComments(comments.value.map(c =>
        c.id === commentId
          ? { ...c, replies: c.replies.map(r => r.id === replyId ? result : r) }
          : c
      ))
      syncError.value = false
    } else {
      localOps.editReply(commentId, replyId, body)
      syncError.value = true
    }
  }

  async function deleteReply(commentId: string, replyId: string) {
    if (!pasteId.value) {
      localOps.deleteReply(commentId, replyId)
      return
    }
    const ok = await deleteReplyApi(pasteId.value, commentId, replyId)
    if (ok) {
      localOps.loadComments(comments.value.map(c =>
        c.id === commentId
          ? { ...c, replies: c.replies.filter(r => r.id !== replyId) }
          : c
      ))
      syncError.value = false
    } else {
      localOps.deleteReply(commentId, replyId)
      syncError.value = true
    }
  }
```

Update the return statement to include the new methods:

```typescript
  return { addComment, editComment, deleteComment, addReply, editReply, deleteReply, saveMarkdown, syncStatus, isShared }
```

- [ ] **Step 4: Update App.vue to pass reply operations to useSync**

In `src/App.vue`, update the `useSync` call (lines 29-31) to include reply operations:

```typescript
const sync = useSync(pasteId, comments, markdown, {
  addComment, editComment, deleteComment, loadComments,
  addReply, editReply, deleteReply,
})
```

And update the destructuring of `useComments()` (line 27):

```typescript
const { comments, addComment, editComment, deleteComment, clearComments, loadComments, addReply, editReply, deleteReply } = useComments()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run tests/composables/useSync.test.ts 2>&1 | tail -30`

Expected: All tests PASS.

- [ ] **Step 6: Run all composable tests**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run tests/composables/ 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/composables/useSync.ts src/App.vue tests/composables/useSync.test.ts
git commit -m "feat: add reply sync methods to useSync composable"
```

---

### Task 5: Add reply endpoints to paste service

**Files:**
- Modify: `/home/ubuntu/paste-service/server.js`

- [ ] **Step 1: Add reply route handler**

In `/home/ubuntu/paste-service/server.js`, add a new route block **before** the existing comment route (before line 105). This handles `POST/PUT/DELETE /paste/:id/comments/:commentId/replies[/:replyId]`:

```javascript
  // POST /paste/:id/comments/:commentId/replies — add a reply
  // PUT  /paste/:id/comments/:commentId/replies/:replyId — update a reply
  // DELETE /paste/:id/comments/:commentId/replies/:replyId — remove a reply
  const replyMatch = req.url.match(/^\/paste\/([a-f0-9]+)\/comments\/([a-zA-Z0-9-]+)\/replies(?:\/([a-zA-Z0-9-]+))?$/);
  if (replyMatch && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const [, pasteId, commentId, replyId] = replyMatch;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];
    const comment = data.comments.find(c => c.id === commentId);
    if (!comment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'comment not found' }));
    }
    if (!comment.replies) comment.replies = [];

    if (req.method === 'POST' && !replyId) {
      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }

      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      if (!parsed.body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required field: body' }));
      }

      const reply = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        body: parsed.body,
      };
      if (parsed.author !== undefined) reply.author = parsed.author;

      comment.replies.push(reply);
      savePaste(pasteId, data);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(reply));
    }

    if (req.method === 'PUT' && replyId) {
      const ridx = comment.replies.findIndex(r => r.id === replyId);
      if (ridx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reply not found' }));
      }

      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }

      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      if (parsed.body !== undefined) comment.replies[ridx].body = parsed.body;
      savePaste(pasteId, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(comment.replies[ridx]));
    }

    if (req.method === 'DELETE' && replyId) {
      const ridx = comment.replies.findIndex(r => r.id === replyId);
      if (ridx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reply not found' }));
      }

      comment.replies.splice(ridx, 1);
      savePaste(pasteId, data);

      res.writeHead(204);
      return res.end();
    }
  }
```

- [ ] **Step 2: Manually test the reply endpoints**

Run these curl commands against the running paste service (create a session, add a comment, then test replies):

```bash
# Create a test session
ID=$(curl -s -X POST http://localhost:3100/paste \
  -H 'Content-Type: application/json' \
  -d '{"markdown":"# Test","filename":"test.md","comments":[],"sharedAt":"2026-01-01"}' | jq -r '.id')

# Add a comment
CID=$(curl -s -X POST http://localhost:3100/paste/$ID/comments \
  -H 'Content-Type: application/json' \
  -d '{"startLine":0,"endLine":1,"selectedText":"Test","body":"Fix this","category":"must-fix"}' | jq -r '.id')

# Add a reply
curl -s -X POST http://localhost:3100/paste/$ID/comments/$CID/replies \
  -H 'Content-Type: application/json' \
  -d '{"body":"Done!","author":"claude-code"}' | jq .

# Verify reply is embedded in session
curl -s http://localhost:3100/paste/$ID/comments | jq '.comments[0].replies'
```

Expected: Reply is created with `id`, `body`, `author`, `createdAt`. The GET comments response shows replies embedded in the comment.

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add server.js
git commit -m "feat: add reply CRUD endpoints to paste service"
```

---

### Task 6: Add reply handlers and tools to MCP server

**Files:**
- Modify: `/home/ubuntu/paste-service/mcp-server.js`

- [ ] **Step 1: Add reply handler functions**

In `/home/ubuntu/paste-service/mcp-server.js`, add three handler functions inside the `createHandlers` return object (after the `delete_comment` handler, before `update_markdown`):

```javascript
    async function add_reply({ sessionId, commentId, body, author }) {
      const payload = { body };
      if (author !== undefined) payload.author = author;
      return apiCall(`/paste/${sessionId}/comments/${commentId}/replies`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async function edit_reply({ sessionId, commentId, replyId, body }) {
      return apiCall(`/paste/${sessionId}/comments/${commentId}/replies/${replyId}`, {
        method: 'PUT',
        body: JSON.stringify({ body }),
      });
    },

    async function delete_reply({ sessionId, commentId, replyId }) {
      const result = await apiCall(`/paste/${sessionId}/comments/${commentId}/replies/${replyId}`, {
        method: 'DELETE',
      });
      if (result.error) return result;
      return { ok: true };
    },
```

- [ ] **Step 2: Register the three new MCP tools**

In the `if (import.meta.url === ...)` block, add tool registrations after the `delete_comment` tool registration (after line 181) and before the `update_markdown` tool:

```javascript
  server.registerTool('add_reply', {
    title: 'Add Reply',
    description: 'Reply to an existing comment. Replies are plain text, single-level (no nesting).',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      commentId: z.string().describe('The parent comment ID'),
      body: z.string().describe('The reply text'),
      author: z.string().optional().describe('Agent identifier, e.g. "claude-code"'),
    }),
  }, async (args) => {
    const result = await handlers.add_reply(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('edit_reply', {
    title: 'Edit Reply',
    description: 'Update the body of an existing reply.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      commentId: z.string().describe('The parent comment ID'),
      replyId: z.string().describe('The reply ID'),
      body: z.string().describe('New reply body'),
    }),
  }, async (args) => {
    const result = await handlers.edit_reply(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('delete_reply', {
    title: 'Delete Reply',
    description: 'Remove a reply from a comment.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      commentId: z.string().describe('The parent comment ID'),
      replyId: z.string().describe('The reply ID'),
    }),
  }, async (args) => {
    const result = await handlers.delete_reply(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
```

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add mcp-server.js
git commit -m "feat: add reply tools to MCP server"
```

---

### Task 7: Add reply thread UI to CommentsSidebar

**Files:**
- Modify: `src/components/CommentsSidebar.vue`
- Modify: `src/App.vue`

- [ ] **Step 1: Add reply state and emit types to CommentsSidebar script**

In `src/components/CommentsSidebar.vue`, update the imports (line 3) to include `Reply`:

```typescript
import type { Comment, CommentCategory, Reply } from '@/types'
```

Add new emit types (extend the `defineEmits` block):

```typescript
const emit = defineEmits<{
  delete: [id: string]
  edit: [id: string, updates: { body?: string; category?: CommentCategory }]
  'scroll-to': [line: number]
  'export-comments': []
  'import-comments': []
  'add-reply': [commentId: string, input: { body: string }]
  'edit-reply': [commentId: string, replyId: string, body: string]
  'delete-reply': [commentId: string, replyId: string]
}>()
```

Add reply-related state after the existing state vars (after line 21):

```typescript
const expandedThreads = ref<Set<string>>(new Set())
const replyInputs = ref<Record<string, string>>({})
const editingReplyId = ref<string | null>(null)
const editReplyBody = ref('')
```

Add reply helper functions after the `toggleFilter` function (after line 50):

```typescript
function toggleThread(commentId: string) {
  const s = new Set(expandedThreads.value)
  if (s.has(commentId)) s.delete(commentId)
  else s.add(commentId)
  expandedThreads.value = s
}

function openReplyInput(commentId: string) {
  const s = new Set(expandedThreads.value)
  s.add(commentId)
  expandedThreads.value = s
  if (!replyInputs.value[commentId]) replyInputs.value[commentId] = ''
}

function submitReply(commentId: string) {
  const body = (replyInputs.value[commentId] || '').trim()
  if (!body) return
  emit('add-reply', commentId, { body })
  replyInputs.value[commentId] = ''
}

function startEditReply(reply: Reply) {
  editingReplyId.value = reply.id
  editReplyBody.value = reply.body
}

function saveEditReply(commentId: string, replyId: string) {
  const trimmed = editReplyBody.value.trim()
  if (!trimmed) return
  emit('edit-reply', commentId, replyId, trimmed)
  editingReplyId.value = null
}

function cancelEditReply() {
  editingReplyId.value = null
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
```

- [ ] **Step 2: Add reply thread template**

In the template, add the reply thread section after the `.comment-actions` div (after line 164), but still inside the `v-for` comment card div:

```html
        <!-- Reply thread -->
        <div class="reply-section" @click.stop>
          <button
            v-if="comment.replies.length === 0"
            class="reply-link"
            @click="openReplyInput(comment.id)"
          >
            Reply
          </button>
          <button
            v-else
            class="reply-link"
            @click="toggleThread(comment.id)"
          >
            {{ expandedThreads.has(comment.id) ? '▾' : '▸' }}
            {{ comment.replies.length }} {{ comment.replies.length === 1 ? 'reply' : 'replies' }}
          </button>

          <div v-if="expandedThreads.has(comment.id)" class="reply-thread">
            <div
              v-for="reply in comment.replies"
              :key="reply.id"
              class="reply-item"
            >
              <div class="reply-meta">
                <span v-if="reply.author" class="comment-author">{{ reply.author }}</span>
                <span class="reply-time">{{ formatTimeAgo(reply.createdAt) }}</span>
              </div>
              <div v-if="editingReplyId === reply.id" class="edit-area">
                <textarea
                  v-model="editReplyBody"
                  class="edit-input"
                  rows="2"
                  @keydown.enter.meta="saveEditReply(comment.id, reply.id)"
                  @keydown.enter.ctrl="saveEditReply(comment.id, reply.id)"
                  @keydown.escape="cancelEditReply"
                />
                <div class="edit-actions">
                  <button class="btn btn-ghost btn-xs" @click="cancelEditReply">Cancel</button>
                  <button class="btn btn-primary btn-xs" @click="saveEditReply(comment.id, reply.id)">Save</button>
                </div>
              </div>
              <div v-else class="reply-body" @dblclick.stop="startEditReply(reply)">{{ reply.body }}</div>
              <div class="reply-actions">
                <button class="comment-action-btn" @click.stop="startEditReply(reply)">Edit</button>
                <button class="comment-action-btn" @click.stop="emit('delete-reply', comment.id, reply.id)">Delete</button>
              </div>
            </div>

            <div class="reply-input-row">
              <input
                v-model="replyInputs[comment.id]"
                class="reply-input"
                placeholder="Write a reply..."
                @keydown.enter.exact="submitReply(comment.id)"
                @keydown.escape="toggleThread(comment.id)"
              />
              <button class="reply-send-btn" @click="submitReply(comment.id)">Send</button>
            </div>
          </div>
        </div>
```

- [ ] **Step 3: Add reply styles**

Append these styles inside the `<style scoped>` block:

```css
.reply-section {
  margin-top: 6px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}

.reply-link {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-body);
}

.reply-link:hover {
  color: var(--accent);
}

.reply-thread {
  margin-top: 6px;
}

.reply-item {
  margin-left: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.reply-item:last-of-type {
  border-bottom: none;
}

.reply-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.reply-time {
  font-size: 10px;
  color: var(--text-muted);
}

.reply-body {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.4;
}

.reply-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.reply-item:hover .reply-actions {
  opacity: 1;
}

.reply-input-row {
  display: flex;
  gap: 6px;
  margin-left: 12px;
  margin-top: 6px;
}

.reply-input {
  flex: 1;
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: var(--font-body);
  color: var(--text-primary);
}

.reply-input:focus {
  outline: none;
  border-color: var(--text-muted);
}

.reply-send-btn {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: var(--font-body);
  color: var(--text-primary);
  cursor: pointer;
}

.reply-send-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 4: Wire reply events in App.vue**

In `src/App.vue`, update the `<CommentsSidebar>` template (lines 347-355) to include the reply event handlers:

```html
      <CommentsSidebar
        v-show="!sidebarHidden"
        :comments="comments"
        @delete="sync.deleteComment"
        @edit="sync.editComment"
        @scroll-to="handleScrollTo"
        @export-comments="handleExportComments"
        @import-comments="handleImportComments"
        @add-reply="sync.addReply"
        @edit-reply="sync.editReply"
        @delete-reply="sync.deleteReply"
      />
```

- [ ] **Step 5: Verify the app compiles and renders**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vite build 2>&1 | tail -10`

Expected: Build succeeds with no errors.

- [ ] **Step 6: Run all tests**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/CommentsSidebar.vue src/App.vue
git commit -m "feat: add reply thread UI to comments sidebar"
```

---

### Task 8: Backwards compatibility for import/export

**Files:**
- Modify: `src/App.vue`

- [ ] **Step 1: Update handleImportComments to initialize missing replies**

In `src/App.vue`, update the `handleImportComments` function. After the `imported` variable is validated (line 278-280), add `replies` initialization before calling `loadComments`:

```typescript
        const normalized = imported.map((c: any) => ({
          ...c,
          replies: Array.isArray(c.replies) ? c.replies : [],
        }))
        loadComments(normalized)
```

Replace the existing `loadComments(imported)` call (line 282) with the above.

- [ ] **Step 2: Verify export includes replies**

No code change needed — `handleExportComments` already serializes the full `comments.value` array which now includes `replies`. Verify mentally that the export path works.

- [ ] **Step 3: Commit**

```bash
git add src/App.vue
git commit -m "fix: normalize imported comments to include replies array"
```

---

### Task 9: Final integration verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vitest run 2>&1`

Expected: All tests PASS.

- [ ] **Step 2: Build production bundle**

Run: `cd /home/ubuntu/locus-repos/md-review && npx vite build 2>&1`

Expected: Build succeeds.

- [ ] **Step 3: Verify type checking**

Run: `cd /home/ubuntu/locus-repos/md-review && npx tsc --noEmit 2>&1`

Expected: No type errors.

- [ ] **Step 4: Manual smoke test**

Open the app in a browser, load a markdown file, add a comment, then:
1. Click "Reply" on a comment with no replies
2. Type a reply and press Enter — verify it appears
3. Click "1 reply" to collapse, click again to expand
4. Double-click a reply to edit it
5. Hover a reply and click Delete
6. Export comments as JSON — verify replies are included
7. Import the JSON back — verify replies survive

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: integration fixups for comment replies"
```
