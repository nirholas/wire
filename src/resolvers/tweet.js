import { fetchJson } from '../fetch.js';
import { cached } from '../cache.js';

/**
 * The zero-latency lane.
 *
 * When something breaks on an X tracker the tweet itself already contains the
 * trade most of the time, and it is available in about 250ms with no key. This
 * uses the same public syndication endpoint that powers embedded tweets, so it
 * is the documented path for reading a public tweet, not scraping.
 *
 * It also does the job of finding the outbound article link, which is what the
 * rest of the pipeline then resolves.
 */

const TWEET_URL =
  /^https?:\/\/(?:www\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/(?:[^/]+)\/status(?:es)?\/(\d+)/i;

export function tweetIdFrom(url) {
  return url.match(TWEET_URL)?.[1] || null;
}

export function isTweetUrl(url) {
  return Boolean(tweetIdFrom(url));
}

/**
 * The syndication endpoint wants a token derived from the tweet id. This is the
 * same derivation the official embed client uses.
 */
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** Rewrites t.co shortlinks back to their real destinations. */
function expandLinks(text, entities) {
  let out = text || '';
  for (const entity of entities?.urls || []) {
    if (entity.url && entity.expanded_url) {
      out = out.split(entity.url).join(entity.expanded_url);
    }
  }
  return out.trim();
}

/** The outbound links a tweet points at, minus X's own media shortlinks. */
export function outboundLinks(tweet) {
  const urls = [];
  const collect = (node) => {
    for (const entity of node?.entities?.urls || []) {
      const target = entity.expanded_url || entity.url;
      if (!target) continue;
      if (/^https?:\/\/(?:www\.)?(twitter|x)\.com\//i.test(target)) continue;
      if (/\/\/t\.co\//.test(target)) continue;
      urls.push(target);
    }
    const cardUrl = node?.card?.binding_values?.card_url?.string_value;
    if (cardUrl) urls.push(cardUrl);
  };
  collect(tweet);
  collect(tweet?.quoted_tweet);
  return [...new Set(urls)];
}

export async function fetchTweet(id, { signal } = {}) {
  return cached(`tweet:${id}`, 6 * 60 * 60 * 1000, async () => {
    const url =
      `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}` +
      `&lang=en&token=${syndicationToken(id)}`;
    return fetchJson(url, { browserIdentity: true, timeoutMs: 3000, signal });
  });
}

function renderTweet(tweet) {
  const body = expandLinks(tweet.text, tweet.entities);
  const quoted = tweet.quoted_tweet
    ? `\n\nQuoting @${tweet.quoted_tweet.user?.screen_name}: ${expandLinks(
        tweet.quoted_tweet.text,
        tweet.quoted_tweet.entities
      )}`
    : '';
  return `${body}${quoted}`.trim();
}

export const tweetResolver = {
  name: 'tweet',
  /** Instant lane: it should never be excluded by a budget. */
  tier: 0,
  appliesTo: (url) => isTweetUrl(url),

  async run({ url, signal }) {
    const id = tweetIdFrom(url);
    if (!id) return null;

    const tweet = await fetchTweet(id, { signal });
    if (!tweet || (!tweet.text && !tweet.__typename)) return null;

    const text = renderTweet(tweet);
    const handle = tweet.user?.screen_name || '';
    const links = outboundLinks(tweet);

    return {
      lane: 'tweet',
      kind: 'tweet',
      confidence: 0.95,
      title: `@${handle}${tweet.user?.name ? ` (${tweet.user.name})` : ''}`,
      text,
      paragraphs: text.split('\n\n').filter(Boolean),
      url,
      outlet: 'X',
      author: handle ? `@${handle}` : '',
      published: tweet.created_at || '',
      meta: {
        tweetId: id,
        verified: Boolean(tweet.user?.is_blue_verified || tweet.user?.verified),
        followers: tweet.user?.followers_count ?? null,
        favorites: tweet.favorite_count ?? null,
        replies: tweet.conversation_count ?? null,
        photos: (tweet.photos || []).map((photo) => photo.url).filter(Boolean),
        /** The links the rest of the pipeline should chase. */
        outboundLinks: links,
        quoted: Boolean(tweet.quoted_tweet)
      }
    };
  }
};

export default tweetResolver;
