import { safeFetch } from '../fetch.js';
import { extractFromHtml } from '../extract.js';
import { classifyAccess } from '../paywall.js';
import { cached } from '../cache.js';

/**
 * archive.today, via its Memento TimeMap.
 *
 * Same posture as the wayback lane: look up snapshots that already exist, never
 * submit one. Submission takes tens of seconds, which is outside the budget by
 * an order of magnitude, and asking a third party to make a fresh copy of gated
 * content is not a line worth walking up to.
 *
 * This lane is flaky by nature. The service sits behind an interstitial, rotates
 * domains, and rate limits anonymous callers. It gets a short timeout and its
 * failures are unremarkable.
 */

const MIRRORS = ['archive.ph', 'archive.today', 'archive.is'];

/** TimeMap lines look like: <https://archive.ph/XXXX>; rel="memento"; datetime="..." */
function parseTimeMap(body) {
  const entries = [];
  for (const line of body.split('\n')) {
    if (!line.includes('rel=') || !line.includes('memento')) continue;
    const href = line.match(/<([^>]+)>/)?.[1];
    if (!href) continue;
    const datetime = line.match(/datetime="([^"]+)"/)?.[1] || '';
    entries.push({ href, datetime, at: Date.parse(datetime) || 0 });
  }
  return entries.sort((a, b) => b.at - a.at);
}

async function timeMap(url, { signal, timeoutMs }) {
  return cached(`archive:timemap:${url}`, 30 * 60 * 1000, async () => {
    for (const mirror of MIRRORS) {
      try {
        const { text } = await safeFetch(`https://${mirror}/timemap/${url}`, {
          signal,
          timeoutMs,
          browserIdentity: true,
          accept: 'application/link-format,text/plain,*/*;q=0.8',
          maxBytes: 512 * 1024
        });
        const entries = parseTimeMap(text);
        if (entries.length) return entries.slice(0, 3);
      } catch {
        continue;
      }
    }
    return [];
  });
}

export const archiveResolver = {
  name: 'archive',
  tier: 3,
  appliesTo: (url) => /^https?:/i.test(url),

  async run({ url, signal, timeoutMs }) {
    const budget = Math.min(timeoutMs, 3000);
    const entries = await timeMap(url, { signal, timeoutMs: budget });
    if (!entries.length) return null;

    for (const entry of entries.slice(0, 2)) {
      let html;
      try {
        ({ text: html } = await safeFetch(entry.href, {
          signal,
          timeoutMs: budget,
          browserIdentity: true,
          maxBytes: 3 * 1024 * 1024
        }));
      } catch {
        continue;
      }

      const extracted = extractFromHtml(html, url);
      if (extracted.chars < 800) continue;

      const access = classifyAccess({ extracted, html, url });

      return {
        lane: 'archive',
        kind: 'article',
        confidence: 0.76,
        title: extracted.title,
        text: extracted.text,
        paragraphs: extracted.paragraphs,
        url,
        outlet: extracted.siteName || access.outlet.name || access.outlet.host,
        author: extracted.author,
        published: extracted.published,
        access,
        meta: {
          snapshot: entry.datetime,
          snapshotUrl: entry.href,
          chars: extracted.chars
        }
      };
    }
    return null;
  }
};

export default archiveResolver;
