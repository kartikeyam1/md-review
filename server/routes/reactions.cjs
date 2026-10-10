'use strict';
// Reactions (#24): a fixed emoji set on the whole doc (section '') or on one
// heading (section = its id). One row per (doc, section, code, reader browser);
// a reaction is an open reader action — no edit token, even on protected docs.
//
//   POST /paste/:id/reactions  {code, section?, reader_id, name?, on?}
//     on absent → toggle; on true|false → set idempotently. A repeat "on" with a
//     different name updates the name. → {active, code, section, summary}
//   GET  /paste/:id/reactions?reader_id=  → summary
//
// The server never parses headings: reactions on a section that no longer
// exists are still returned (the UI hides them). Returns NEXT otherwise.
const { NEXT, readJsonBody } = require('../http-util.cjs');
const { db, resolveId, loadMeta, isExpired } = require('../storage.cjs');
const {
  REACTIONS, REACTION_CODES, READER_ID_RE, SECTION_RE, normalizeReaderName,
} = require('../../shared/reactions.mjs');

/** `names` lists at most this many distinct names per group (count stays exact). */
const NAMES_MAX = 20;
const ORDER = new Map(REACTION_CODES.map((c, i) => [c, i]));
const EMOJI = new Map(REACTIONS.map((r) => [r.code, r.emoji]));

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * The GET body for a doc: {total, doc: Group[], sections: {id: Group[]}}, Group =
 * {code, emoji, count, names, anonymous, mine}. Codes in the fixed order, only
 * count > 0; names distinct and most recent first.
 */
function reactionSummary(sessionId, readerId = null) {
  const rows = db.prepare('SELECT section, code, reader_id, name FROM reactions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(sessionId);
  const groups = new Map(); // section → code → group
  for (const r of rows) {
    if (!ORDER.has(r.code)) continue; // never written (validated), but never served either
    let bySection = groups.get(r.section);
    if (!bySection) groups.set(r.section, (bySection = new Map()));
    let g = bySection.get(r.code);
    if (!g) bySection.set(r.code, (g = { code: r.code, emoji: EMOJI.get(r.code), count: 0, names: [], anonymous: 0, mine: false, seen: new Set() }));
    g.count++;
    if (r.name) {
      if (!g.seen.has(r.name)) { g.seen.add(r.name); if (g.names.length < NAMES_MAX) g.names.push(r.name); }
    } else {
      g.anonymous++;
    }
    if (readerId && r.reader_id === readerId) g.mine = true;
  }
  const list = (bySection) => [...bySection.values()]
    .sort((a, b) => ORDER.get(a.code) - ORDER.get(b.code))
    .map(({ seen, ...g }) => g);
  // Null-prototype map: a section id such as `__proto__` stays an ordinary key.
  const out = { total: rows.length, doc: [], sections: Object.create(null) };
  for (const [section, bySection] of groups) {
    if (section === '') out.doc = list(bySection);
    else out.sections[section] = list(bySection);
  }
  return out;
}

/** The doc for a reactions/views request: { id } or a sent 404/410. Shared with views.cjs (#25). */
function openDoc(res, idOrSlug) {
  const id = resolveId(idOrSlug);
  const meta = id && loadMeta(id);
  if (!meta) { send(res, 404, { error: 'not found' }); return null; }
  if (isExpired(meta)) { send(res, 410, { error: 'Session expired' }); return null; }
  return { id, meta };
}

/** 00 §7 reader_id validation: the id, or null when invalid. */
const validReaderId = (v) => (typeof v === 'string' && READER_ID_RE.test(v) ? v : null);

/** Body → { code, section ('' = doc), readerId, name, on } or { error } (400 body). */
function readReaction(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: { error: 'Body must be a JSON object' } };
  if (!ORDER.has(body.code)) return { error: { error: 'Unknown reaction', code: 'invalid_reaction' } };
  const readerId = validReaderId(body.reader_id);
  if (!readerId) return { error: { error: 'Invalid reader_id', code: 'invalid_reader' } };
  let section = '';
  if (body.section !== undefined && body.section !== null && body.section !== '') {
    if (typeof body.section !== 'string' || !SECTION_RE.test(body.section)) return { error: { error: 'Invalid section', code: 'invalid_section' } };
    section = body.section;
  }
  if (body.on !== undefined && typeof body.on !== 'boolean') return { error: { error: 'on must be a boolean' } };
  return { code: body.code, section, readerId, name: normalizeReaderName(body.name), on: body.on };
}

module.exports = async function reactions(req, res) {
  const m = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/reactions(?:\?(.*))?$/);
  if (!m || (req.method !== 'GET' && req.method !== 'POST')) return NEXT;

  if (req.method === 'GET') {
    const doc = openDoc(res, m[1]);
    if (!doc) return;
    // An absent or malformed reader_id only means "no `mine`" — a read never fails on it.
    const readerId = validReaderId(new URLSearchParams(m[2] || '').get('reader_id'));
    return send(res, 200, reactionSummary(doc.id, readerId));
  }

  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const doc = openDoc(res, m[1]);
  if (!doc) return;
  const r = readReaction(body);
  if (r.error) return send(res, 400, r.error);

  const key = [doc.id, r.section, r.code, r.readerId];
  const existing = db.prepare('SELECT name FROM reactions WHERE session_id = ? AND section = ? AND code = ? AND reader_id = ?').get(...key);
  const active = r.on === undefined ? !existing : r.on;
  if (active && !existing) {
    db.prepare('INSERT INTO reactions (session_id, section, code, reader_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(...key, r.name, new Date().toISOString());
  } else if (active && existing && (existing.name ?? null) !== r.name) {
    db.prepare('UPDATE reactions SET name = ? WHERE session_id = ? AND section = ? AND code = ? AND reader_id = ?').run(r.name, ...key);
  } else if (!active && existing) {
    db.prepare('DELETE FROM reactions WHERE session_id = ? AND section = ? AND code = ? AND reader_id = ?').run(...key);
  }
  return send(res, 200, { active, code: r.code, section: r.section || null, summary: reactionSummary(doc.id, r.readerId) });
};

Object.assign(module.exports, { reactionSummary, openDoc, validReaderId });
