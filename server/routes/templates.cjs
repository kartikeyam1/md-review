'use strict';
// Routes: templates (#27, 00 §4.9) — returns NEXT when the request is not one of its own.
//   GET    /templates                    list (no content; with variables), builtins first then by name
//   GET    /templates/:id                one template, with content
//   POST   /templates                    save (201); name clash → 409 unless replace:true on a user template (200)
//   PATCH  /templates/:id                rename / description / collectionId; builtin → 403
//   DELETE /templates/:id                204; builtin → 403
//   POST   /templates/:id/render         dry run → {content}; creates nothing
//   POST   /templates/:id/instantiate    create a doc from it → 201 {id, slug, url, editToken, editUrl, …}
//
// Storage: the `templates` table (#20): id, name, created_by, created_at, updated_at, and data_json =
// {description, content, contentType, mode, collectionId, builtin, variables}. `variables` (rule 8) is
// computed on write, so the list reads every row without its content (rows written before it existed
// fall back to scanning their content). Seed templates (server/templates/
// manifest.json + one file each) are upserted at boot; only builtin rows are ever touched by that.
// A collectionId whose collection no longer exists reads as null (rule 3) — no #26 hook needed.
// "Now" for {{date}}/{{week}} honours the MDREVIEW_NOW test clock (00 §10.5, #25).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NEXT, readJsonBody, clientOf } = require('../http-util.cjs');
const { db, generateSlug, uniqueSlug, savePaste } = require('../storage.cjs');
const { tx } = require('../db.cjs');
const { isDocMode, MODE_ERROR } = require('../mode.cjs');
const { handedOutUrl, appUrl } = require('../links.cjs');
const { newToken, hashToken, editUrlFor } = require('./edit-tokens.cjs');
const { normalizeExpiryDays, expiresAtFor } = require('../../shared/expiry.mjs');
const vars = require('../template-vars.cjs');

const SEED_DIR = path.join(__dirname, '..', 'templates');
const MAX_NAME = 80;
const MAX_DESCRIPTION = 280;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_TITLE = 200;
const CONTENT_TYPES = new Set(['markdown', 'html']);

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const nowMs = () => {
  const t = process.env.MDREVIEW_NOW ? Date.parse(process.env.MDREVIEW_NOW) : NaN;
  return Number.isFinite(t) ? t : Date.now();
};
const nameKey = (n) => String(n).trim().toLowerCase();

// ── rows ────────────────────────────────────────────────────────────────────

function decodeRow(r) {
  let data = {};
  try { data = JSON.parse(r.data_json || '{}') || {}; } catch { /* corrupt row: treat as empty */ }
  return {
    id: r.id,
    name: r.name,
    description: typeof data.description === 'string' ? data.description : '',
    content: typeof data.content === 'string' ? data.content : '',
    contentType: data.contentType === 'html' ? 'html' : 'markdown',
    mode: isDocMode(data.mode) ? data.mode : 'publish',
    collectionId: typeof data.collectionId === 'string' ? data.collectionId : null,
    builtin: data.builtin === true,
    variables: Array.isArray(data.variables) && data.variables.every((v) => typeof v === 'string') ? data.variables : null,
    created_by: r.created_by ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}
const encodeData = (t) => JSON.stringify({
  description: t.description, content: t.content, contentType: t.contentType, mode: t.mode,
  collectionId: t.collectionId, builtin: t.builtin, variables: vars.listVariables(t.content),
});
/** Every row without its content (up to 1 MB each): the list and name checks never need it. */
const LIGHT_ROWS_SQL = `SELECT id, name, created_by, created_at, updated_at,
  CASE WHEN json_valid(data_json) THEN json_remove(data_json, '$.content') ELSE '{}' END AS data_json
  FROM templates`;

function getTemplate(id) {
  const r = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  return r ? decodeRow(r) : null;
}
/** Manifest position of each seed id (set by upsertSeeds): builtins list in manifest order. */
let seedOrder = new Map();
const seedRank = (id) => (seedOrder.has(id) ? seedOrder.get(id) : Number.MAX_SAFE_INTEGER);
function allTemplates() {
  return db.prepare(LIGHT_ROWS_SQL).all().map(decodeRow)
    // A row from before `variables` was stored: read its content once to list them.
    .map((t) => (t.variables ? t : { ...t, variables: vars.listVariables((getTemplate(t.id) || t).content) }))
    .sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1)
      || (a.builtin ? seedRank(a.id) - seedRank(b.id) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      || a.id.localeCompare(b.id));
}
/** The template whose name equals `name` case-insensitively (trimmed), other than `exceptId`. */
function byName(name, exceptId = null) {
  const key = nameKey(name);
  const hit = db.prepare('SELECT id, name FROM templates').all().find((r) => r.id !== exceptId && nameKey(r.name) === key);
  return hit ? getTemplate(hit.id) : null;
}

const collectionById = (id) => (typeof id === 'string'
  ? db.prepare('SELECT id, name FROM collections WHERE id = ?').get(id) || null
  : null);
/** A collection by id, slug or name (case-insensitive) — the MCP `collection` argument. */
function collectionByRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const r = ref.trim();
  return db.prepare('SELECT id, name FROM collections WHERE id = ? OR slug = ?').get(r, r)
    || db.prepare('SELECT id, name FROM collections WHERE lower(trim(name)) = lower(?) LIMIT 1').get(r)
    || null;
}
function unknownCollectionError(ref) {
  const names = db.prepare('SELECT name FROM collections').all().map((c) => c.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { error: `Unknown collection "${ref}". ${names.length ? `Available collections: ${names.join(', ')}` : 'No collections exist yet'}.`,
    code: 'unknown_collection', available: names };
}

/** Public shape. The collection is resolved now, so a deleted one reads as null. */
function view(t, { withContent = false } = {}) {
  const col = collectionById(t.collectionId);
  const out = {
    id: t.id, name: t.name, description: t.description, contentType: t.contentType, mode: t.mode,
    collectionId: col ? col.id : null, collection: col ? { id: col.id, name: col.name } : null,
    builtin: t.builtin, created_by: t.created_by, created_at: t.created_at, updated_at: t.updated_at,
    variables: t.variables || vars.listVariables(t.content),
  };
  if (withContent) out.content = t.content;
  return out;
}

// ── seeds (boot) ────────────────────────────────────────────────────────────

/** Upsert builtin templates from server/templates/; never touches user rows. Exported for tests/tools. */
function upsertSeeds() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'manifest.json'), 'utf-8')); }
  catch (e) { console.error(`[md-review] seed templates not loaded: ${e.message}`); return; }
  seedOrder = new Map(manifest.map((s, i) => [s.id, i]));
  const now = new Date().toISOString();
  tx(db, () => {
    const ids = [];
    for (const s of manifest) {
      const content = fs.readFileSync(path.join(SEED_DIR, s.file), 'utf-8');
      const data = encodeData({ description: s.description, content, contentType: s.contentType, mode: s.mode, collectionId: null, builtin: true });
      ids.push(s.id);
      const prev = db.prepare('SELECT name, data_json FROM templates WHERE id = ?').get(s.id);
      // A user template already holding this seed's name would break name uniqueness; warn (the seed still wins its id).
      const holder = byName(s.name, s.id);
      if (holder && !holder.builtin) {
        console.warn(`[md-review] seed template "${s.name}" (${s.id}) has the same name as user template ${holder.id}; rename one of them`);
      }
      if (!prev) {
        db.prepare('INSERT INTO templates (id, name, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
          .run(s.id, s.name, data, now, now);
      } else if (prev.name !== s.name || prev.data_json !== data) {
        db.prepare('UPDATE templates SET name = ?, data_json = ?, updated_at = ? WHERE id = ?').run(s.name, data, now, s.id);
      }
    }
    // A seed dropped from the manifest goes away (builtin rows only).
    for (const t of db.prepare(LIGHT_ROWS_SQL).all().map(decodeRow)) {
      if (t.builtin && !ids.includes(t.id)) db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
    }
  });
}
upsertSeeds();

// ── validation ──────────────────────────────────────────────────────────────

function checkName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'name is required' };
  const name = raw.trim();
  if (name.length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };
  return { name };
}
function checkDescription(raw) {
  if (raw === undefined || raw === null) return { description: '' };
  if (typeof raw !== 'string') return { error: 'description must be a string' };
  const description = raw.trim();
  if (description.length > MAX_DESCRIPTION) return { error: `description must be at most ${MAX_DESCRIPTION} characters` };
  return { description };
}
/** collectionId: undefined (keep / none), null (unfiled), or an existing collection id. */
function checkCollectionId(raw) {
  if (raw === undefined) return {};
  if (raw === null) return { collectionId: null };
  const col = collectionById(raw);
  return col ? { collectionId: col.id, collection: col } : { error: true, body: unknownCollectionError(raw) };
}
function clash(res, other) {
  return send(res, 409, {
    error: other.builtin ? `"${other.name}" is a built-in template name` : `A template named "${other.name}" already exists`,
    code: 'name_taken', builtin: other.builtin, id: other.id, name: other.name,
  });
}

/**
 * The shared part of render / instantiate: the target collection (body `collectionId`, else body
 * `collection` id|slug|name, else the template's default) and the substituted content.
 */
function prepareRender(t, body) {
  const verr = vars.validateVariables(body.variables);
  if (verr) return { status: 400, error: { error: verr } };
  let collection = null;
  if (body.collectionId !== undefined) {
    const c = checkCollectionId(body.collectionId);
    if (c.error) return { status: 400, error: unknownCollectionError(body.collectionId) };
    collection = c.collection || null;
  } else if (body.collection !== undefined && body.collection !== null) {
    collection = collectionByRef(body.collection);
    if (!collection) return { status: 400, error: unknownCollectionError(body.collection) };
  } else if (body.collection === undefined) {
    collection = collectionById(t.collectionId); // a deleted default reads as null → unfiled
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = vars.renderTemplate(t, {
    title, author: typeof body.author === 'string' ? body.author : null, collection: collection ? collection.name : null,
    variables: body.variables, now: nowMs(), timezone: body.timezone,
  });
  return { collection, title, content };
}

// ── handlers ────────────────────────────────────────────────────────────────

async function create(req, res) {
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Invalid body' });
  const n = checkName(body.name); if (n.error) return send(res, 400, n);
  const d = checkDescription(body.description); if (d.error) return send(res, 400, d);
  if (typeof body.content !== 'string') return send(res, 400, { error: 'content is required' });
  if (Buffer.byteLength(body.content, 'utf-8') > MAX_CONTENT_BYTES) return send(res, 400, { error: 'Template content is larger than 1 MB' });
  const contentType = body.contentType === undefined ? 'markdown' : body.contentType;
  if (!CONTENT_TYPES.has(contentType)) return send(res, 400, { error: "contentType must be 'markdown' or 'html'" });
  if (body.mode !== undefined && !isDocMode(body.mode)) return send(res, 400, MODE_ERROR);
  const c = checkCollectionId(body.collectionId); if (c.error) return send(res, 400, c.body);
  const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim() : null;
  const now = new Date().toISOString();

  const result = tx(db, () => {
    const other = byName(n.name);
    if (other && (other.builtin || body.replace !== true)) return { clash: other };
    const t = {
      id: other ? other.id : `tpl-${crypto.randomBytes(6).toString('hex')}`,
      // Replace keeps the existing template's name (the clash was case/space-insensitive; renaming is PATCH's job).
      name: other ? other.name : n.name, description: d.description, content: body.content, contentType,
      mode: body.mode || 'publish', collectionId: c.collectionId ?? null, builtin: false,
    };
    if (other) {
      db.prepare('UPDATE templates SET name = ?, data_json = ?, updated_at = ? WHERE id = ?').run(t.name, encodeData(t), now, t.id);
    } else {
      db.prepare('INSERT INTO templates (id, name, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(t.id, t.name, encodeData(t), author, now, now);
    }
    return { replaced: !!other, t: getTemplate(t.id) };
  });
  if (result.clash) return clash(res, result.clash);
  return send(res, result.replaced ? 200 : 201, view(result.t, { withContent: true }));
}

async function patch(req, res, id) {
  // Existence and the builtin check come before the body, so a seed answers 403 whatever is sent.
  const t = getTemplate(id);
  if (!t) return send(res, 404, { error: 'Template not found' });
  if (t.builtin) return send(res, 403, { error: 'Built-in templates cannot be changed' });
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Invalid body' });
  const next = { ...t };
  if (body.name !== undefined) { const n = checkName(body.name); if (n.error) return send(res, 400, n); next.name = n.name; }
  if (body.description !== undefined) { const d = checkDescription(body.description); if (d.error) return send(res, 400, d); next.description = d.description; }
  if (body.collectionId !== undefined) {
    const c = checkCollectionId(body.collectionId); if (c.error) return send(res, 400, c.body);
    next.collectionId = c.collectionId;
  }
  const result = tx(db, () => {
    const other = next.name !== t.name ? byName(next.name, id) : null;
    if (other) return { clash: other };
    db.prepare('UPDATE templates SET name = ?, data_json = ?, updated_at = ? WHERE id = ?')
      .run(next.name, encodeData(next), new Date().toISOString(), id);
    return { t: getTemplate(id) };
  });
  if (result.clash) return clash(res, result.clash);
  return send(res, 200, view(result.t));
}

function remove(res, id) {
  const t = getTemplate(id);
  if (!t) return send(res, 404, { error: 'Template not found' });
  if (t.builtin) return send(res, 403, { error: 'Built-in templates cannot be deleted' });
  db.prepare('DELETE FROM templates WHERE id = ?').run(id); // docs made from it keep their from_template copy
  res.writeHead(204);
  return res.end();
}

async function render(req, res, id) {
  const body = await readJsonBody(req, res, { optional: true });
  if (body === undefined) return;
  const t = getTemplate(id);
  if (!t) return send(res, 404, { error: 'Template not found' });
  const p = prepareRender(t, body && typeof body === 'object' ? body : {});
  if (p.error) return send(res, p.status, p.error);
  return send(res, 200, { content: p.content });
}

async function instantiate(req, res, id) {
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const t = getTemplate(id);
  if (!t) return send(res, 404, { error: 'Template not found' });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Invalid body' });
  if (typeof body.title !== 'string' || !body.title.trim()) return send(res, 400, { error: 'title is required' });
  if (body.title.trim().length > MAX_TITLE) return send(res, 400, { error: `title must be at most ${MAX_TITLE} characters` });
  if (body.slug !== undefined && body.slug !== null && typeof body.slug !== 'string') return send(res, 400, { error: 'slug must be a string' });
  const p = prepareRender(t, body);
  if (p.error) return send(res, p.status, p.error);

  // Rule 13: a new doc exactly like POST /paste would make it, plus collection + provenance.
  const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim() : null;
  const base = generateSlug(p.title) || 'untitled';
  const slugBase = (typeof body.slug === 'string' && generateSlug(body.slug)) || generateSlug(p.title);
  const fromTemplate = { id: t.id, name: t.name };
  const meta = {
    sessionName: p.title,
    filename: `${base}.${t.contentType === 'html' ? 'html' : 'md'}`,
    contentType: t.contentType,
    mode: t.mode, // 00 §1.4: the template's mode
    approval_status: 'pending',
    sharedAt: new Date().toISOString(),
    comments: [],
    markdown: p.content,
  };
  const days = body.expiryDays === undefined ? 30 : normalizeExpiryDays(body.expiryDays);
  if (days !== null) meta.expires_at = expiresAtFor(days);
  const docId = crypto.randomBytes(6).toString('hex');
  const editToken = newToken();
  const created = tx(db, () => {
    // Re-check the collection inside the transaction: one deleted since prepareRender files the doc as unfiled.
    const col = p.collection ? collectionById(p.collection.id) : null;
    const s = slugBase ? uniqueSlug(slugBase) : null;
    if (s) meta.slug = s;
    savePaste(docId, meta, { by: author, client: clientOf(req) }, { claimSlugs: s ? [s] : [], createdBy: author, editTokenHash: hashToken(editToken) });
    db.prepare('UPDATE sessions SET from_template_json = ? WHERE id = ?').run(JSON.stringify(fromTemplate), docId);
    if (col) {
      db.prepare('INSERT INTO collection_items (session_id, collection_id, added_at) VALUES (?, ?, ?)')
        .run(docId, col.id, new Date().toISOString());
    }
    return { slug: s, collection: col };
  });
  const { slug, collection } = created;
  const x = slug || docId;
  // The body carries the raw edit token: never cache it (#23).
  return send(res, 201, {
    id: docId, slug, mode: t.mode, url: handedOutUrl(x), viewUrl: handedOutUrl(x), app_url: appUrl(x),
    editToken, editUrl: editUrlFor(x, editToken),
    collection: collection ? { id: collection.id, name: collection.name } : null,
  }, { 'Cache-Control': 'no-store' });
}

module.exports = async function templates(req, res) {
  const u = req.url.split('?')[0];
  if (u === '/templates') {
    if (req.method === 'GET') return send(res, 200, allTemplates().map((t) => view(t)));
    if (req.method === 'POST') return create(req, res);
    return NEXT;
  }
  const m = u.match(/^\/templates\/([A-Za-z0-9_-]{1,64})(\/render|\/instantiate)?$/);
  if (!m) return NEXT;
  const [, id, sub] = m;
  if (!sub) {
    if (req.method === 'GET') {
      const t = getTemplate(id);
      return t ? send(res, 200, view(t, { withContent: true })) : send(res, 404, { error: 'Template not found' });
    }
    if (req.method === 'PATCH') return patch(req, res, id);
    if (req.method === 'DELETE') return remove(res, id);
    return NEXT;
  }
  if (req.method !== 'POST') return NEXT;
  return sub === '/render' ? render(req, res, id) : instantiate(req, res, id);
};
Object.assign(module.exports, { upsertSeeds });
