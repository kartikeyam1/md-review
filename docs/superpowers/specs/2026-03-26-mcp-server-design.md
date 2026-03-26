# MCP Server for md-review — Design Spec

## Overview

A stdio-based MCP server that wraps the paste service HTTP API, enabling Claude Code and other MCP-capable agents to create review sessions, manage comments, and update markdown through native tool calls.

The MCP server is a stateless proxy — every tool call translates to one HTTP request against the paste service. It has no direct file access; it goes through the API like any other client.

```
Claude Code  ──stdio──>  mcp-server.js  ──HTTP──>  paste-service (port 3100)
                                                         │
                                                    data/*.json
```

---

## Configuration

The MCP server reads two environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PASTE_API_URL` | `http://localhost:3100` | Paste service base URL |
| `FRONTEND_URL` | `http://localhost:58747` | Frontend URL for constructing share links |

Registered in `~/.mcp.json`:

```json
{
  "mcpServers": {
    "md-review": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/ubuntu/paste-service/mcp-server.js"],
      "env": {
        "PASTE_API_URL": "http://localhost:3100",
        "FRONTEND_URL": "http://localhost:58747"
      }
    }
  }
}
```

---

## Tools

### `create_session`

Create a new review session from markdown content.

**Parameters:**
- `markdown` (string, required) — the markdown content
- `filename` (string, required) — display name for the file
- `comments` (array, optional, default `[]`) — pre-existing comments

**Returns:** `{ id: string, shareUrl: string }`

The server auto-generates `sharedAt` (current ISO timestamp). `shareUrl` is `{FRONTEND_URL}/#shared={id}`.

Maps to: `POST /paste`

### `get_session`

Get a session's full state.

**Parameters:**
- `sessionId` (string, required)

**Returns:** `{ markdown, filename, comments, sharedAt, shareUrl }`

`shareUrl` is appended by the MCP server (not from the paste service response).

Maps to: `GET /paste/:id`

### `list_comments`

Get just the comments for a session.

**Parameters:**
- `sessionId` (string, required)

**Returns:** `{ filename, comments }`

Maps to: `GET /paste/:id/comments`

### `add_comment`

Add a comment to a specific line range.

**Parameters:**
- `sessionId` (string, required)
- `startLine` (number, required) — 0-indexed line start
- `endLine` (number, required) — 0-indexed line end
- `selectedText` (string, required) — the text being commented on
- `body` (string, required) — the comment content
- `category` (string, required, enum: `suggestion` | `question` | `must-fix` | `nit`)
- `author` (string, optional) — agent identifier, e.g. `"claude-code"`

**Returns:** Full comment object with server-generated `id` and `createdAt`.

Maps to: `POST /paste/:id/comments`

### `edit_comment`

Update a comment's body or category.

**Parameters:**
- `sessionId` (string, required)
- `commentId` (string, required)
- `body` (string, optional) — new comment body
- `category` (string, optional, enum: `suggestion` | `question` | `must-fix` | `nit`)

At least one of `body` or `category` must be provided.

**Returns:** Updated comment object.

Maps to: `PUT /paste/:id/comments/:commentId`

### `delete_comment`

Remove a comment.

**Parameters:**
- `sessionId` (string, required)
- `commentId` (string, required)

**Returns:** `{ ok: true }`

Maps to: `DELETE /paste/:id/comments/:commentId`

### `update_markdown`

Update the markdown content of a session.

**Parameters:**
- `sessionId` (string, required)
- `markdown` (string, required) — new markdown content
- `filename` (string, optional) — new filename (preserved if omitted)

**Returns:** `{ ok: true }`

Maps to: `PUT /paste/:id/markdown`

---

## Resource

### `session://{id}`

An MCP resource that returns the full session JSON for a given session ID.

- URI template: `session://{id}`
- MIME type: `application/json`
- Content: Full paste JSON (`{ markdown, filename, comments, sharedAt }`)

This provides an alternative to the `get_session` tool for agents that prefer reading resources over calling tools.

---

## Error Handling

All tools follow the same error pattern:

- **Paste service unreachable:** Return `{ error: "Could not reach paste service at {PASTE_API_URL}" }`
- **Paste/comment not found (404):** Return `{ error: "Session not found" }` or `{ error: "Comment not found" }`
- **Other HTTP errors:** Return `{ error: "Paste service returned {status}" }`

Errors are returned as tool results (not MCP protocol errors) so the agent can read and react to them.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `/home/ubuntu/paste-service/package.json` | Dependencies (`@modelcontextprotocol/sdk`) |
| Create | `/home/ubuntu/paste-service/mcp-server.js` | MCP server — tool definitions, HTTP translation, stdio transport |
| Create | `/home/ubuntu/paste-service/test-mcp.mjs` | Unit tests for tool handler functions |
| Modify | `/home/ubuntu/.mcp.json` | Register `md-review` MCP server |

---

## Testing

Unit tests in `test-mcp.mjs` using Node's built-in test runner. Tests exercise the tool handler functions directly with a mocked fetch (no need to spin up stdio transport).

**Test cases:**
- `create_session`: returns id and shareUrl, auto-generates sharedAt
- `get_session`: returns full state with appended shareUrl
- `get_session`: returns error for nonexistent session
- `list_comments`: returns comments array
- `add_comment`: sends correct payload, returns server response
- `add_comment`: includes author when provided, omits when not
- `edit_comment`: sends partial update
- `delete_comment`: returns ok
- Error handling: paste service unreachable returns error object
- Error handling: 404 returns descriptive error

---

## Scope Boundaries

**In scope:**
- MCP server with 7 tools + 1 resource
- stdio transport via `@modelcontextprotocol/sdk`
- `.mcp.json` registration
- Unit tests for tool handlers

**Out of scope:**
- SSE/HTTP transport (future if needed for remote access)
- Authentication / API keys
- CLI wrapper (curl works, agents use MCP)
- Rate limiting
