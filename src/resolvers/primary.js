import { safeFetch, fetchJson } from '../fetch.js';
import { parseFeed } from '../rss.js';
import { extractFromHtml } from '../extract.js';
import { PRIMARY_SOURCES } from '../feeds.js';
import { cached } from '../cache.js';
import { searchQuery, storyMatchScore, normalizeTitle, titleFromUrl, salientTerms } from '../text.js';
import config from '../config.js';

/**
 * Resolve the story to the document it is about.
 *
 * Financial news is usually reporting on a public artifact: an 8-K, an
 * enforcement action, an exchange listing notice, a central bank statement, a
 * protocol release. The article is downstream of that artifact, and the artifact
 * is free, authoritative, and frequently published before the coverage.
 *
 * When this lane hits, it is the best possible answer: not somebody's account of
 * what happened but the thing that happened.
 */

const EDGAR_FTS = 'https://efts.sec.gov/LATEST/search-index';

/**
 * SEC full-text search. EDGAR requires a User-Agent that identifies the caller
 * with a contact address and will block you outright without one.
 */
async function edgarSearch(query, { signal, timeoutMs }) {
  return cached(`edgar:${query}`, 10 * 60 * 1000, async () => {
    const url = `${EDGAR_FTS}?q=${encodeURIComponent(`"${query}"`)}&dateRange=custom&forms=8-K,6-K,10-Q,10-K,S-1,424B4`;
    try {
      const data = await fetchJson(url, {
        signal,
        timeoutMs: Math.min(timeoutMs, 2500),
        headers: { 'user-agent': config.userAgent }
      });
      return (data?.hits?.hits || []).slice(0, 5).map((hit) => {
        const [accession, file] = String(hit._id || '').split(':');
        const cik = (hit._source?.ciks || [])[0] || '';
        const bare = accession?.replace(/-/g, '') || '';
        return {
          title: hit._source?.display_names?.[0] || 'SEC filing',
          form: hit._source?.file_type || hit._source?.root_form || '',
          filedAt: hit._source?.file_date || '',
          link:
            cik && bare && file
              ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${file}`
              : '',
          score: hit._score || 0
        };
      });
    } catch {
      return [];
    }
  });
}

async function announcementFeed(source, { signal, timeoutMs }) {
  return cached(`primary:${source.key}`, 3 * 60 * 1000, async () => {
    try {
      if (source.kind === 'json') {
        const data = await fetchJson(source.url, {
          signal,
          timeoutMs: Math.min(timeoutMs, 2500),
          browserIdentity: true
        });
        return (source.pick(data) || []).slice(0, 30);
      }
      const { text } = await safeFetch(source.url, {
        signal,
        timeoutMs: Math.min(timeoutMs, 2500),
        headers: { 'user-agent': config.userAgent },
        maxBytes: 2 * 1024 * 1024
      });
      return parseFeed(text).slice(0, 30);
    } catch {
      return [];
    }
  });
}

/** GitHub releases, for protocol and client news. */
async function githubRelease(terms, { signal, timeoutMs }) {
  const repo = terms.find((term) => /^[\w.-]+\/[\w.-]+$/.test(term));
  if (!repo) return null;
  try {
    const data = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal,
      timeoutMs: Math.min(timeoutMs, 2000),
      headers: { accept: 'application/vnd.github+json' }
    });
    if (!data?.html_url) return null;
    return {
      title: `${repo} ${data.tag_name || ''}`.trim(),
      link: data.html_url,
      published: Date.parse(data.published_at || '') || 0,
      body: (data.body || '').slice(0, 4000),
      kindLabel: 'GitHub release'
    };
  } catch {
    return null;
  }
}

export const primaryResolver = {
  name: 'primary',
  tier: 2,
  appliesTo: (url) => /^https?:/i.test(url),

  async run({ url, signal, timeoutMs, hints, waitForHint }) {
    const hinted = await waitForHint('title', 700).catch(() => '');
    const title = normalizeTitle(hinted || hints.title || titleFromUrl(url) || '');
    if (!title || title.split(/\s+/).length < 3) return null;

    const terms = salientTerms(title, 6);
    const query = searchQuery(title);

    const [announcements, filings, release] = await Promise.all([
      Promise.allSettled(
        PRIMARY_SOURCES.map(async (source) => {
          const items = await announcementFeed(source, { signal, timeoutMs });
          return items.map((item) => ({ ...item, sourceName: source.name, sourceKey: source.key }));
        })
      ).then((results) => results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))),
      edgarSearch(terms.slice(0, 3).join(' '), { signal, timeoutMs }),
      githubRelease(terms, { signal, timeoutMs })
    ]);

    // Announcement feeds: match on headline, require a strong overlap because a
    // wrong primary source is worse than none.
    const matched = announcements
      .map((item) => ({ item, score: storyMatchScore(title, item.title) }))
      .filter((entry) => entry.score >= 0.42)
      .sort((a, b) => b.score - a.score);

    const best = matched[0];
    if (best?.item?.link) {
      let body = best.item.summary || '';
      try {
        const { text: html } = await safeFetch(best.item.link, {
          signal,
          timeoutMs: Math.min(timeoutMs, 2500),
          browserIdentity: true,
          maxBytes: 2 * 1024 * 1024
        });
        const extracted = extractFromHtml(html, best.item.link);
        if (extracted.chars > body.length) body = extracted.text;
      } catch {
        /* the feed summary is still a real primary-source excerpt */
      }

      if (body.length > 120) {
        return {
          lane: 'primary',
          kind: 'primary',
          // The authoritative document beats any account of it.
          confidence: Math.min(0.94, 0.72 + best.score * 0.25),
          title: best.item.title,
          text: body,
          paragraphs: body.split('\n\n').filter(Boolean),
          url: best.item.link,
          outlet: best.item.sourceName,
          published: best.item.published
            ? new Date(best.item.published).toISOString()
            : '',
          access: null,
          meta: {
            primaryKind: 'announcement',
            source: best.item.sourceName,
            match: Number(best.score.toFixed(2)),
            originalUrl: url,
            filings: filings.filter((f) => f.link).slice(0, 3)
          }
        };
      }
    }

    if (release) {
      return {
        lane: 'primary',
        kind: 'primary',
        confidence: 0.8,
        title: release.title,
        text: release.body,
        paragraphs: release.body.split('\n\n').filter(Boolean),
        url: release.link,
        outlet: 'GitHub',
        published: release.published ? new Date(release.published).toISOString() : '',
        access: null,
        meta: { primaryKind: 'github-release', originalUrl: url }
      };
    }

    // No full document, but pointing at the relevant filings is still useful
    // context the summary can hang off.
    const usableFilings = filings.filter((filing) => filing.link).slice(0, 3);
    if (usableFilings.length) {
      const text = usableFilings
        .map((filing) => `${filing.form || 'Filing'} - ${filing.title} (filed ${filing.filedAt})`)
        .join('\n');
      return {
        lane: 'primary',
        kind: 'pointer',
        confidence: 0.35,
        title: `SEC filings matching "${query}"`,
        text,
        paragraphs: [text],
        url: usableFilings[0].link,
        outlet: 'SEC EDGAR',
        access: null,
        meta: { primaryKind: 'edgar-pointer', filings: usableFilings, originalUrl: url }
      };
    }

    return null;
  }
};

export default primaryResolver;
