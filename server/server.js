const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Resolve GITHUB_TOKEN: env var first, fall back to `gh auth token`
if (!process.env.GITHUB_TOKEN) {
  try {
    process.env.GITHUB_TOKEN = execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    // gh CLI not available — private repos won't work
  }
}

const PORT = 3100;
const DATA_DIR = path.join(__dirname, 'data');
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function loadPaste(id) {
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function savePaste(id, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // POST /paste — create
  if (req.method === 'POST' && req.url === '/paste') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    }

    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large (max 10 MB)' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (res.writableEnded) return;

      try {
        JSON.parse(body); // validate JSON
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const id = crypto.randomBytes(6).toString('hex');
      fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    });

    return;
  }

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

  // POST /paste/:id/comments — add a comment
  // PUT  /paste/:id/comments/:commentId — update a comment
  // DELETE /paste/:id/comments/:commentId — remove a comment
  const commentMatch = req.url.match(/^\/paste\/([a-f0-9]+)\/comments(?:\/([a-zA-Z0-9-]+))?$/);
  if (commentMatch && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const [, pasteId, commentId] = commentMatch;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];

    if (req.method === 'POST' && !commentId) {
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

      const { startLine, endLine, selectedText, body: commentBody, category, author } = parsed;
      if (startLine == null || endLine == null || !selectedText || !commentBody || !category) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required fields' }));
      }

      const comment = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        startLine,
        endLine,
        selectedText,
        body: commentBody,
        category,
      };
      if (author !== undefined) comment.author = author;

      data.comments.push(comment);
      savePaste(pasteId, data);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(comment));
    }

    if (req.method === 'PUT' && commentId) {
      const idx = data.comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'comment not found' }));
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

      if (parsed.body !== undefined) data.comments[idx].body = parsed.body;
      if (parsed.category !== undefined) data.comments[idx].category = parsed.category;
      savePaste(pasteId, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data.comments[idx]));
    }

    if (req.method === 'DELETE' && commentId) {
      const idx = data.comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'comment not found' }));
      }

      data.comments.splice(idx, 1);
      savePaste(pasteId, data);

      res.writeHead(204);
      return res.end();
    }
  }

  // PUT /paste/:id/markdown — update markdown (and optionally filename)
  const markdownPutMatch = req.url.match(/^\/paste\/([a-f0-9]+)\/markdown$/);
  if (req.method === 'PUT' && markdownPutMatch) {
    const pasteId = markdownPutMatch[1];
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
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

    if (parsed.markdown !== undefined) data.markdown = parsed.markdown;
    if (parsed.filename !== undefined) data.filename = parsed.filename;
    savePaste(pasteId, data);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /paste/:id — read full paste
  // GET /paste/:id/comments — read comments only
  // GET /paste/:id/markdown — read markdown only
  const match = req.url.match(/^\/paste\/([a-f0-9]+)(\/comments|\/markdown)?$/);
  if (req.method === 'GET' && match) {
    const file = path.join(DATA_DIR, `${match[1]}.json`);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    // ETag: compute MD5 of raw file bytes
    const rawBytes = fs.readFileSync(file);
    const etag = `"${crypto.createHash('md5').update(rawBytes).digest('hex')}"`;

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }

    const data = JSON.parse(rawBytes.toString('utf-8'));
    const sub = match[2];

    let result;
    if (sub === '/comments') {
      result = { filename: data.filename, comments: data.comments || [] };
    } else if (sub === '/markdown') {
      result = { filename: data.filename, markdown: data.markdown || '' };
    } else {
      result = data;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
    res.end(JSON.stringify(result));
    return;
  }

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

  // GET / — health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Paste service running on http://0.0.0.0:${PORT}`);
});
