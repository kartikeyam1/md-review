#!/usr/bin/env node
/**
 * md-review CLI — upload files to the paste service without reading them into agent context.
 *
 * Usage:
 *   md-review create <file> [options]          Create a session from a file
 *   md-review upload <sessionId> <file>        Replace session content with file
 *   md-review add-file <sessionId> <file>      Add file to session collection
 *   md-review patch <sessionId> <patchFile>    Apply a diff file as patch
 *
 * Options:
 *   --api <url>        Paste API URL (default: PASTE_API_URL or http://localhost:3100)
 *   --frontend <url>   Frontend URL (default: FRONTEND_URL or https://kartikeyam1.github.io/md-review)
 *   --name <name>      Session name
 *   --slug <slug>      Custom slug
 *   --filename <name>  Override display filename
 *   --expiry <days>    Expiry in days: 1, 7, 30, 90, or "none" (never)
 *   --callback <url>   Webhook URL for approval changes
 *   --encoding <enc>   File encoding: utf-8 (default) or base64
 *   --chunk-size <n>   Chunk size in KB (default: 512)
 *
 * Edit tokens (edit-protected docs; upload, add-file, patch):
 *   MDREVIEW_EDIT_TOKEN  env var holding the doc's edit token (the usual way)
 *   --token <token>      the same, per call (overrides the env var)
 *   `create` prints the new doc's editToken and editUrl — keep them to edit it later.
 *
 * Examples:
 *   md-review create ./README.md --name "README review"
 *   md-review create ./big-file.md --name "Large doc"
 *   md-review upload abc123 ./updated.md
 *   md-review add-file abc123 ./screenshot.png --encoding base64
 *   md-review add-file abc123 ./src/index.ts
 *   md-review patch abc123 ./changes.diff
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const API = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
const DEFAULT_CHUNK_KB = 512;

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = true;
    } else {
      positional.push(args[i]);
    }
  }

  return { cmd, positional, flags };
}

// ── API helpers ─────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const { api: apiUrl, token, headers, ...rest } = opts;
  const url = (apiUrl || API) + path;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}), ...(headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      // #23: an edit-protected doc refused the write.
      throw new Error(`API ${res.status}: ${body}\nThis document is edit-protected: pass --token <edit token> (or set MDREVIEW_EDIT_TOKEN).`);
    }
    throw new Error(`API ${res.status}: ${body}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

async function chunkedUpload(sessionId, content, opts = {}) {
  const chunkSize = (opts.chunkSize || DEFAULT_CHUNK_KB) * 1024;
  const totalChunks = Math.ceil(content.length / chunkSize);
  const apiUrl = opts.api || API;
  const token = opts.token || null;

  // Start
  const start = await api(`/paste/${sessionId}/upload/start`, {
    method: 'POST',
    body: JSON.stringify({
      totalChunks,
      filename: opts.filename || null,
      target: opts.target || 'markdown',
    }),
    api: apiUrl,
    token,
  });

  // Send chunks
  for (let i = 0; i < totalChunks; i++) {
    const chunk = content.slice(i * chunkSize, (i + 1) * chunkSize);
    await api(`/paste/${sessionId}/upload/chunk`, {
      method: 'POST',
      body: JSON.stringify({ uploadId: start.uploadId, index: i, data: chunk }),
      api: apiUrl,
      token,
    });
    if (totalChunks > 1) {
      process.stderr.write(`\r  chunk ${i + 1}/${totalChunks}`);
    }
  }
  if (totalChunks > 1) process.stderr.write('\n');

  // Complete
  return api(`/paste/${sessionId}/upload/complete`, {
    method: 'POST',
    body: JSON.stringify({ uploadId: start.uploadId }),
    api: apiUrl,
    token,
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

/** The edit token for a write: --token, else MDREVIEW_EDIT_TOKEN, else none (#23 rule 12). */
const tokenOf = (flags) => (typeof flags.token === 'string' && flags.token) || process.env.MDREVIEW_EDIT_TOKEN || null;

/** What `create` prints: id, slug, url, size and (#23) the new doc's editToken + editUrl. */
function createdLine(result, url, size) {
  const out = { id: result.id, slug: result.slug || null, url, size };
  if (result.editToken) {
    out.editToken = result.editToken;
    out.editUrl = result.editUrl || `${result.app_url || url}?edit=${result.editToken}`;
  }
  return JSON.stringify(out);
}

async function cmdCreate(filePath, flags) {
  const apiUrl = flags.api || API;
  // #22 rule 1: the backend's `url` (its /d/ meta page when PUBLIC_BASE_URL is
  // set there); an explicit --frontend wins, and an older backend falls back
  // to PUBLIC_BASE_URL / FRONTEND_URL from this env.
  const frontend = flags.frontend || process.env.PUBLIC_BASE_URL || FRONTEND;
  // Explicit local configuration (the flag, or FRONTEND_URL / PUBLIC_BASE_URL
  // set for this CLI) wins over the backend's canonical url.
  const localBase = flags.frontend || process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL;
  const linkOf = (result, shareId) => (!localBase && result.url) || `${String(frontend).replace(/\/+$/, '')}/d/${shareId}`;
  const encoding = flags.encoding || 'utf-8';
  const content = await readFile(filePath, encoding === 'base64' ? null : 'utf-8');
  const filename = flags.filename || basename(filePath);
  const fileStr = encoding === 'base64' ? content.toString('base64') : content;
  const size = Buffer.byteLength(fileStr);
  const contentType = flags['content-type'] || (/\.html?$/i.test(filename) ? 'html' : 'markdown');

  // For small files, create directly
  if (size < 1024 * 1024) {
    const payload = {
      markdown: fileStr,
      filename,
      contentType,
      sharedAt: new Date().toISOString(),
      comments: [],
    };
    if (flags.name) payload.sessionName = flags.name;
    if (flags.slug) payload.slug = flags.slug;
    if (flags.callback) payload.callback_url = flags.callback;
    if (flags.expiry === 'none') payload.expiry_days = null;
    else if (flags.expiry) payload.expiry_days = parseInt(flags.expiry, 10);

    const result = await api('/paste', {
      method: 'POST',
      body: JSON.stringify(payload),
      api: apiUrl,
    });
    const shareId = result.slug || result.id;
    console.log(createdLine(result, linkOf(result, shareId), size));
    return;
  }

  // For large files: create empty session, then chunked upload
  const payload = {
    markdown: '',
    filename,
    contentType,
    sharedAt: new Date().toISOString(),
    comments: [],
  };
  if (flags.name) payload.sessionName = flags.name;
  if (flags.slug) payload.slug = flags.slug;
  if (flags.callback) payload.callback_url = flags.callback;
  if (flags.expiry === 'none') payload.expiry_days = null;
  else if (flags.expiry) payload.expiry_days = parseInt(flags.expiry, 10);

  const result = await api('/paste', {
    method: 'POST',
    body: JSON.stringify(payload),
    api: apiUrl,
  });

  process.stderr.write(`  uploading ${(size / 1024).toFixed(0)} KB in chunks...\n`);
  await chunkedUpload(result.id, fileStr, {
    filename,
    api: apiUrl,
    token: result.editToken || null,
    chunkSize: flags['chunk-size'] ? parseInt(flags['chunk-size'], 10) : DEFAULT_CHUNK_KB,
  });

  const shareId = result.slug || result.id;
  console.log(createdLine(result, linkOf(result, shareId), size));
}

async function cmdUpload(sessionId, filePath, flags) {
  const apiUrl = flags.api || API;
  const content = await readFile(filePath, 'utf-8');
  const filename = flags.filename || basename(filePath);
  const size = Buffer.byteLength(content);

  if (size < 1024 * 1024) {
    const payload = { markdown: content };
    if (filename) payload.filename = filename;
    await api(`/paste/${sessionId}/markdown`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      api: apiUrl,
      token: tokenOf(flags),
    });
  } else {
    process.stderr.write(`  uploading ${(size / 1024).toFixed(0)} KB in chunks...\n`);
    await chunkedUpload(sessionId, content, {
      filename,
      api: apiUrl,
      token: tokenOf(flags),
      chunkSize: flags['chunk-size'] ? parseInt(flags['chunk-size'], 10) : DEFAULT_CHUNK_KB,
    });
  }

  console.log(JSON.stringify({ ok: true, size }));
}

async function cmdAddFile(sessionId, filePath, flags) {
  const apiUrl = flags.api || API;
  const encoding = flags.encoding || 'utf-8';
  const name = flags.filename || basename(filePath);

  let content;
  if (encoding === 'base64') {
    const buf = await readFile(filePath);
    content = buf.toString('base64');
  } else {
    content = await readFile(filePath, 'utf-8');
  }

  const size = Buffer.byteLength(content);

  if (size < 1024 * 1024) {
    const result = await api(`/paste/${sessionId}/files`, {
      method: 'POST',
      body: JSON.stringify({ name, content, encoding }),
      api: apiUrl,
      token: tokenOf(flags),
    });
    console.log(JSON.stringify(result));
  } else {
    process.stderr.write(`  uploading ${(size / 1024).toFixed(0)} KB in chunks...\n`);
    const result = await chunkedUpload(sessionId, content, {
      filename: name,
      target: 'file',
      api: apiUrl,
      token: tokenOf(flags),
      chunkSize: flags['chunk-size'] ? parseInt(flags['chunk-size'], 10) : DEFAULT_CHUNK_KB,
    });
    console.log(JSON.stringify(result));
  }
}

async function cmdPatch(sessionId, patchFile, flags) {
  const apiUrl = flags.api || API;
  const patch = await readFile(patchFile, 'utf-8');
  const payload = { patch };
  if (flags.filename) payload.filename = flags.filename;

  const result = await api(`/paste/${sessionId}/markdown`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    api: apiUrl,
    token: tokenOf(flags),
  });
  console.log(JSON.stringify(result));
}

// ── Main ────────────────────────────────────────────────────────────────────

const { cmd, positional, flags } = parseArgs(process.argv);

try {
  switch (cmd) {
    case 'create':
      if (!positional[0]) throw new Error('Usage: md-review create <file> [options]');
      await cmdCreate(positional[0], flags);
      break;

    case 'upload':
      if (!positional[0] || !positional[1]) throw new Error('Usage: md-review upload <sessionId> <file>');
      await cmdUpload(positional[0], positional[1], flags);
      break;

    case 'add-file':
      if (!positional[0] || !positional[1]) throw new Error('Usage: md-review add-file <sessionId> <file>');
      await cmdAddFile(positional[0], positional[1], flags);
      break;

    case 'patch':
      if (!positional[0] || !positional[1]) throw new Error('Usage: md-review patch <sessionId> <patchFile>');
      await cmdPatch(positional[0], positional[1], flags);
      break;

    default:
      console.error(`md-review — upload files to the paste review service

Commands:
  create <file>                Create a session from a file
  upload <sessionId> <file>    Replace session content with file
  add-file <sessionId> <file>  Add file to session collection
  patch <sessionId> <diff>     Apply a diff file as patch

Options:
  --api <url>         API URL (default: $PASTE_API_URL or http://localhost:3100)
  --name <name>       Session name
  --slug <slug>       Custom slug
  --filename <name>   Override display filename
  --expiry <days>     Expiry: 1, 7, 30, 90, or "none" (never)
  --encoding <enc>    utf-8 (default) or base64
  --content-type <t>  markdown or html (default: auto-detected from extension)
  --chunk-size <KB>   Chunk size in KB (default: 512)

Edit tokens (edit-protected docs; upload, add-file, patch):
  MDREVIEW_EDIT_TOKEN   env var holding the doc's edit token (the usual way)
  --token <token>       the same, per call (overrides MDREVIEW_EDIT_TOKEN)
  create prints the new doc's editToken + editUrl — keep them to edit it later.

Examples:
  md-review create ./README.md --name "README review"
  md-review create ./report.html --name "HTML report review"
  md-review upload abc123 ./updated.md
  md-review add-file abc123 ./image.png --encoding base64
  md-review patch abc123 ./fix.diff`);
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
