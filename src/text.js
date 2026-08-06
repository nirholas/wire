/**
 * Query building, headline matching, and entity extraction.
 *
 * The sibling lane lives or dies on these functions. Turning "Fed Signals Rate
 * Cut as Crypto Rallies - WSJ" into a query that finds the same story on three
 * free outlets, and then proving the match is the same story rather than a
 * lookalike, is the whole trick.
 */

const STOPWORDS = new Set(
  `a an the and or but of for to in on at by with from as is are was were be been being
   it its this that these those he she they them his her their we our you your i me my
   how why what when where who which will would could should can may might must have has
   had do does did not no nor so than then there here about into over under after before
   says say said report reports reported new news latest update updates exclusive opinion
   analysis via amid amid ahead more most first`
    .split(/\s+/)
    .filter(Boolean)
);

/** Outlet suffixes that RSS titles append and that poison a search query. */
const TITLE_SUFFIX = /\s+[-|–—]\s+[A-Z][A-Za-z0-9.'& ]{1,28}$/;

export function normalizeTitle(title) {
  // Section prefixes come off first. Otherwise "Opinion | Coinbase Sues the SEC"
  // looks like a headline with an outlet suffix and the stripper eats the
  // headline, leaving the word "Opinion" as the search query.
  const withoutPrefix = String(title || '')
    .replace(/^(opinion|analysis|exclusive|breaking|live|watch|update)\s*[:|]\s*/i, '')
    .trim();

  const suffix = withoutPrefix.match(TITLE_SUFFIX);
  if (!suffix) return withoutPrefix;

  const remainder = withoutPrefix.slice(0, suffix.index).trim();
  const strippedWords = suffix[0].replace(/^\s*[-|–—]\s*/, '').split(/\s+/).length;

  // An outlet name is short, and what is left has to still be a headline.
  if (remainder.split(/\s+/).length < 2 || strippedWords > 4) return withoutPrefix;
  return remainder;
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[''’]s\b/g, '')
    .replace(/[^a-z0-9$#.\- ]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Words that carry identity: proper nouns, tickers, numbers, acronyms. */
export function salientTerms(title, limit = 8) {
  const cleaned = normalizeTitle(title);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const word of words) {
    const bare = word.replace(/[^A-Za-z0-9$#.\-]/g, '');
    if (!bare) continue;
    const lower = bare.toLowerCase();
    if (STOPWORDS.has(lower) || lower.length < 2) continue;

    let score = 1;
    if (/^[A-Z]{2,6}$/.test(bare)) score += 3; // acronym or ticker: SEC, ETF, BTC
    else if (/^\$[A-Za-z]{2,6}$/.test(bare)) score += 4; // cashtag
    else if (/^[A-Z][a-z]/.test(bare)) score += 2; // proper noun
    if (/\d/.test(bare)) score += 2; // numbers are highly distinctive
    if (bare.length > 7) score += 1;

    scored.push({ word: bare, score });
  }

  const seen = new Set();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ word }) => {
      const key = word.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ word }) => word);
}

/**
 * Builds a news-search query. Keeps the most distinctive terms and preserves
 * their original order so the phrase still reads like the headline.
 */
export function searchQuery(title, extra = '') {
  const terms = salientTerms(title, 7);
  const ordered = normalizeTitle(title)
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9$#.\-]/g, ''))
    .filter((word) => terms.some((term) => term.toLowerCase() === word.toLowerCase()));
  const query = (ordered.length >= 3 ? ordered : terms).join(' ');
  return `${query} ${extra}`.trim().slice(0, 220);
}

/**
 * Recovers a provisional headline from the URL slug.
 *
 * News URLs almost always carry the headline: /2026/08/06/fed-signals-rate-cut/.
 * This costs nothing and no network round trip, which lets the sibling search
 * start at t=0 instead of waiting for a page fetch to produce a real title.
 */
export function titleFromUrl(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return '';
  }

  const segments = pathname.split('/').filter(Boolean);
  // The headline slug is the longest hyphenated segment, ignoring date and id parts.
  const candidates = segments
    .filter((segment) => !/^\d+$/.test(segment) && !/^(20\d{2}|\d{1,2})$/.test(segment))
    .map((segment) => segment.replace(/\.(html?|php|amp)$/i, ''))
    .filter((segment) => segment.includes('-') && segment.length > 12);

  if (!candidates.length) return '';

  const slug = candidates.sort((a, b) => b.length - a.length)[0];
  return slug
    .split('-')
    // Trailing hashes and ids are common: strip anything that is not a word.
    .filter((part) => /^[a-z0-9$]+$/i.test(part) && !/^[0-9a-f]{8,}$/i.test(part))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaccard overlap on salient tokens. Cheap, and good enough to reject lookalikes. */
export function titleSimilarity(a, b) {
  const left = new Set(tokenize(normalizeTitle(a)));
  const right = new Set(tokenize(normalizeTitle(b)));
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

/**
 * Containment: how much of the shorter headline appears in the longer one.
 * Catches "Fed cuts rates" vs "Federal Reserve cuts rates as markets rally",
 * which Jaccard punishes for length difference alone.
 */
export function titleContainment(a, b) {
  const left = new Set(tokenize(normalizeTitle(a)));
  const right = new Set(tokenize(normalizeTitle(b)));
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

export function storyMatchScore(sourceTitle, candidateTitle) {
  return Math.max(titleSimilarity(sourceTitle, candidateTitle), titleContainment(sourceTitle, candidateTitle) * 0.9);
}

const TICKER_MAP = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  ripple: 'XRP',
  dogecoin: 'DOGE',
  cardano: 'ADA',
  avalanche: 'AVAX',
  chainlink: 'LINK',
  polygon: 'MATIC',
  litecoin: 'LTC',
  polkadot: 'DOT',
  uniswap: 'UNI',
  aave: 'AAVE',
  sui: 'SUI',
  aptos: 'APT',
  arbitrum: 'ARB',
  optimism: 'OP',
  tron: 'TRX',
  monero: 'XMR',
  stellar: 'XLM'
};

const KNOWN_TICKERS = new Set([
  ...Object.values(TICKER_MAP),
  'USDT', 'USDC', 'DAI', 'BNB', 'TON', 'NEAR', 'ATOM', 'FIL', 'ICP', 'HBAR',
  'ETF', 'SPX', 'NDX', 'DXY', 'VIX'
]);

const EQUITY_TICKERS = new Set([
  'COIN', 'MSTR', 'HOOD', 'NVDA', 'TSLA', 'MARA', 'RIOT', 'CLSK', 'GBTC', 'IBIT', 'BLK', 'SQ', 'PYPL'
]);

/** Pulls asset symbols out of prose. Cashtags win, then known names, then bare symbols. */
export function extractTickers(text, limit = 8) {
  const found = new Map();
  const add = (symbol, weight) => {
    const key = symbol.toUpperCase();
    found.set(key, Math.max(found.get(key) || 0, weight));
  };

  const body = String(text || '');

  for (const match of body.matchAll(/\$([A-Za-z]{2,6})\b/g)) add(match[1], 3);

  const lower = body.toLowerCase();
  for (const [name, symbol] of Object.entries(TICKER_MAP)) {
    if (lower.includes(name)) add(symbol, 2);
  }

  for (const match of body.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const symbol = match[1];
    if (KNOWN_TICKERS.has(symbol) || EQUITY_TICKERS.has(symbol)) add(symbol, 1);
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([symbol]) => symbol);
}

/** Trims prose to a token budget without cutting mid-sentence when avoidable. */
export function clampText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (boundary > maxChars * 0.6 ? cut.slice(0, boundary + 1) : cut).trim();
}

export { STOPWORDS };
