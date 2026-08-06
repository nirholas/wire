import { safeFetch, fetchJson } from '../fetch.js';
import { extractFromHtml } from '../extract.js';
import { classifyAccess } from '../paywall.js';
import { cached } from '../cache.js';

/**
 * The Internet Archive's public index. Free, keyless, no rate limit worth
 * worrying about at our volume.
 *
 * Read-only by design: we look up snapshots that already exist and never
 * submit a URL for capture. Submission would blow the latency budget several
 * times over anyway (it takes tens of seconds), so the honest choice and the
 * fast choice happen to agree.
 *
 * Realistic expectation: this lane misses on genuinely breaking news, because
 * nothing has crawled the URL yet. It is excellent on anything more than an
 * hour old, which covers the "what was that story everyone referenced" case.
 */

const CDX = 'https://web.archive.org/cdx/search/cdx';

/** Most recent successful captures, newest first. */
async function recentSnapshots(url, { signal, timeoutMs }) {
  return cached(`wayback:cdx:${url}`, 30 * 60 * 1000, async () => {
    const query =
      `${CDX}?url=${encodeURIComponent(url)}` +
      '&output=json&limit=-4&filter=statuscode:200&fl=timestamp,original,mimetype' +
      '&collapse=digest';
    const rows = await fetchJson(query, { signal, timeoutMs });
    if (!Array.isArray(rows) || rows.length < 2) return [];
    // First row is the column header.
    return rows
      .slice(1)
      .filter((row) => !row[2] || row[2].includes('html'))
      .map((row) => ({ timestamp: row[0], original: row[1] }))
      .reverse();
  });
}

export const waybackResolver = {
  name: 'wayback',
  tier: 2,
  appliesTo: (url) => /^https?:/i.test(url),

  async run({ url, signal, timeoutMs }) {
    const snapshots = await recentSnapshots(url, { signal, timeoutMs: Math.min(timeoutMs, 2500) });
    if (!snapshots.length) return null;

    for (const snapshot of snapshots.slice(0, 2)) {
      // The `id_` suffix asks for the original bytes without the archive's
      // navigation chrome injected into the page.
      const target = `https://web.archive.org/web/${snapshot.timestamp}id_/${snapshot.original}`;
      let html;
      try {
        ({ text: html } = await safeFetch(target, { signal, timeoutMs, maxBytes: 3 * 1024 * 1024 }));
      } catch {
        continue;
      }

      const extracted = extractFromHtml(html, url);
      if (!extracted.paragraphs.length) continue;

      const access = classifyAccess({ extracted, html, url });
      if (!access.usable) continue;

      const captured = snapshot.timestamp.replace(
        /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
        '$1-$2-$3T$4:$5:$6Z'
      );

      return {
        lane: 'wayback',
        kind: 'article',
        // Slightly below a live read: an archived copy can be an earlier
        // revision of a story that has since been updated.
        confidence: 0.8,
        title: extracted.title,
        text: extracted.text,
        paragraphs: extracted.paragraphs,
        url,
        outlet: extracted.siteName || access.outlet.name || access.outlet.host,
        author: extracted.author,
        published: extracted.published,
        access,
        meta: {
          snapshot: captured,
          snapshotUrl: `https://web.archive.org/web/${snapshot.timestamp}/${snapshot.original}`,
          chars: extracted.chars,
          staleness: captured
        }
      };
    }
    return null;
  }
};

export default waybackResolver;
