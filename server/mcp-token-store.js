// Persistent edit-token store for the MCP servers (#23 rule 11).
//
// One JSON file maps doc id and slug → edit token, shared by every MCP
// connection and by the stdio and HTTP servers on this machine: the HTTP
// transport silently re-creates sessions, so a per-connection cache would lose
// tokens. The file is re-read on every lookup (another process may have
// written it), written atomically (temp file + rename) and kept at mode 0600.
// Path: MCP_TOKEN_STORE, default server/mcp-state/edit-tokens.json (gitignored).
// Keys are `${pasteApiUrl}|${idOrSlug}` (see createTokenStore).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TOKEN_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-state', 'edit-tokens.json');

/** File name used when MCP_TOKEN_STORE names a directory. */
export const TOKEN_STORE_FILE = 'edit-tokens.json';

/**
 * The store path for this process: MCP_TOKEN_STORE when set, else the default.
 * MCP_TOKEN_STORE may name the file or a directory (an existing one, or a path
 * ending in "/"): then the store is <dir>/edit-tokens.json.
 */
export function tokenStorePath(env = process.env) {
  if (!env.MCP_TOKEN_STORE) return DEFAULT_TOKEN_STORE;
  const p = path.resolve(env.MCP_TOKEN_STORE);
  if (/[\\/]$/.test(env.MCP_TOKEN_STORE)) return path.join(p, TOKEN_STORE_FILE);
  try { if (fs.statSync(p).isDirectory()) return path.join(p, TOKEN_STORE_FILE); } catch { /* not there yet: a file path */ }
  return p;
}

/**
 * Startup check (both MCP servers): the store's directory can be created and
 * written, and the store itself, if present, is a writable file. Throws an
 * Error naming the path and the fix — a store that silently fails to persist
 * would make every remembered edit token vanish on restart.
 */
export function checkTokenStore(file = tokenStorePath()) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    if (fs.existsSync(file)) {
      if (!fs.statSync(file).isFile()) throw new Error('it exists and is not a regular file');
      fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    }
  } catch (e) {
    throw new Error(`edit-token store ${file} is not usable (${e.message}). Set MCP_TOKEN_STORE to a writable file path (or a directory: <dir>/${TOKEN_STORE_FILE} is used).`);
  }
  return file;
}

const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 3000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Normalised store scope for a paste API URL (trailing slashes ignored). */
export const scopeOf = (apiUrl) => String(apiUrl || '').replace(/\/+$/, '');

/**
 * `scope` (the paste API URL the handlers talk to) prefixes every key as
 * `${scope}|${idOrSlug}`, so two backends' docs with the same id or slug never
 * share a token. Entries written before scoping (bare id/slug keys) are still
 * read as a fallback and are replaced by the scoped key on the next save.
 */
export function createTokenStore(file = tokenStorePath(), { scope } = {}) {
  const prefix = scope ? `${scopeOf(scope)}|` : '';
  const scoped = (key) => `${prefix}${key}`;

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** A store that exists but does not parse is copied aside before the first write replaces it (tokens are never silently lost). */
  function backupIfCorrupt() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { return; }
    if (!raw.trim()) return;
    try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) return; } catch { /* corrupt */ }
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
      fs.chmodSync(backup, 0o600);
      console.error(`[md-review mcp] token store ${file} was not valid JSON; kept a copy at ${backup} and started a new store`);
    } catch (e) { console.error(`[md-review mcp] token store ${file} is corrupt and could not be backed up: ${e.message}`); }
  }

  function write(map) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600); // umask never widens it
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Read → change → write under `${file}.lock` (O_EXCL), so concurrent MCP
   * processes never drop each other's entries. A lock older than
   * LOCK_STALE_MS (a crashed writer) is broken; after LOCK_WAIT_MS we write
   * anyway (the re-read just before the rename still merges almost everything).
   */
  function update(change) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
        } catch { continue; /* vanished meanwhile */ }
        if (Date.now() > deadline) break;
        sleepSync(10);
      }
    }
    try {
      backupIfCorrupt();
      const map = read();
      if (change(map)) write(map);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  const safely = (fn) => {
    try { update(fn); } catch (e) { console.error(`[md-review mcp] could not write token store ${file}: ${e.message}`); }
  };

  return {
    file,
    /** The token stored for a doc id or slug (scoped key first, then a pre-scoping bare key), else null. */
    get(key) {
      if (!key) return null;
      const map = read();
      const t = map[scoped(key)] ?? (prefix ? map[key] : undefined);
      return typeof t === 'string' && t ? t : null;
    },
    /** Map every given key (id, slug — falsy ones skipped) to `token`. Best effort: a failed write never fails the tool call. */
    save(keys, token) {
      if (!token) return;
      safely((map) => {
        let changed = false;
        for (const k of keys) {
          if (!k) continue;
          if (map[scoped(k)] !== token) { map[scoped(k)] = token; changed = true; }
          if (prefix && Object.hasOwn(map, k)) { delete map[k]; changed = true; } // migrate a bare key
        }
        return changed;
      });
    },
    /** Drop every key that maps to `token` (the doc was deleted, so a reused slug must not inherit it). */
    forget(token) {
      if (!token) return;
      safely((map) => {
        const keys = Object.keys(map).filter((k) => map[k] === token);
        for (const k of keys) delete map[k];
        return keys.length > 0;
      });
    },
  };
}
