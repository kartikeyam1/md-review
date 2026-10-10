'use strict';
// Route: chunked uploads. Returns NEXT when the request is not one of its own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NEXT, readBody, clientOf } = require('../http-util.cjs');
const {
  resolveId, sessionExists, loadPaste, savePaste, saveSessionFile, chunkDir, saveChunk, assembleChunks,
} = require('../storage.cjs');
const { requireEdit } = require('./edit-tokens.cjs');

/** The staged upload's _meta.json (null when unreadable). */
function readUploadMeta(uploadId) {
  try { return JSON.parse(fs.readFileSync(path.join(chunkDir(uploadId), '_meta.json'), 'utf-8')); } catch { return null; }
}

module.exports = async function uploads(req, res) {
  // ── Chunked uploads ──────────────────────────────────────────────────────
  // POST /paste/:id/upload/start — begin a chunked upload, returns uploadId
  const uploadStartMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/upload\/start$/);
  if (req.method === 'POST' && uploadStartMatch) {
    const pasteId = resolveId(uploadStartMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (!sessionExists(pasteId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    let rawBody;
    try { rawBody = await readBody(req); } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    let parsed = {};
    try { parsed = JSON.parse(rawBody); } catch {}
    if (!requireEdit(req, res, pasteId)) return;
    const uploadId = crypto.randomBytes(8).toString('hex');
    const uploadMeta = { pasteId, totalChunks: parsed.totalChunks || null, filename: parsed.filename || null, target: parsed.target || 'markdown', author: typeof parsed.author === 'string' ? parsed.author : null, client: clientOf(req) };
    fs.mkdirSync(chunkDir(uploadId), { recursive: true });
    fs.writeFileSync(path.join(chunkDir(uploadId), '_meta.json'), JSON.stringify(uploadMeta));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ uploadId, chunkSize: 512 * 1024 }));
  }

  // POST /paste/:id/upload/chunk — send a chunk
  const uploadChunkMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/upload\/chunk$/);
  if (req.method === 'POST' && uploadChunkMatch) {
    const pasteId = resolveId(uploadChunkMatch[1]);
    if (!pasteId || !sessionExists(pasteId)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
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
    const { uploadId, index, data } = parsed;
    if (!uploadId || index === undefined || !data) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing uploadId, index, or data' }));
    }
    // #23: an upload belongs to the doc it was started on (so a token check on one doc cannot be bypassed via another)
    if (!/^[a-f0-9]+$/.test(String(uploadId)) || !fs.existsSync(chunkDir(uploadId)) || readUploadMeta(uploadId)?.pasteId !== pasteId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Upload not found' }));
    }
    saveChunk(uploadId, index, data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, index }));
  }

  // POST /paste/:id/upload/complete — assemble chunks
  const uploadCompleteMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/upload\/complete$/);
  if (req.method === 'POST' && uploadCompleteMatch) {
    const pasteId = resolveId(uploadCompleteMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    let rawBody;
    try { rawBody = await readBody(req); } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    let parsed = {};
    try { parsed = JSON.parse(rawBody); } catch {}
    if (!requireEdit(req, res, pasteId)) return;
    const { uploadId } = parsed;
    if (!uploadId || !/^[a-f0-9]+$/.test(String(uploadId)) || !fs.existsSync(chunkDir(uploadId)) || readUploadMeta(uploadId)?.pasteId !== pasteId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Upload not found' }));
    }
    // Read upload metadata
    const uploadMeta = readUploadMeta(uploadId) || {};

    const assembled = assembleChunks(uploadId);
    if (assembled === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No chunks found' }));
    }

    if (uploadMeta.target === 'file' && uploadMeta.filename) {
      // Save as session file
      const info = saveSessionFile(pasteId, uploadMeta.filename, assembled, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, file: info }));
    } else {
      // Save as primary markdown content
      const data = loadPaste(pasteId);
      if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
      data.markdown = assembled;
      if (uploadMeta.filename) data.filename = uploadMeta.filename;
      savePaste(pasteId, data, { by: uploadMeta.author || null, client: uploadMeta.client || clientOf(req) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, size: assembled.length }));
    }
  }

  return NEXT;
};
