import { safeFetch, fetchJson } from '../fetch.js';
import { parseFeed } from '../rss.js';
import { extractFromHtml } from '../extract.js';
import { classifyAccess, outletFor } from '../paywall.js';
import { feedsFor } from '../feeds.js';
import { cached } from '../cache.js';
import { searchQuery, storyMatchScore, normalizeTitle, titleFromUrl, salientTerms } from '../text.js';

/**
 * The lane that makes the rest of the design work.
 *
 * A gated outlet breaking a story is almost never the only account of it. Free
 * outlets publish their own writeups within minutes, and unlike the original we
 * can read all of it. This lane finds those writeups, proves they are the same
 * story rather than a lookalike, and returns the best one in full.
 *
 * Discovery runs against three sources at once:
 *   - Google News search, which is the fastest broad index but hands back
 *     redirector links rather than article URLs, so it is used to learn WHO
 *     covered the story and WHEN.
 *   - Open outlet feeds, which give real URLs we can read end to end.
 *   - GDELT, which gives real URLs across a much wider index but rate limits
 *     anonymous callers hard, so it is opportunistic and never blocking.
 */

const GOOGLE_NEWS = 'https://news.google.com/rss/search';
const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';

/**
 * Outlets and URL paths that tell us which world a headline lives in. Used to
 * add one disambiguating term to the search query, never to filter results.
 */
const CRYPTO_HOSTS =
  /(coindesk|cointelegraph|theblock|blockworks|decrypt|dlnews|protos|cryptoslate|thedefiant|bitcoinmagazine)\./i;
const CRYPTO_PATH = /\/(crypto|bitcoin|ethereum|defi|web3|blockchain|token|nft|policy\/20)/i;
const MARKETS_PATH = /\/(markets?|finance|economy|business|investing)\b/i;

export function topicContext(url, outletName = '') {
  const haystack = `${url} ${outletName}`;
  if (CRYPTO_HOSTS.test(haystack) || CRYPTO_PATH.test(url)) return 'crypto';
  if (MARKETS_PATH.test(url)) return 'markets';
  return '';
}

/** GDELT asks for one request every five seconds per caller. Honor it. */
const GDELT_MIN_INTERVAL_MS = 5200;
let gdeltNextAllowedAt = 0;

async function googleNews(query, { signal, timeoutMs }) {
  return cached(`gnews:${query}`, 5 * 60 * 1000, async () => {
    const url =
      `${GOOGLE_NEWS}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const { text } = await safeFetch(url, { signal, timeoutMs, maxBytes: 1024 * 1024 });
      return parseFeed(text).map((item) => ({
        title: item.title,
        // Google's link is a redirector we cannot cheaply unwrap, so the item is
        // treated as evidence of coverage rather than as a fetchable article.
        link: '',
        redirector: item.link,
        published: item.published,
        outlet: item.sourceName || '',
        outletUrl: item.sourceUrl || '',
        via: 'google-news'
      }));
    } catch {
      return [];
    }
  });
}

async function gdelt(query, { signal, timeoutMs }) {
  const now = Date.now();
  if (now < gdeltNextAllowedAt) return [];
  gdeltNextAllowedAt = now + GDELT_MIN_INTERVAL_MS;

  return cached(`gdelt:${query}`, 5 * 60 * 1000, async () => {
    const url =
      `${GDELT}?query=${encodeURIComponent(query)}` +
      '&mode=artlist&format=json&maxrecords=20&sort=datedesc&timespan=3d';
    try {
      const data = await fetchJson(url, { signal, timeoutMs: Math.min(timeoutMs, 3000) });
      return (data?.articles || []).map((article) => ({
        title: article.title || '',
        link: article.url || '',
        published: Date.parse(article.seendate?.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          '$1-$2-$3T$4:$5:$6Z'
        ) || '') || 0,
        outlet: article.domain || '',
        via: 'gdelt'
      }));
    } catch {
      return [];
    }
  });
}

async function openFeeds({ signal, timeoutMs }) {
  const feeds = feedsFor({ limit: 12 });
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const items = await cached(`feed:${feed.key}`, 3 * 60 * 1000, async () => {
        const { text } = await safeFetch(feed.url, {
          signal,
          timeoutMs: Math.min(timeoutMs, 2500),
          browserIdentity: true,
          maxBytes: 2 * 1024 * 1024
        });
        return parseFeed(text).slice(0, 40);
      });
      return items.map((item) => ({
        title: item.title,
        link: item.link,
        published: item.published,
        outlet: feed.name,
        weight: feed.weight,
        summary: item.summary,
        via: `feed:${feed.key}`
      }));
    })
  );

  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

/**
 * Roundups and digests mention the story without being about it. Their body is
 * ten unrelated items, so summarizing one attributes figures from a different
 * story to this one. They are the single worst thing the sibling lane can pick.
 */
const DIGEST_TITLE =
  /(what happened in crypto|crypto today|daily (roundup|digest|briefing|recap)|morning (briefing|brief)|week in review|weekly recap|top stories|news roundup|market wrap|\bliveblog\b|live updates|^\d+ things)/i;

export function isDigest(title) {
  return DIGEST_TITLE.test(String(title || ''));
}

/**
 * Does this body actually cover the story the headline describes?
 *
 * Checks that the headline's most distinctive terms (proper nouns, acronyms,
 * tickers, numbers) survive into the text. Requires most of them, not all: a
 * different outlet will phrase things differently, but it cannot write about
 * Wintermute registering with the SEC without naming Wintermute.
 */
export function coversStory(title, text) {
  const terms = salientTerms(title, 6).filter((term) => term.length > 3);
  if (terms.length < 2) return true; // too little to verify against; do not reject

  const haystack = String(text || '').toLowerCase();
  const present = terms.filter((term) => haystack.includes(term.toLowerCase().replace(/^\$/, '')));
  return present.length / terms.length >= 0.5;
}

function scoreCandidate(candidate, { title, sourceHost, publishedAt }) {
  const match = storyMatchScore(title, candidate.title);
  if (match < 0.28) return 0;
  if (isDigest(candidate.title)) return 0;

  // Never return the gated original as its own sibling.
  try {
    if (candidate.link && new URL(candidate.link).hostname.replace(/^www\./, '') === sourceHost) {
      return 0;
    }
  } catch {
    /* candidate has no usable link; still valid as coverage evidence */
  }

  let score = match;

  // Recency, measured against the source story when we know its time.
  const anchor = publishedAt || Date.now();
  const ageHours = candidate.published ? Math.abs(anchor - candidate.published) / 3_600_000 : 48;
  score *= ageHours <= 6 ? 1.25 : ageHours <= 24 ? 1.1 : ageHours <= 72 ? 0.9 : 0.55;

  // Prefer outlets we can actually read in full.
  const outlet = candidate.link ? outletFor(candidate.link) : { model: 'unknown' };
  if (outlet.model === 'open') score *= 1.2;
  else if (outlet.model === 'hard') score *= 0.35;
  else if (outlet.model === 'metered') score *= 0.8;

  if (candidate.weight) score *= 0.7 + candidate.weight * 0.3;
  if (!candidate.link) score *= 0.5; // evidence only, cannot be read

  return score;
}

export const siblingsResolver = {
  name: 'siblings',
  tier: 1,
  appliesTo: (url) => /^https?:/i.test(url),

  async run({ url, signal, timeoutMs, hints, waitForHint }) {
    // Start from the URL slug so this lane never waits to begin, then upgrade to
    // the real headline if another lane produces one in the next few hundred ms.
    const slugTitle = titleFromUrl(url);
    const hinted = await waitForHint('title', 700).catch(() => '');
    const title = normalizeTitle(hinted || hints.title || slugTitle || '');
    if (!title || title.split(/\s+/).length < 3) return null;

    const sourceHost = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const publishedAt = hints.publishedAt || 0;

    /**
     * Disambiguate the query with the story's domain.
     *
     * Headlines are written for readers who already know the section they are
     * in. "Power struggle erupts at Ondo" is a crypto story on a crypto site and
     * a state-politics story to a search engine, which will happily return
     * Nigerian election coverage. One context term collapses that ambiguity.
     */
    const query = searchQuery(title, topicContext(url, hints.outlet || ''));

    const [news, feedItems, gdeltItems] = await Promise.all([
      googleNews(query, { signal, timeoutMs }),
      openFeeds({ signal, timeoutMs }),
      gdelt(query, { signal, timeoutMs })
    ]);

    const all = [...feedItems, ...gdeltItems, ...news];
    const scored = all
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, { title, sourceHost, publishedAt }) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;

    /** Everyone who covered it, for the "also reported by" line. */
    const coverage = [];
    const seenOutlets = new Set();
    for (const { candidate, score } of scored.slice(0, 12)) {
      const key = (candidate.outlet || '').toLowerCase();
      if (!key || seenOutlets.has(key)) continue;
      seenOutlets.add(key);
      coverage.push({
        outlet: candidate.outlet,
        title: candidate.title,
        url: candidate.link || candidate.redirector || '',
        published: candidate.published || null,
        match: Number(score.toFixed(2))
      });
    }

    // Read the best candidate that has a real URL and is not itself gated.
    const readable = scored.filter(({ candidate }) => candidate.link).slice(0, 3);
    for (const { candidate, score } of readable) {
      let html;
      try {
        ({ text: html } = await safeFetch(candidate.link, {
          signal,
          timeoutMs: Math.min(timeoutMs, 3000),
          browserIdentity: true,
          maxBytes: 3 * 1024 * 1024
        }));
      } catch {
        continue;
      }

      const extracted = extractFromHtml(html, candidate.link);
      const access = classifyAccess({ extracted, html, url: candidate.link });
      if (!access.usable) continue;

      /**
       * Confirm the fetched page is actually about this story.
       *
       * A headline can match while the body is about something else: a digest,
       * a tag page, a story that got replaced at the same URL. Requiring the
       * distinctive terms from the original headline to appear in the body is
       * the cheap check that catches all three, and it is what stops a figure
       * from an unrelated item being attributed to this one.
       */
      if (!coversStory(title, extracted.text)) continue;

      return {
        lane: 'siblings',
        kind: 'sibling',
        // A good sibling is a complete, readable account of the same event. It
        // outranks a gated teaser by a mile and sits just under a direct read.
        confidence: Math.min(0.86, 0.6 + score * 0.25),
        title: extracted.title || candidate.title,
        text: extracted.text,
        paragraphs: extracted.paragraphs,
        url: candidate.link,
        outlet: extracted.siteName || candidate.outlet,
        author: extracted.author,
        published: extracted.published,
        access,
        meta: {
          originalUrl: url,
          matchedOn: title,
          query,
          match: Number(score.toFixed(2)),
          coverage,
          coverageCount: coverage.length,
          chars: extracted.chars
        }
      };
    }

    // Nothing fully readable, but knowing five outlets ran the story within the
    // hour is itself tradeable information. Return it as a low-confidence signal.
    if (coverage.length >= 2) {
      const text = coverage
        .slice(0, 6)
        .map((entry) => `${entry.outlet}: ${entry.title}`)
        .join('\n');
      return {
        lane: 'siblings',
        kind: 'coverage',
        confidence: 0.4,
        title,
        text,
        paragraphs: [text],
        url,
        outlet: 'multiple',
        access: null,
        meta: { query, coverage, coverageCount: coverage.length, readable: false }
      };
    }

    return null;
  }
};

export default siblingsResolver;
