import { readFileSync, statSync } from 'node:fs';

import config from './config.js';

/**
 * Netscape cookies.txt reader for the bring-your-own-subscription lane.
 *
 * You export cookies from a browser where YOU are signed in to outlets YOU pay
 * for, and wire replays that session to read the articles your subscription
 * already entitles you to. Nothing here defeats an access control: it presents
 * your own credentials to a service that issued them.
 *
 * Format (tab-separated, one cookie per line):
 *   domain  includeSubdomains  path  secure  expiry  name  value
 */

const FIELDS = 7;

let cache = { mtimeMs: 0, jar: new Map() };

function parseJar(raw) {
  const jar = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // "#HttpOnly_" is a curl extension prefix, not a comment.
    const normalized = trimmed.startsWith('#HttpOnly_') ? trimmed.slice(10) : trimmed;
    if (!normalized || normalized.startsWith('#')) continue;

    const parts = normalized.split('\t');
    if (parts.length < FIELDS) continue;

    const [domainRaw, , path, , expiry, name, ...valueParts] = parts;
    const value = valueParts.join('\t');
    if (!name || value === undefined) continue;

    const expires = Number(expiry);
    if (expires && expires > 0 && expires * 1000 < Date.now()) continue; // stale

    const domain = domainRaw.replace(/^\./, '').toLowerCase();
    if (!domain) continue;

    if (!jar.has(domain)) jar.set(domain, []);
    jar.get(domain).push({ name, value, path: path || '/', expires });
  }
  return jar;
}

/** Reloads only when the file changes, so a fresh export is picked up live. */
function loadJar() {
  let stat;
  try {
    stat = statSync(config.cookieJarPath);
  } catch {
    return new Map();
  }
  if (stat.mtimeMs === cache.mtimeMs) return cache.jar;

  try {
    const jar = parseJar(readFileSync(config.cookieJarPath, 'utf8'));
    cache = { mtimeMs: stat.mtimeMs, jar };
    return jar;
  } catch {
    return cache.jar;
  }
}

/** Domains we hold a session for. Used by the doctor and the planner. */
export function jarDomains() {
  return [...loadJar().keys()].sort();
}

/** Builds a Cookie header for a URL, or '' when we hold no session for it. */
export function cookieHeaderFor(url) {
  const jar = loadJar();
  if (!jar.size) return '';

  let target;
  try {
    target = new URL(url);
  } catch {
    return '';
  }

  const host = target.hostname.toLowerCase().replace(/^www\./, '');
  const pairs = [];
  const seen = new Set();

  for (const [domain, cookies] of jar) {
    // A cookie set on example.com is sent to news.example.com, not the reverse.
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    for (const cookie of cookies) {
      if (!target.pathname.startsWith(cookie.path)) continue;
      if (seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
  }

  return pairs.join('; ');
}

export function hasSessionFor(url) {
  return cookieHeaderFor(url).length > 0;
}

export { parseJar };
