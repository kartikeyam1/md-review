#!/usr/bin/env node
/**
 * md-review CLI — upload files to the paste service without reading them into agent context.
 *
 * Usage:
 *   md-review create <file> [options]          Create a session from a file
 *   md-review upload <sessionId> <file>        Replace session content with file
 *   md-review add-file <sessionId> <file>      Add file to session collection
 *   md-review patch <sessionId> <patchFile>    Apply a diff file as patch
 *   md-review publish <key> <file> [--name] [--note] [--token] [--slug] [--filename] [--author] [--expiry] [--content-type] [--mode]
 *                                              Publish a recurring doc under a stable key (#21):
 *                                              creates it the first time, else adds a revision
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
 *   --mode <mode>      create/publish: publish (read-only page, default) or review (comments + approval)
 *   --author <name>    who is writing (recorded on the revision)
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

const COMMANDS = new Set(['create', 'upload', 'add-file', 'patch', 'publish']);
/** Every option takes a value. */
const OPTIONS = new Set(['api', 'frontend', 'name', 'slug', 'filename', 'expiry', 'callback', 'encoding', 'chunk-size',
  'content-type', 'note', 'author', 'token', 'mode']);

/**
 * Options may come before or after the command (`--api X create f` works).
 * Returns { cmd, positional, flags, errors } — unknown options and options
 * without a value are errors (never silently ignored).
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};
  const errors = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!OPTIONS.has(name)) { errors.push(`unknown option --${name}`); if (eq === -1 && i + 1 < args.length && !args[i + 1].startsWith('--')) i++; continue; }
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[name] = args[++i];
      else errors.push(`option --${name} needs a value`);
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift();
  // Options that only one kind of command takes.
  const ONLY = { mode: ['create', 'publish'], note: ['publish'], callback: ['create'], frontend: ['create'], encoding: ['create', 'add-file'] };
  for (const [opt, cmds] of Object.entries(ONLY)) {
    if (flags[opt] !== undefined && cmd && !cmds.includes(cmd)) errors.push(`option --${opt} does not apply to ${cmd} (only: ${cmds.join(', ')})`);
  }
  return { cmd, positional, flags, errors };
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
    if (res.status === 401) {
      // #23: an edit-protected doc refused the write.
      throw new Error(`API ${res.status}: ${body}\nThis document is edit-protected: pass --token <edit token> (or set MDREVIEW_EDIT_TOKEN).`);
    }
    if (res.status === 403) {
      throw new Error(`API ${res.status}: ${body}\nThe edit token given does not match this document (tokens are per document, and may have been rotated): pass this document's token with --token or MDREVIEW_EDIT_TOKEN.`);
    }
    throw new Error(`API ${res.status}: ${body}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

/** Chunks of at most `size` UTF-16 units, never splitting a surrogate pair (each chunk is sent as UTF-8). */
function splitChunks(content, size) {
  const chunks = [];
  for (let i = 0; i < content.length;) {
    let end = Math.min(i + size, content.length);
    const c = content.charCodeAt(end - 1);
    if (end < content.length && end - i > 1 && c >= 0xd800 && c <= 0xdbff) end--;
    chunks.push(content.slice(i, end));
    i = end;
  }
  return chunks.length ? chunks : [''];
}

async function chunkedUpload(sessionId, content, opts = {}) {
  const chunkSize = (opts.chunkSize || DEFAULT_CHUNK_KB) * 1024;
  const chunks = splitChunks(content, chunkSize);
  const totalChunks = chunks.length;
  const apiUrl = opts.api || API;
  const token = opts.token || null;

  // Start
  const start = await api(`/paste/${sessionId}/upload/start`, {
    method: 'POST',
    body: JSON.stringify({
      totalChunks,
      filename: opts.filename || null,
      target: opts.target || 'markdown',
      ...(opts.author ? { author: opts.author } : {}),
      ...(opts.encoding === 'base64' ? { encoding: 'base64' } : {}),
    }),
    api: apiUrl,
    token,
  });

  // Send chunks
  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks[i];
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

/** --mode for create/publish: publish | review (anything else is an error). */
function modeOf(flags) {
  if (flags.mode === undefined) return undefined;
  if (flags.mode !== 'publish' && flags.mode !== 'review') throw new Error('--mode must be "publish" or "review"');
  return flags.mode;
}

/** What `create` prints: the shape every create returns (MCP / REST / CLI) — id, slug, mode, url, viewUrl, app_url, size, and (#23) editToken + editUrl. */
function createdLine(result, url, size) {
  const out = { id: result.id, slug: result.slug || null, mode: result.mode ?? null, url, viewUrl: url, app_url: result.app_url || null, size };
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
  const mode = modeOf(flags);

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
    if (mode) payload.mode = mode;
    if (typeof flags.author === 'string') payload.author = flags.author;
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
  if (mode) payload.mode = mode;
  if (typeof flags.author === 'string') payload.author = flags.author;
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
    author: typeof flags.author === 'string' ? flags.author : null,
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
  // The display filename changes only with --filename: uploading from a temp file must not rename the doc.
  const filename = typeof flags.filename === 'string' ? flags.filename : null;
  const author = typeof flags.author === 'string' ? flags.author : null;
  const size = Buffer.byteLength(content);

  let result;
  if (size < 1024 * 1024) {
    const payload = { markdown: content };
    if (filename) payload.filename = filename;
    if (author) payload.author = author;
    result = await api(`/paste/${sessionId}/markdown`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      api: apiUrl,
      token: tokenOf(flags),
    });
  } else {
    process.stderr.write(`  uploading ${(size / 1024).toFixed(0)} KB in chunks...\n`);
    result = await chunkedUpload(sessionId, content, {
      filename,
      author,
      api: apiUrl,
      token: tokenOf(flags),
      chunkSize: flags['chunk-size'] ? parseInt(flags['chunk-size'], 10) : DEFAULT_CHUNK_KB,
    });
  }

  console.log(JSON.stringify({ ok: true, size, content_hash: result?.content_hash || null }));
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
      encoding,
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

/**
 * #21 rule 11: PUT /paste/by-key/<key> with the file's content. Prints
 * {url, revision, created, changed, id, slug} (+ editToken/editUrl on create —
 * keep the token: later runs need it as --token or MDREVIEW_EDIT_TOKEN).
 */
async function cmdPublish(key, filePath, flags) {
  const apiUrl = flags.api || API;
  const content = await readFile(filePath, 'utf-8');
  // The display filename is sent only with --filename: a job writing to a temp file with a
  // random name must not flip the doc's filename (and report changed:true) on every run.
  const payload = {
    markdown: content,
    contentType: flags['content-type'] || (/\.html?$/i.test(filePath) ? 'html' : 'markdown'),
  };
  if (typeof flags.filename === 'string') payload.filename = flags.filename;
  if (typeof flags.name === 'string') payload.sessionName = flags.name;
  if (typeof flags.slug === 'string') payload.slug = flags.slug;
  if (typeof flags.note === 'string') payload.changeNote = flags.note;
  if (typeof flags.author === 'string') payload.author = flags.author;
  const mode = modeOf(flags);
  if (mode) payload.mode = mode; // applies when the doc is created
  if (flags.expiry === 'none') payload.expiry_days = null;
  else if (flags.expiry) payload.expiry_days = parseInt(flags.expiry, 10);
  const r = await api(`/paste/by-key/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    api: apiUrl,
    token: tokenOf(flags),
  });
  const out = { url: r.url, viewUrl: r.url, app_url: r.app_url || null, revision: r.revision, created: r.created, changed: r.changed, id: r.id, slug: r.slug || null, mode: r.mode ?? null };
  if (r.editToken) Object.assign(out, { editToken: r.editToken, editUrl: r.editUrl });
  if (mode && !r.created && r.mode && r.mode !== mode) {
    process.stderr.write(`note: --mode applies only when the doc is created; this doc stays in ${r.mode} mode.\n`);
  }
  console.log(JSON.stringify(out));
}

// ── Main ────────────────────────────────────────────────────────────────────

const { cmd, positional, flags, errors } = parseArgs(process.argv);

if (!flags.help && (errors.length || (cmd && !COMMANDS.has(cmd)))) {
  for (const e of errors) console.error(`error: ${e}`);
  if (cmd && !COMMANDS.has(cmd)) console.error(`error: unknown command "${cmd}" (commands: ${[...COMMANDS].join(', ')})`);
  console.error('Run md-review --help for usage.');
  process.exit(1);
}

try {
  switch (flags.help ? undefined : cmd) {
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

    case 'publish':
      if (!positional[0] || !positional[1]) throw new Error('Usage: md-review publish <key> <file> [--name <name>] [--note <change note>] [--token <edit token>]');
      await cmdPublish(positional[0], positional[1], flags);
      break;

    default:
      console.error(`md-review — upload files to the paste review service

Commands:
  create <file>                Create a session from a file
  upload <sessionId> <file>    Replace session content with file
  add-file <sessionId> <file>  Add file to session collection
  patch <sessionId> <diff>     Apply a diff file as patch
  publish <key> <file>         Publish a recurring doc under a stable key: creates it
                               the first time, otherwise adds a revision (same URL).
                               Takes --note, --author and the options below
                               (--slug on create only); updates need the edit token

Options:
  --api <url>         API URL (default: $PASTE_API_URL or http://localhost:3100)
  --name <name>       Session name
  --slug <slug>       Custom slug
  --filename <name>   Override display filename
  --expiry <days>     Expiry: 1, 7, 30, 90, or "none" (never)
  --encoding <enc>    utf-8 (default) or base64
  --content-type <t>  markdown or html (default: auto-detected from extension)
  --chunk-size <KB>   Chunk size in KB (default: 512)
  --note <text>       publish: change note for this run (max 500 chars)
  --author <name>     who is writing (recorded on the revision)
  --mode <mode>       create/publish: publish (read-only page, default) or
                      review (comments + approval); publish: on create only
  --callback <url>    create: webhook for approval changes
  --frontend <url>    create: base URL for the printed link

Edit tokens (edit-protected docs; upload, add-file, patch, publish updates):
  MDREVIEW_EDIT_TOKEN   env var holding the doc's edit token (the usual way)
  --token <token>       the same, per call (overrides MDREVIEW_EDIT_TOKEN)
  create prints the new doc's editToken + editUrl — keep them to edit it later.

Examples:
  md-review create ./README.md --name "README review"
  md-review create ./report.html --name "HTML report review"
  md-review upload abc123 ./updated.md
  md-review add-file abc123 ./image.png --encoding base64
  md-review patch abc123 ./fix.diff
  md-review publish factory:weekly-status ./status.md --name "Weekly status" --note "run 12"`);
      process.exit(cmd && !flags.help ? 1 : 0);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
