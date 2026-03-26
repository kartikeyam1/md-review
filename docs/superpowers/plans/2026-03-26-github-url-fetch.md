# GitHub URL Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to load markdown files from GitHub by providing a URL — via the upload screen, or via a `#github=` hash parameter in the page URL.

**Architecture:** A new `GET /github?url=` endpoint on the paste service (`/home/ubuntu/paste-service/server.js`) parses GitHub URLs, fetches raw content using the server's `GITHUB_TOKEN`, and returns `{ content, filename }`. The frontend adds a GitHub URL input to the upload screen and hash-based auto-loading in `App.vue`.

**Tech Stack:** Node.js (paste service), Vue 3 + TypeScript (frontend)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `/home/ubuntu/paste-service/server.js` | Modify | Add `GET /github?url=` endpoint |
| `src/composables/useShare.ts` | Modify | Add `fetchGithub(url)` function |
| `src/components/FileUpload.vue` | Modify | Add GitHub URL input UI |
| `src/App.vue` | Modify | Add `#github=` hash parameter handling on mount |

---

### Task 1: Backend — Add `GET /github` endpoint to paste service

**Files:**
- Modify: `/home/ubuntu/paste-service/server.js:89-96` (before the 404 fallback)

- [ ] **Step 1: Add the GitHub URL parsing and fetch endpoint**

Insert before the `// GET / — health check` block (line 92) in `/home/ubuntu/paste-service/server.js`:

```javascript
// GET /github?url=<github-url> — fetch file from GitHub
if (req.method === 'GET' && req.url.startsWith('/github?')) {
  const params = new URL(req.url, `http://${req.headers.host}`);
  const ghUrl = params.searchParams.get('url');

  if (!ghUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
  }

  // Parse github.com blob URLs → raw URL
  // Supports: github.com/{owner}/{repo}/blob/{ref}/{path}
  //           raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
  let rawUrl = null;
  let filename = null;

  const blobMatch = ghUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
  );
  const rawMatch = ghUrl.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  );

  if (blobMatch) {
    const [, owner, repo, ref, filePath] = blobMatch;
    rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
    filename = filePath.split('/').pop();
  } else if (rawMatch) {
    rawUrl = ghUrl;
    filename = rawMatch[4].split('/').pop();
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not a recognized GitHub file URL' }));
  }

  const token = process.env.GITHUB_TOKEN || '';
  const headers = { 'User-Agent': 'md-review-paste-service' };
  if (token) headers['Authorization'] = `token ${token}`;

  const https = require('https');
  https.get(rawUrl, { headers }, (ghRes) => {
    if (ghRes.statusCode === 404) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'File not found on GitHub' }));
    }
    if (ghRes.statusCode < 200 || ghRes.statusCode >= 300) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `GitHub returned ${ghRes.statusCode}` }));
    }

    let body = '';
    ghRes.on('data', (chunk) => { body += chunk; });
    ghRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: body, filename }));
    });
  }).on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch from GitHub' }));
  });

  return;
}
```

- [ ] **Step 2: Test the endpoint manually**

Run:
```bash
cd /home/ubuntu/paste-service
# Restart the server
kill $(lsof -ti:3100) 2>/dev/null; node server.js &
sleep 1

# Test with a public repo file
curl -s "http://localhost:3100/github?url=https://github.com/expressjs/express/blob/master/Readme.md" | head -c 200

# Test with missing url param
curl -s "http://localhost:3100/github"

# Test with invalid URL
curl -s "http://localhost:3100/github?url=https://example.com/foo"
```

Expected:
- First: JSON with `content` and `filename: "Readme.md"`
- Second: `{"error":"Missing \"url\" query parameter"}`
- Third: `{"error":"Not a recognized GitHub file URL"}`

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add server.js
git commit -m "feat: add GET /github endpoint to fetch files from GitHub"
```

---

### Task 2: Frontend — Add `fetchGithub()` to useShare composable

**Files:**
- Modify: `src/composables/useShare.ts`

- [ ] **Step 1: Add the fetchGithub function**

Add this function inside the `useShare()` composable, before the `return` statement in `src/composables/useShare.ts`:

```typescript
async function fetchGithub(githubUrl: string): Promise<{ content: string; filename: string } | null> {
  try {
    const res = await fetch(`${PASTE_API}/github?url=${encodeURIComponent(githubUrl)}`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }))
      shareError.value = data.error || `Server error (${res.status})`
      return null
    }
    return await res.json() as { content: string; filename: string }
  } catch {
    shareError.value = 'Could not reach server. Are you on VPN?'
    return null
  }
}
```

- [ ] **Step 2: Add fetchGithub to the return statement**

Change the return statement to include `fetchGithub`:

```typescript
return { sharing, shareError, createShare, loadShare, fetchGithub, getShareIdFromHash, setShareHash, getShareUrls }
```

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/locus-repos/md-review
git add src/composables/useShare.ts
git commit -m "feat: add fetchGithub() to useShare composable"
```

---

### Task 3: Frontend — Add GitHub URL input to FileUpload.vue

**Files:**
- Modify: `src/components/FileUpload.vue`

- [ ] **Step 1: Add state and handler for GitHub URL input**

In the `<script setup>` section of `src/components/FileUpload.vue`, add after the existing refs (line 11):

```typescript
const showGithub = ref(false)
const githubUrl = ref('')
const githubLoading = ref(false)
const githubError = ref('')

async function submitGithub() {
  const url = githubUrl.value.trim()
  if (!url) return

  githubLoading.value = true
  githubError.value = ''

  try {
    const PASTE_API = import.meta.env.VITE_PASTE_API_URL || ''
    const res = await fetch(`${PASTE_API}/github?url=${encodeURIComponent(url)}`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }))
      githubError.value = data.error || `Failed to fetch (${res.status})`
      return
    }
    const { content, filename } = await res.json()
    emit('file-loaded', content, filename)
  } catch {
    githubError.value = 'Could not reach server. Are you on VPN?'
  } finally {
    githubLoading.value = false
  }
}
```

- [ ] **Step 2: Add the GitHub URL template**

Replace the `alt-actions` div in the template (lines 81-85) with:

```html
<div class="alt-actions">
  <button class="btn btn-ghost" @click.stop="showPaste = true; showGithub = false">Paste markdown</button>
  <span class="alt-divider">or</span>
  <button class="btn btn-ghost" @click.stop="showGithub = true; showPaste = false">From GitHub</button>
  <span class="alt-divider">or</span>
  <button class="btn btn-ghost" @click.stop="startBlank">Start blank</button>
</div>
```

- [ ] **Step 3: Add the GitHub URL form panel**

Add after the paste-area `<div v-else class="paste-area">` block (after line 101), before the closing `</div>` of upload-screen. Wrap the existing paste block with `v-if="showPaste"` and add:

The template section should become:

```html
<template>
  <div class="upload-screen">
    <template v-if="!showPaste && !showGithub">
      <!-- existing upload-area and alt-actions (unchanged except alt-actions from step 2) -->
    </template>

    <div v-else-if="showPaste" class="paste-area">
      <!-- existing paste content unchanged -->
    </div>

    <div v-else-if="showGithub" class="paste-area">
      <h2 class="upload-title">Load from GitHub</h2>
      <input
        v-model="githubUrl"
        class="github-input"
        type="url"
        placeholder="https://github.com/owner/repo/blob/main/README.md"
        autofocus
        @keydown.enter="submitGithub"
      />
      <p v-if="githubError" class="github-error">{{ githubError }}</p>
      <div class="paste-actions">
        <button class="btn btn-ghost" @click="showGithub = false; githubError = ''">Back</button>
        <button class="btn btn-primary" :disabled="githubLoading" @click="submitGithub">
          {{ githubLoading ? 'Loading…' : 'Load File' }}
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Add styles for the GitHub input**

Add to the `<style scoped>` section:

```css
.github-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font-size: 13px;
  font-family: var(--font-mono);
  background: var(--bg-page);
  color: var(--text-primary);
  margin-top: 12px;
}

.github-input:focus {
  outline: none;
  border-color: var(--text-muted);
}

.github-error {
  color: #dc2626;
  font-size: 13px;
  margin-top: 8px;
}
```

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/locus-repos/md-review
git add src/components/FileUpload.vue
git commit -m "feat: add GitHub URL input to upload screen"
```

---

### Task 4: Frontend — Add `#github=` hash parameter support in App.vue

**Files:**
- Modify: `src/App.vue`

- [ ] **Step 1: Add loadFromGithubHash function**

Add after `loadSharedDoc()` function (line 79) in `src/App.vue`:

```typescript
async function loadFromGithubHash() {
  const hash = window.location.hash
  const match = hash.match(/^#github=(.+)$/)
  if (!match) return

  const githubUrl = decodeURIComponent(match[1])
  const data = await fetchGithub(githubUrl)
  if (data) {
    handleFileLoaded(data.content, data.filename)
  }
}
```

- [ ] **Step 2: Destructure fetchGithub from useShare**

Update the `useShare()` destructure on line 35 to include `fetchGithub`:

```typescript
const { sharing, shareError, createShare, loadShare, fetchGithub, getShareIdFromHash, setShareHash, getShareUrls } = useShare()
```

- [ ] **Step 3: Call loadFromGithubHash in onMounted**

Update the `onMounted` block (line 81-85) to call the new function:

```typescript
onMounted(() => {
  filePathParam.value = new URLSearchParams(window.location.search).get('filePath')
  loadFromFilePath()
  loadSharedDoc()
  loadFromGithubHash()
})
```

- [ ] **Step 4: Test manually**

Open in browser:
```
http://localhost:58747/#github=https%3A%2F%2Fgithub.com%2Fexpressjs%2Fexpress%2Fblob%2Fmaster%2FReadme.md
```

Expected: The Express.js README loads directly into the editor.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/locus-repos/md-review
git add src/App.vue
git commit -m "feat: support #github= hash parameter for direct linking"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Verify paste service is running with the new endpoint**

```bash
cd /home/ubuntu/paste-service
kill $(lsof -ti:3100) 2>/dev/null; node server.js &
sleep 1
curl -s "http://localhost:3100/github?url=https://github.com/expressjs/express/blob/master/Readme.md" | jq '.filename'
```

Expected: `"Readme.md"`

- [ ] **Step 2: Verify the frontend upload screen GitHub flow**

Open `http://localhost:58747`, click "From GitHub", paste a GitHub URL, click "Load File". File content should appear in the editor.

- [ ] **Step 3: Verify hash parameter flow**

Open `http://localhost:58747/#github=https%3A%2F%2Fgithub.com%2Fexpressjs%2Fexpress%2Fblob%2Fmaster%2FReadme.md`. File should auto-load.

- [ ] **Step 4: Verify error handling**

Test with an invalid URL, a 404 file, and a non-GitHub URL. Each should show an appropriate error message.
