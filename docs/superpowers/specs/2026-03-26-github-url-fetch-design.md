# GitHub URL Fetch Feature

Load markdown files directly from GitHub by providing a URL.

## Scope

- Support `github.com/owner/repo/blob/ref/path` URLs
- Support `raw.githubusercontent.com/owner/repo/ref/path` URLs
- Public and private repos (server has GitHub token)
- Single file fetch only (no directory listing, no PR diffs, no gists)

## Backend: New Endpoint on Paste Service

**File:** `/home/ubuntu/paste-service/server.js`

### `GET /github?url=<github-url>`

**Request:**
- Query param `url` — a GitHub file URL (either `github.com/…/blob/…` or `raw.githubusercontent.com/…`)

**Response (200):**
```json
{ "content": "# file contents…", "filename": "README.md" }
```

**Error responses:**
- `400` — missing or invalid URL (not a recognized GitHub URL pattern)
- `404` — file not found on GitHub
- `502` — GitHub API error (rate limit, auth failure, network)

**Implementation details:**
- Parse the URL to extract owner, repo, ref, and file path
- Convert to raw URL: `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`
- If already a raw URL, use as-is
- Fetch with `Authorization: token ${GITHUB_TOKEN}` header
- Extract filename from the path
- Environment variable: `GITHUB_TOKEN` (already available on server)

**URL parsing patterns:**
- `github.com/{owner}/{repo}/blob/{ref}/{path}` → extract parts after `/blob/`
- `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` → use directly

## Frontend: Upload Screen

**File:** `src/components/FileUpload.vue`

Add a "From GitHub URL" input to the upload screen alongside existing load methods (drag-drop, file picker, paste).

**UI:**
- Text input with placeholder "Paste a GitHub URL..."
- "Load" button next to it
- Error message area below input

**Behavior:**
- User pastes a GitHub URL and clicks Load (or presses Enter)
- Frontend calls `GET {PASTE_API_URL}/github?url={encodeURIComponent(url)}`
- On success: emits loaded content and filename to App.vue (same as other load methods)
- On error: displays error message inline

## Frontend: Hash Parameter

**File:** `src/App.vue`

Support `#github=<encoded-url>` in the page URL for direct linking.

**Behavior:**
- On app load, check for `github` key in hash (alongside existing `shared` check)
- If present, decode the URL and fetch via the backend endpoint
- Load content into editor on success
- Show error state on failure

**Example URL:**
```
https://md-review.app/#github=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fblob%2Fmain%2FREADME.md
```

## Files to Modify

| File | Change |
|------|--------|
| `/home/ubuntu/paste-service/server.js` | Add `GET /github` endpoint |
| `src/components/FileUpload.vue` | Add GitHub URL input |
| `src/App.vue` | Add `#github=` hash parameter handling |
| `src/composables/useShare.ts` | Add `fetchGithub(url)` function (or new composable) |

## Out of Scope

- GitHub authentication UI (token is server-side only)
- Gist support
- PR/diff support
- Directory/tree browsing
- Caching fetched files on the server
