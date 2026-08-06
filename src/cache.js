import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import config from './config.js';

/**
 * Two tiers, because the two access patterns are different.
 *
 * Hot: an in-process LRU. When a link gets posted into a group chat and four
 * people tap it at once, everyone after the first should get an instant answer
 * without touching disk.
 *
 * Durable: sqlite. A link that made the rounds this morning is still resolved
 * this afternoon, and restarting the bot does not throw the work away.
 * node:sqlite ships with Node, so this costs zero native dependencies.
 */

const HOT_MAX = 512;
const hot = new Map();

function hotGet(key) {
  const entry = hot.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    hot.delete(key);
    return undefined;
  }
  // Reinsert to mark most-recently-used.
  hot.delete(key);
  hot.set(key, entry);
  return entry.value;
}

function hotSet(key, value, ttlMs) {
  hot.set(key, { value, expires: Date.now() + ttlMs });
  while (hot.size > HOT_MAX) hot.delete(hot.keys().next().value);
}

let db = null;

function database() {
  if (db) return db;
  try {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);

      CREATE TABLE IF NOT EXISTS resolutions (
        id          TEXT PRIMARY KEY,
        url         TEXT NOT NULL,
        title       TEXT,
        outlet      TEXT,
        route       TEXT,
        gated       INTEGER,
        summary     TEXT,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resolutions_created ON resolutions (created_at DESC);
    `);
    db.exec('PRAGMA journal_mode = WAL');
  } catch (err) {
    // A read-only or otherwise unusable disk must not take the resolver down.
    // The hot tier alone is still a working cache.
    process.emitWarning(`wire: durable cache unavailable (${err.message}), using memory only`);
    db = null;
  }
  return db;
}

export function cacheGet(key) {
  const fromHot = hotGet(key);
  if (fromHot !== undefined) return fromHot;

  const handle = database();
  if (!handle) return undefined;
  try {
    const row = handle
      .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
      .get(key);
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      handle.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return undefined;
    }
    const value = JSON.parse(row.value);
    hotSet(key, value, Math.min(row.expires_at - Date.now(), 60_000));
    return value;
  } catch {
    return undefined;
  }
}

export function cacheSet(key, value, ttlMs) {
  hotSet(key, value, Math.min(ttlMs, 60_000));
  const handle = database();
  if (!handle) return;
  try {
    handle
      .prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(value), Date.now() + ttlMs);
  } catch {
    /* memory tier already holds it */
  }
}

/** Read-through helper. Never lets a cache failure break the caller. */
export async function cached(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  if (value !== undefined && value !== null) cacheSet(key, value, ttlMs);
  return value;
}

/** Persists a finished resolution so /recent and the permalink page can show it. */
export function recordResolution(result) {
  const handle = database();
  if (!handle) return;
  try {
    handle
      .prepare(
        `INSERT OR REPLACE INTO resolutions
           (id, url, title, outlet, route, gated, summary, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.url,
        result.title || null,
        result.outlet || null,
        result.route || null,
        result.gated ? 1 : 0,
        result.summary?.headline || null,
        JSON.stringify(result),
        Date.now()
      );
  } catch {
    /* non-fatal */
  }
}

export function getResolution(id) {
  const handle = database();
  if (!handle) return null;
  try {
    const row = handle.prepare('SELECT payload FROM resolutions WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  } catch {
    return null;
  }
}

export function recentResolutions(limit = 25) {
  const handle = database();
  if (!handle) return [];
  try {
    return handle
      .prepare(
        `SELECT id, url, title, outlet, route, gated, summary, created_at
           FROM resolutions ORDER BY created_at DESC LIMIT ?`
      )
      .all(Math.min(limit, 100));
  } catch {
    return [];
  }
}

/** Drops expired rows. Called on an interval by the server. */
export function sweepCache() {
  const handle = database();
  if (!handle) return 0;
  try {
    const info = handle.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now());
    return info.changes || 0;
  } catch {
    return 0;
  }
}
