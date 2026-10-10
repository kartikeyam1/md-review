'use strict';
// Route: PUT /paste/:id/markdown. Returns NEXT when the request is not one of its own.
const { NEXT, readJsonBody, clientOf } = require('../http-util.cjs');
const {
  resolveId, currentContentHash, contentHashMismatch, loadPaste, savePaste,
} = require('../storage.cjs');
const { PatchError, applyPatch } = require('../patch.cjs');

module.exports = async function markdown(req, res) {
  // PUT /paste/:id/markdown — update markdown (full replace or patch)
  //   Body: { markdown } | { patch: "<unified diff>" }, optional filename, optional base_hash
  //   Optimistic concurrency: send If-Match: <content_hash> (or base_hash in the
  //   body). If the stored content has changed since, responds 412 with the
  //   current content_hash + markdown so the client can merge instead of clobber.
  //   Patches that do not apply cleanly respond 409.
  const markdownPutMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/markdown$/);
  if (req.method === 'PUT' && markdownPutMatch) {
    const pasteId = resolveId(markdownPutMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = await readJsonBody(req, res);
    if (parsed === undefined) return;
    if (parsed.patch === undefined && parsed.markdown === undefined && parsed.delta === undefined && parsed.filename === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Provide markdown, patch, delta, or filename' }));
    }
    // { delta: { keepStart, keepEnd, insert } } replaces base[keepStart .. len-keepEnd)
    // with `insert`. It is only meaningful against one exact base, so it
    // REQUIRES If-Match / base_hash (a stale base is rejected with 412 below).
    const delta = parsed.delta;
    if (delta !== undefined) {
      const validShape = delta && typeof delta === 'object'
        && Number.isInteger(delta.keepStart) && delta.keepStart >= 0
        && Number.isInteger(delta.keepEnd) && delta.keepEnd >= 0
        && typeof delta.insert === 'string';
      if (!validShape) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'delta must be { keepStart: int, keepEnd: int, insert: string }' }));
      }
      if (!req.headers['if-match'] && !parsed.base_hash) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'delta requires If-Match (or base_hash) naming the content it applies to' }));
      }
    }
    if (parsed.markdown !== undefined && typeof parsed.markdown !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'markdown must be a string' }));
    }
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    const mismatch = contentHashMismatch(req.headers['if-match'] || parsed.base_hash, data, data.markdown);
    if (mismatch) {
      res.writeHead(412, { 'Content-Type': 'application/json', ETag: `"${mismatch}"` });
      return res.end(JSON.stringify({
        error: 'Content changed on server since your last read',
        content_hash: mismatch,
        markdown: data.markdown,
        filename: data.filename,
      }));
    }

    if (delta !== undefined) {
      const base = data.markdown || '';
      if (delta.keepStart + delta.keepEnd > base.length) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Delta does not fit the current content', content_hash: currentContentHash(data, base) }));
      }
      data.markdown = base.slice(0, delta.keepStart) + delta.insert + base.slice(base.length - delta.keepEnd);
    } else if (parsed.patch !== undefined) {
      try {
        data.markdown = applyPatch(data.markdown || '', parsed.patch);
      } catch (e) {
        const status = e instanceof PatchError ? 409 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Patch failed: ${e.message}`, content_hash: currentContentHash(data, data.markdown) }));
      }
    } else if (parsed.markdown !== undefined) {
      data.markdown = parsed.markdown;
    }
    if (parsed.filename !== undefined) data.filename = parsed.filename;
    const by = typeof parsed.author === 'string' && parsed.author.trim() ? parsed.author.trim().slice(0, 80) : null;
    const saved = savePaste(pasteId, data, { by, client: clientOf(req) });

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${saved.content_hash}"` });
    return res.end(JSON.stringify({ ok: true, content_hash: saved.content_hash, filename: saved.filename }));
  }

  return NEXT;
};
