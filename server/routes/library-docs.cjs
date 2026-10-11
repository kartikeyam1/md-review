'use strict';
// Route: GET /library/docs — the one list + search endpoint for docs (00 §8).
// List mode without `q`; FTS mode with it (tokens quoted, prefix-matched and
// ANDed; ranked by bm25 with title > filename > content). Filters combine with
// AND, paging is an opaque offset cursor bound to the query's filters.
// Returns NEXT when the request is not one of its own.
const crypto = require('crypto');
const { isDocMode } = require('../mode.cjs');
const { NEXT } = require('../http-util.cjs');
const { db } = require('../storage.cjs');
const { snippetText, markdownToPlain } = require('../doc-text.cjs');
const { ftsQuery, queryTerms, excerpt } = require('../search-query.cjs');
const { readerKeyOf } = require('./library.cjs');
const { compareTags } = require('../../shared/tags.mjs');

const SORTS = new Set(['updated', 'created', 'title', 'views', 'relevance']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Characters of a document scanned for its snippet (the match itself comes from the index). */
const SNIPPET_SCAN_CHARS = 256 * 1024;

function capped(text) {
  if (text.length <= SNIPPET_SCAN_CHARS) return text;
  const cut = text.slice(0, SNIPPET_SCAN_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut; // never split a surrogate pair
}
// hit words as shown, ignoring case only ("café" adds to a "Cafe" title, "okapi" does not add to "Okapi")
const hitForms = (segs) => new Set(segs.filter((x) => x.hit).map((x) => x.text.toLowerCase()));

/**
 * `match` for one result (00 §8). The snippet is plain text; `field` names
 * where it came from. A title (else filename) hit is shown unless the body's
 * excerpt has hit words the title does not (e.g. "café" for a "Cafe notes"
 * title, case aside) — then the body excerpt is shown and the field is `content`. The body
 * scan is capped at SNIPPET_SCAN_CHARS: a hit only beyond it yields the body's
 * opening words, unmarked.
 */
function matchFor(row, terms) {
  // #26: the best-ranked index row is a document file's → the snippet comes from that file
  const best = row.fts_rowid != null ? db.prepare('SELECT file_name, content FROM doc_fts WHERE rowid = ?').get(row.fts_rowid) : null;
  if (best && best.file_name) {
    const text = capped(best.content || '');
    const plain = /\.(md|markdown)$/i.test(best.file_name) ? markdownToPlain(text, { keepTags: true }) : text.replace(/\s+/g, ' ').trim();
    return { field: 'file', file: best.file_name, snippet: excerpt(plain, terms) || excerpt(plain, terms, { fallback: true }) };
  }
  const md = db.prepare('SELECT markdown FROM contents WHERE session_id = ?').get(row.id);
  const body = snippetText(row.content_type, capped(md ? md.markdown : ''));
  const content = excerpt(body, terms);
  const title = excerpt(row.title || '', terms);
  const filename = title ? null : excerpt(row.filename || '', terms);
  const head = title ? ['title', title] : filename ? ['filename', filename] : null;
  if (head) {
    const shown = hitForms(head[1]);
    if (!content || [...hitForms(content)].every((f) => shown.has(f))) return { field: head[0], file: null, snippet: head[1] };
  }
  return { field: 'content', file: null, snippet: content || excerpt(body, terms, { fallback: true }) };
}

const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s) {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'));
    return c && typeof c === 'object' && Number.isInteger(c.o) && c.o >= 0 && typeof c.f === 'string' ? c : null;
  } catch { return null; }
}

function libraryDocs(req, res) {
  const reader = readerKeyOf(req); // #26: decides `pinned` only
  if (reader.error) return send(res, 400, { error: 'invalid reader' });
  const params = new URL(req.url, 'http://x').searchParams;
  const get = (k) => (params.get(k) ?? '').trim();
  const q = get('q') || null;
  const sortParam = get('sort');
  if (sortParam && !SORTS.has(sortParam)) return send(res, 400, { error: 'invalid sort' });
  const mode = get('mode');
  if (mode && !isDocMode(mode)) return send(res, 400, { error: 'invalid mode' });
  const type = get('type');
  if (type && type !== 'md' && type !== 'html') return send(res, 400, { error: 'invalid type' });
  const updatedAfter = get('updated_after');
  if (updatedAfter && Number.isNaN(Date.parse(updatedAfter))) return send(res, 400, { error: 'invalid updated_after' });
  const collection = get('collection');
  const tag = get('tag');
  // #26: pinned=1 keeps only the X-MdReview-Reader reader's pins (ordered by pin time unless a sort is given)
  const pinnedParam = get('pinned');
  if (pinnedParam && pinnedParam !== '1' && pinnedParam !== '0') return send(res, 400, { error: 'invalid pinned' });
  const pinnedOnly = pinnedParam === '1';
  let limit = parseInt(get('limit'), 10);
  if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
  limit = Math.min(MAX_LIMIT, Math.max(1, limit));

  // relevance needs q (00 §8); views sorts by view_count (#25)
  let sort = sortParam || (q ? 'relevance' : pinnedOnly ? 'pinned' : 'updated');
  if (sort === 'relevance' && !q) sort = 'updated';

  // the cursor is bound to everything that decides the result set and its order
  const fingerprint = crypto.createHash('sha1')
    .update(JSON.stringify([q, collection, tag, mode, type, updatedAfter, sort, pinnedOnly, pinnedOnly ? reader.key : null])).digest('hex').slice(0, 16);
  let offset = 0;
  const cursorParam = get('cursor');
  if (cursorParam) {
    const c = decodeCursor(cursorParam);
    if (!c || c.f !== fingerprint) return send(res, 400, { error: 'invalid cursor' });
    offset = c.o;
  }

  const empty = () => send(res, 200, { query: q, total: 0, next_cursor: null, items: [] });
  const where = ['(s.expires_at IS NULL OR COALESCE(julianday(s.expires_at) >= julianday(?), 1))'];
  const args = [new Date().toISOString()];
  if (mode) { where.push('s.mode = ?'); args.push(mode); }
  if (type === 'html') where.push("s.content_type = 'html'");
  if (type === 'md') where.push("(s.content_type IS NULL OR s.content_type <> 'html')");
  if (updatedAfter) { where.push('julianday(s.updated_at) > julianday(?)'); args.push(new Date(Date.parse(updatedAfter)).toISOString()); }
  if (collection === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.session_id = s.id)');
  } else if (collection) {
    const col = db.prepare('SELECT id FROM collections WHERE id = ? OR slug = ? LIMIT 1').get(collection, collection);
    if (!col) return empty();
    where.push('EXISTS (SELECT 1 FROM collection_items ci WHERE ci.session_id = s.id AND ci.collection_id = ?)');
    args.push(col.id);
  }
  if (pinnedOnly) {
    if (!reader.key) return empty();
    where.push('EXISTS (SELECT 1 FROM pins p WHERE p.reader_key = ? AND p.session_id = s.id)');
    args.push(reader.key);
  }
  if (tag) {
    const t = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(tag);
    if (!t) return empty();
    where.push('EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = s.id AND st.tag_id = ?)');
    args.push(t.id);
  }

  let from = 'sessions s';
  let expr = null;
  const fromArgs = [];
  if (q) {
    expr = ftsQuery(q);
    if (!expr) return empty();
    // best-ranked index row per session (a session and its document files collapse into one item)
    from = `(SELECT session_id, fts_rowid, score FROM (
               SELECT session_id, fts_rowid, score, row_number() OVER (PARTITION BY session_id ORDER BY score, fts_rowid) AS rn
               FROM (SELECT session_id, rowid AS fts_rowid, bm25(doc_fts, 10, 5, 1) AS score FROM doc_fts WHERE doc_fts MATCH ?)
             ) WHERE rn = 1) m
            JOIN sessions s ON s.id = m.session_id`;
    fromArgs.push(expr);
  }
  const orderArgs = sort === 'pinned' ? [reader.key, reader.key] : [];
  const order = {
    pinned: `(SELECT p.pinned_at FROM pins p WHERE p.reader_key = ? AND p.session_id = s.id) DESC,
             (SELECT p.rowid FROM pins p WHERE p.reader_key = ? AND p.session_id = s.id) DESC, s.id`, // #26 (pinned=1 only)
    relevance: 'm.score ASC, s.updated_at DESC, s.id',
    updated: 's.updated_at DESC, s.id',
    created: 's.created_at DESC, s.id',
    title: 'lower(s.title) ASC, s.id',
    views: 'view_count DESC, s.updated_at DESC, s.id', // the selected column (#25)
  }[sort];

  const terms = q ? queryTerms(q) : [];
  let total; let page;
  try {
    total = db.prepare(`SELECT count(*) AS c FROM ${from} WHERE ${where.join(' AND ')}`).get(...fromArgs, ...args).c;
    page = db.prepare(`
      SELECT s.id, s.slug, s.title, s.filename, s.content_type, s.mode, s.created_by, s.created_at, s.updated_at,
             ${q ? 'm.fts_rowid' : 'NULL'} AS fts_rowid, s.edit_token_hash IS NOT NULL AS protected,
             (SELECT count(*) FROM files f WHERE f.session_id = s.id) AS file_count,
             (SELECT count(*) FROM reactions rx WHERE rx.session_id = s.id) AS reaction_count,
             (SELECT count(*) FROM views v WHERE v.session_id = s.id AND v.is_editor = 0) AS view_count,
             (SELECT COALESCE(sum(must_fix_open), 0) FROM comments c WHERE c.session_id = s.id) AS must_fix_unresolved,
             (SELECT json_object('id', co.id, 'name', co.name) FROM collection_items ci JOIN collections co ON co.id = ci.collection_id
               WHERE ci.session_id = s.id) AS collection_json,
             (SELECT json_group_array(t.name) FROM session_tags st JOIN tags t ON t.id = st.tag_id WHERE st.session_id = s.id) AS tags_json
      FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...fromArgs, ...args, ...orderArgs, limit, offset);
  } catch (e) {
    // q never causes a 4xx/5xx (00 §8): any query the index rejects matches nothing
    if (q) return empty();
    throw e;
  }

  const pinned = new Set();
  if (reader.key && page.length) {
    const marks = page.map(() => '?').join(', ');
    for (const p of db.prepare(`SELECT session_id FROM pins WHERE reader_key = ? AND session_id IN (${marks})`).all(reader.key, ...page.map((r) => r.id))) {
      pinned.add(p.session_id);
    }
  }
  const items = page.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title || 'Untitled',
    filename: r.filename,
    contentType: r.content_type === 'html' ? 'html' : 'markdown',
    mode: r.mode,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    collection: r.collection_json ? JSON.parse(r.collection_json) : null,
    tags: r.tags_json ? JSON.parse(r.tags_json).sort(compareTags) : [],
    file_count: r.file_count,
    reaction_count: r.reaction_count, // #24
    view_count: r.view_count, // #25: total_views (non-editor reader-days)
    must_fix_unresolved: r.must_fix_unresolved,
    pinned: pinned.has(r.id), // #26: for the X-MdReview-Reader reader
    protected: r.protected === 1, // #26: has an edit token (legacy link-editable docs: false)
    match: q ? matchFor(r, terms) : null,
  }));
  const next = offset + page.length < total ? encodeCursor({ o: offset + page.length, f: fingerprint }) : null;
  return send(res, 200, { query: q, total, next_cursor: next, items });
}

module.exports = async function libraryDocsRoute(req, res) {
  if (req.method === 'GET' && /^\/library\/docs(?:\?|$)/.test(req.url)) return libraryDocs(req, res);
  return NEXT;
};
