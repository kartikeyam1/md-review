'use strict';
// Route (#22): GET /d/:x[@rev][/:file] — a tiny server-rendered meta page per
// doc, so a pasted link unfurls with the doc's title, a summary and a cover;
// humans are sent on to the SPA. GET /d/:x/cover.png — the cover image.
// Returns NEXT for anything outside /d/ (and for methods other than GET/HEAD).
// Precedence within /d/ (00 §6): /d/:x.md (#28) → /d/:x/cover.png →
// /d/:x@:rev → /d/:x/:file… → /d/:x. Nothing under /d/ falls through to the
// hosted-site asset fallback.
const crypto = require('crypto');
const fs = require('fs');
const { NEXT } = require('../http-util.cjs');
const {
  db, isExpired, resolveId, loadContent, loadMeta, listRevisions, readRevisionBlob, listSessionFiles, getSessionFile,
  removeCovers,
} = require('../storage.cjs');
const { PUBLIC_BASE_URL } = require('../config.cjs');
const { appUrl, shareUrl } = require('../links.cjs');
const { docTitle, docDescription, truncateText, effectiveContentType, capText, SCAN_CAP } = require('../doc-text.cjs');
const cover = require('../cover.cjs');

const MAX_TEXT = 200;

// Link unfurlers get the meta tags only: some follow a meta refresh and would
// unfurl the generic SPA instead (rule 5).
const BOT_UA = /Slackbot|Slack-ImgProxy|Twitterbot|facebookexternalhit|LinkedInBot|Discordbot|WhatsApp|TelegramBot|SkypeUriPreview|Microsoft Teams|Googlebot|bingbot|Embedly|redditbot|Applebot/i;
const isBot = (req) => BOT_UA.test(req.headers['user-agent'] || '');

const SLUG_OR_ID = '[a-zA-Z0-9][a-zA-Z0-9-]*';
const DOC_PATH = new RegExp(`^(${SLUG_OR_ID})(?:@([a-f0-9]{32}))?(?:/(.+))?$`);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const isTextFile = (name) => /\.(md|markdown|txt|html?)$/i.test(name);
// C0/C1 control characters never reach the page (whitespace is already collapsed).
const noControls = (s) => s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

/** The doc's canonical x (slug if set, else id). */
const canonicalX = (id, meta) => (typeof meta.slug === 'string' && meta.slug ? meta.slug : id);

/** Title and description of a text (the first SCAN_CAP of it), ≤200 chars each. */
function pageText(meta, source) {
  const src = capText(source || '', SCAN_CAP);
  return {
    title: truncateText(noControls(docTitle(meta, src)), MAX_TEXT),
    description: truncateText(noControls(docDescription(meta, src, MAX_TEXT)), MAX_TEXT),
  };
}

/**
 * Everything the page and the cover need about the doc's current state, read
 * once per request: content, revisions, updated_at, the title (with the
 * filename-inferred content type) and the cover text + cover_key.
 */
function docState(id, meta) {
  const content = loadContent(id) || '';
  const revisions = listRevisions(id);
  const row = db.prepare('SELECT updated_at, created_by FROM sessions WHERE id = ?').get(id) || {};
  const typed = { ...meta, contentType: effectiveContentType(meta) };
  const text = pageText(typed, content);
  // "by": the person who made the doc (first revision's author, else the stored creator) — never a client label.
  const first = revisions.find((r) => !r.seeded) || null;
  const author = (first && first.by) || row.created_by || null;
  const coverInfo = cover.coverText({
    title: text.title, filename: meta.filename, contentType: typed.contentType, author, updatedAt: row.updated_at,
  });
  return { content, revisions, typed, text, updatedAt: row.updated_at || null, cover: coverInfo };
}

const isoOrNull = (at) => (at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null);

/** Does If-None-Match match `etag` (or `*`)? */
function notModified(req, etag) {
  const inm = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim());
  return inm.includes('*') || inm.includes(etag) || inm.includes(`W/${etag}`);
}

// ── the meta page ───────────────────────────────────────────────────────────

function renderPage({ title, description, shareHref, rawHref, imageHref, modified, target, bot, notice, pageTitle }) {
  const head = [
    '<meta charset="utf-8">',
    `<title>${esc(pageTitle || title)} · md-review</title>`,
    `<meta name="description" content="${esc(description)}">`,
    '<meta name="robots" content="noindex, nofollow">',
  ];
  if (shareHref) head.push(`<link rel="canonical" href="${esc(shareHref)}">`);
  // #28 rule 14: agents find the raw source (agent-only sections included) here.
  if (rawHref) head.push(`<link rel="alternate" type="text/markdown" href="${esc(rawHref)}">`);
  head.push(
    '<meta property="og:site_name" content="md-review">',
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
  );
  if (shareHref) head.push(`<meta property="og:url" content="${esc(shareHref)}">`);
  if (imageHref) {
    head.push(
      `<meta property="og:image" content="${esc(imageHref)}">`,
      '<meta property="og:image:type" content="image/png">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${esc(title)}">`,
    );
  }
  if (modified) head.push(`<meta property="article:modified_time" content="${esc(modified)}">`);
  head.push(
    `<meta name="twitter:card" content="${imageHref ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
  );
  if (imageHref) head.push(`<meta name="twitter:image" content="${esc(imageHref)}">`);
  if (!bot) {
    // Humans go on to the SPA. The JS keeps the browser-side #fragment (heading
    // anchors); the meta refresh is the no-JS fallback. TARGET is JSON with `<`
    // escaped, so a hostile query string cannot close the <script>.
    head.push(`<meta http-equiv="refresh" content="0; url=${esc(target)}">`);
    const js = JSON.stringify(target).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
    head.push(`<script>location.replace(${js} + location.hash)</script>`);
  }
  const heading = notice || pageTitle || title;
  return `<!doctype html>
<html lang="en">
<head>
${head.join('\n')}
</head>
<body>
<h1>${esc(heading)}</h1>
<p>${esc(description)}</p>
<p><a href="${esc(target)}">Open in md-review</a></p>
</body>
</html>
`;
}

function sendHtml(req, res, status, html, etag) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    Vary: 'User-Agent',
  };
  if (etag) {
    headers.ETag = etag;
    if (notModified(req, etag)) { res.writeHead(304, headers); return res.end(); }
  }
  const body = Buffer.from(html, 'utf-8');
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  return res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * 404 / 410 pages: fixed text, no og:image, never the stored title. Humans
 * still go on to the app: to `target` (the doc's app URL, which renders its
 * own not-found state) or, for an unparseable path, the app root.
 */
function sendMissing(req, res, status, target) {
  const expired = status === 410;
  const title = expired ? 'Expired document' : 'Document not found';
  const description = expired ? 'This document has expired.' : 'This document does not exist or was deleted.';
  const html = renderPage({ title, description, target, bot: isBot(req), notice: title });
  return sendHtml(req, res, status, html, null);
}

/** Up to SCAN_CAP bytes of a session file, as text. */
function readFileHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, SCAN_CAP));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8');
  } finally { fs.closeSync(fd); }
}

function metaPage(req, res, { x, rev, file, query }) {
  const suffix = `${rev ? `@${rev}` : ''}${file ? `/${file.raw}` : ''}`;
  const missing = (status) => sendMissing(req, res, status, appUrl(`${x}${suffix}`) + query);
  const id = resolveId(x);
  const meta = id ? loadMeta(id) : null;
  if (!meta) return missing(404);
  if (isExpired(meta)) return missing(410);
  const doc = docState(id, meta);

  // The text the page describes: the live doc, a pinned revision, or a session file.
  let text = doc.text;
  let modified = isoOrNull(doc.updatedAt);
  let withImage = cover.coversAvailable();
  if (rev) {
    const entry = doc.revisions.find((r) => r.hash === rev) || null;
    const current = rev === meta.content_hash;
    if (!entry && !current) return missing(404);
    let source = readRevisionBlob(id, rev);
    if (source === null && current) source = doc.content;
    if (source === null) return missing(404);
    text = pageText(doc.typed, source);
    if (entry) modified = isoOrNull(entry.at_end || entry.at) || modified;
    // A pinned page has no image: the cover shows the live doc, which may differ from this revision.
    withImage = false;
  } else if (file) {
    const listed = listSessionFiles(id).some((f) => f.name === file.name);
    const found = listed ? getSessionFile(id, file.name) : null;
    if (!found) return missing(404);
    // A file page describes the file itself (its own title/summary); the cover stays the doc's.
    const name = file.name.split('/').pop();
    if (isTextFile(name)) {
      text = pageText({ filename: name, contentType: effectiveContentType({ filename: name }) }, readFileHead(found.path));
    } else {
      text = {
        title: truncateText(noControls(name), MAX_TEXT),
        description: truncateText(`A file from “${truncateText(doc.text.title, 120)}”, shared on md-review`, MAX_TEXT),
      };
    }
  }

  const cx = canonicalX(id, meta);
  const imageHref = withImage ? `${PUBLIC_BASE_URL}/d/${cx}/cover.png?v=${doc.cover.key}` : null;
  const bot = isBot(req);
  const target = appUrl(`${cx}${suffix}`) + query;
  const shareHref = shareUrl(`${cx}${suffix}`);
  const { title, description } = text;
  // #28: the markdown doc's raw source, live or pinned (/d/x@rev.md); session files have no raw /d/ route.
  const rawHref = !file && doc.typed.contentType !== 'html' ? `${PUBLIC_BASE_URL}/d/${cx}${rev ? `@${rev}` : ''}.md` : null;
  // A pinned earlier revision says so in the tab/page title (og:title stays the revision's own title).
  const pageTitle = rev && rev !== meta.content_hash ? `${title} (earlier revision)` : null;

  // Rule 7: the ETag covers everything the page shows, per bot/human variant.
  const etag = `"${md5(JSON.stringify([title, pageTitle, description, imageHref ? doc.cover.key : '', bot ? 'bot' : 'human', modified, target, shareHref, rawHref]))}"`;
  const html = renderPage({ title, description, shareHref, rawHref, imageHref, modified, target, bot, pageTitle });
  return sendHtml(req, res, 200, html, etag);
}

// ── the cover ───────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(body));
}

function coverImage(req, res, { x, query }) {
  const id = resolveId(x);
  const meta = id ? loadMeta(id) : null;
  if (!meta) return sendJson(res, 404, { error: 'not found' });
  if (isExpired(meta)) return sendJson(res, 410, { error: 'Session expired' });

  const spec = docState(id, meta).cover;
  let png;
  try {
    png = cover.getCover(id, spec.key, spec, removeCovers);
  } catch (e) {
    console.error(`[md-review] cover render failed for ${id}:`, e.message);
    return sendJson(res, 500, { error: 'Cover rendering failed' });
  }
  const v = new URLSearchParams(query.slice(1)).get('v');
  const etag = `"${spec.key}"`;
  const headers = {
    'Content-Type': 'image/png',
    // A current ?v= URL never changes content; a missing or stale one may.
    'Cache-Control': v === spec.key ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    ETag: etag,
  };
  if (notModified(req, etag)) { res.writeHead(304, headers); return res.end(); }
  headers['Content-Length'] = png.length;
  res.writeHead(200, headers);
  return res.end(req.method === 'HEAD' ? undefined : png);
}

// ── dispatch ────────────────────────────────────────────────────────────────

module.exports = async function metaRoute(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return NEXT;
  const qi = req.url.indexOf('?');
  const pathname = qi === -1 ? req.url : req.url.slice(0, qi);
  if (!pathname.startsWith('/d/')) return NEXT;
  const query = qi === -1 ? '' : req.url.slice(qi);
  const rest = pathname.slice(3);
  // Anything unparseable (encoded slashes, dot segments, …) is a not-found page
  // that sends humans to the app root — the raw path is never echoed.
  const invalid = () => sendMissing(req, res, 404, appUrl(''));
  const m = DOC_PATH.exec(rest.endsWith('/') ? rest.slice(0, -1) : rest);
  if (!m) return invalid();
  const [, x, rev, fileRaw] = m;

  // /d/:x.md is #28's (routes/raw.cjs, registered before this one); any other dotted path is unparseable.
  if (!rev && fileRaw === 'cover.png') return coverImage(req, res, { x, query });
  if (rev && fileRaw) return invalid();

  let file = null;
  if (fileRaw) {
    let name;
    try { name = decodeURIComponent(fileRaw); } catch { return invalid(); }
    if (name.split('/').some((seg) => !seg || seg === '.' || seg === '..') || name.includes('\\') || name.includes('\0')) {
      return invalid();
    }
    file = { raw: fileRaw, name };
  }
  return metaPage(req, res, { x, rev, file, query });
};
