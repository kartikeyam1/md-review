'use strict';
// Route: session file collections. Returns NEXT when the request is not one of its own.
const fs = require('fs');
const crypto = require('crypto');
const { NEXT, readBody } = require('../http-util.cjs');
const {
  resolveId, sessionExists, listSessionFiles, saveSessionFile, deleteSessionFile, getSessionFile,
} = require('../storage.cjs');
const { requireEdit } = require('./edit-tokens.cjs');

module.exports = async function files(req, res) {
  // ── File collections ──────────────────────────────────────────────────────
  // GET    /paste/:id/files              — list files
  // POST   /paste/:id/files              — add a file { name, content, encoding? }
  // GET    /paste/:id/files/:name        — download a file (binary)
  // DELETE /paste/:id/files/:name        — remove a file
  const filesMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/files(?:\/(.+))?$/);
  if (filesMatch) {
    const pasteId = resolveId(filesMatch[1]);
    const fileName = filesMatch[2] ? decodeURIComponent(filesMatch[2]) : null;
    if (!pasteId || !sessionExists(pasteId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (req.method === 'GET' && !fileName) {
      // List files
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(listSessionFiles(pasteId)));
    }

    if (req.method === 'GET' && fileName) {
      // Serve file (binary)
      const file = getSessionFile(pasteId, fileName);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'file not found' }));
      }
      const content = fs.readFileSync(file.path);
      const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': content.length,
        'ETag': etag,
        'Cache-Control': 'no-cache',
      });
      return res.end(content);
    }

    if (req.method === 'POST' && !fileName) {
      // Add file
      let rawBody;
      try { rawBody = await readBody(req); } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }
      let parsed;
      try { parsed = JSON.parse(rawBody); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (!requireEdit(req, res, pasteId)) return;
      if (!parsed.name || !parsed.content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing name or content' }));
      }
      try {
        const info = saveSessionFile(pasteId, parsed.name, parsed.content, parsed.encoding || 'utf-8');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(info));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (req.method === 'DELETE' && fileName) {
      if (!requireEdit(req, res, pasteId)) return;
      if (deleteSessionFile(pasteId, fileName)) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'file not found' }));
    }
  }

  return NEXT;
};
