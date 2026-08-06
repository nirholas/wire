/**
 * Paywall detection and routing.
 *
 * This module answers "is this gated, how, and where should I go instead" and
 * deliberately does not answer "how do I get through it". Knowing you have hit
 * a hard wall in 200ms and pivoting to free coverage of the same story is
 * faster than any circumvention attempt, and it keeps working when publishers
 * tighten their edge.
 *
 * The strongest signal is `isAccessibleForFree`, which is the schema.org field
 * Google requires publishers to declare on gated articles. They tell us.
 */

/** Phrases that appear in the interstitial rather than the article. */
const WALL_PHRASES = [
  'subscribe to continue',
  'subscribe to read',
  'already a subscriber',
  'to continue reading',
  'continue reading this article',
  'this article is for subscribers',
  'subscribers only',
  'for subscribers only',
  'become a member to',
  'sign in to read',
  'log in to continue',
  'create a free account to',
  'register to continue',
  'you have reached your',
  'free articles remaining',
  'articles left this month',
  'your free trial',
  'unlock this article',
  'premium content'
];

const REGISTER_PHRASES = [
  'create a free account',
  'register to continue',
  'sign up for free',
  'free account required'
];

/**
 * Outlets whose default access model we already know. This is routing metadata
 * so the race can skip a fetch that will not produce prose and spend the budget
 * on lanes that will. It records where to look instead, never how to get in.
 */
const OUTLET_MODELS = {
  'wsj.com': { model: 'hard', name: 'The Wall Street Journal' },
  'bloomberg.com': { model: 'hard', name: 'Bloomberg' },
  'ft.com': { model: 'hard', name: 'Financial Times' },
  'theinformation.com': { model: 'hard', name: 'The Information' },
  'barrons.com': { model: 'hard', name: "Barron's" },
  'economist.com': { model: 'hard', name: 'The Economist' },
  'nytimes.com': { model: 'metered', name: 'The New York Times' },
  'washingtonpost.com': { model: 'metered', name: 'The Washington Post' },
  'reuters.com': { model: 'metered', name: 'Reuters' },
  'businessinsider.com': { model: 'metered', name: 'Business Insider' },
  'forbes.com': { model: 'metered', name: 'Forbes' },
  'seekingalpha.com': { model: 'register', name: 'Seeking Alpha' },
  'blockworks.co': { model: 'open', name: 'Blockworks' },
  'theblock.co': { model: 'metered', name: 'The Block' },
  'coindesk.com': { model: 'open', name: 'CoinDesk' },
  'cointelegraph.com': { model: 'open', name: 'Cointelegraph' },
  'decrypt.co': { model: 'open', name: 'Decrypt' },
  'dlnews.com': { model: 'open', name: 'DL News' },
  'axios.com': { model: 'open', name: 'Axios' },
  'cnbc.com': { model: 'open', name: 'CNBC' },
  'apnews.com': { model: 'open', name: 'AP' },
  'prnewswire.com': { model: 'open', name: 'PR Newswire' },
  'businesswire.com': { model: 'open', name: 'Business Wire' },
  'globenewswire.com': { model: 'open', name: 'GlobeNewswire' },
  'sec.gov': { model: 'open', name: 'SEC' },
  'federalreserve.gov': { model: 'open', name: 'Federal Reserve' }
};

export function outletFor(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return { host: '', model: 'unknown', name: '' };
  }
  for (const [domain, meta] of Object.entries(OUTLET_MODELS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return { host, ...meta };
  }
  return { host, model: 'unknown', name: host };
}

/** True when the outlet reliably gates, so the direct lane is not worth waiting on. */
export function likelyGated(url) {
  const { model } = outletFor(url);
  return model === 'hard';
}

/**
 * Classifies an extraction result.
 *
 * @param {object} params
 * @param {object|null} params.extracted  result of extractFromHtml
 * @param {number|null} params.status     HTTP status, when the fetch got that far
 * @param {string} params.html            raw HTML, for interstitial phrase matching
 * @param {string} params.url
 */
export function classifyAccess({ extracted = null, status = null, html = '', url = '' }) {
  const signals = [];
  const outlet = outletFor(url);
  let kind = 'open';
  let confidence = 0.3;

  if (status === 402 || status === 451) {
    signals.push(`http_${status}`);
    kind = 'hard';
    confidence = 0.95;
  } else if (status === 403) {
    signals.push('http_403');
    kind = 'blocked';
    confidence = 0.7;
  }

  // The publisher's own declaration, and by far the most reliable signal.
  if (extracted?.jsonLdAccessibleForFree === false) {
    signals.push('schema_isAccessibleForFree_false');
    kind = kind === 'blocked' ? 'blocked' : 'hard';
    confidence = Math.max(confidence, 0.9);
  } else if (extracted?.jsonLdAccessibleForFree === true) {
    signals.push('schema_isAccessibleForFree_true');
    confidence = Math.max(confidence, 0.6);
  }

  const bodyText = (extracted?.text || '').toLowerCase();

  /**
   * Bot interstitials ("please enable JS", "checking your browser") are not
   * paywalls and must not be reported as article text. They are short, they
   * mention the client rather than the subject, and treating them as a teaser
   * would put a 40-character stub in front of the reader as if it were news.
   */
  const BOT_WALL =
    /(enable js|enable javascript|disable any ad ?blocker|checking your browser|verify you are (a )?human|access denied|are you a robot|cf-browser-verification)/;
  if (bodyText.length < 400 && BOT_WALL.test(bodyText)) {
    return {
      gated: true,
      kind: 'blocked',
      confidence: 0.9,
      signals: ['bot_interstitial'],
      outlet,
      bodyChars: extracted?.chars ?? 0,
      usable: false,
      /** Explicit: this candidate carries no content and must not be shown. */
      empty: true,
      recommendation: recommendFor('blocked', outlet)
    };
  }

  const haystack = (html || '').slice(0, 250_000).toLowerCase();
  const hits = WALL_PHRASES.filter((phrase) => haystack.includes(phrase));
  if (hits.length) {
    signals.push(`wall_copy:${hits[0].replace(/\s+/g, '_')}`);
    if (kind === 'open') kind = 'metered';
    confidence = Math.max(confidence, 0.55 + Math.min(hits.length, 3) * 0.1);
  }
  if (REGISTER_PHRASES.some((phrase) => haystack.includes(phrase))) {
    signals.push('register_wall_copy');
    if (kind === 'open' || kind === 'metered') kind = 'register';
  }

  // A gated page usually still ships the teaser: a long, complete description
  // paired with almost no body is the classic truncation shape.
  const bodyChars = extracted?.chars ?? 0;
  const descChars = (extracted?.description || '').length;
  if (bodyChars > 0 && bodyChars < 900 && descChars > 100) {
    signals.push(`truncated_body:${bodyChars}`);
    if (kind === 'open') kind = 'metered';
    confidence = Math.max(confidence, 0.65);
  }
  if (bodyChars === 0 && (extracted?.title || descChars)) {
    signals.push('no_body_extracted');
    if (kind === 'open') kind = 'unknown';
    confidence = Math.max(confidence, 0.5);
  }

  // Body that stops mid-sentence is a hard truncation, not an author's choice.
  const tail = (extracted?.paragraphs?.at(-1) || '').trim();
  if (tail && bodyChars < 2500 && !/[.!?"”'’)]$/.test(tail)) {
    signals.push('body_ends_mid_sentence');
    if (kind === 'open') kind = 'metered';
    confidence = Math.max(confidence, 0.6);
  }

  // Outlet prior, applied last and only as a tiebreak.
  if (kind === 'open' && outlet.model === 'hard' && bodyChars < 4000) {
    signals.push('outlet_prior_hard');
    kind = 'hard';
    confidence = Math.max(confidence, 0.75);
  }

  const gated = kind !== 'open';
  const usable = bodyChars >= 1200 && !(gated && bodyChars < 1200);

  return {
    gated,
    kind,
    confidence: Number(Math.min(confidence, 0.99).toFixed(2)),
    signals,
    outlet,
    bodyChars,
    usable,
    /** What the race should do about it. Consumed by the planner. */
    recommendation: recommendFor(kind, outlet)
  };
}

function recommendFor(kind, outlet) {
  switch (kind) {
    case 'hard':
      return {
        action: 'pivot',
        lanes: ['subscription', 'siblings', 'primary', 'archive', 'wayback'],
        why: `${outlet.name || outlet.host} gates this article. Free coverage of the same story is usually faster than any other route.`
      };
    case 'metered':
      return {
        action: 'pivot',
        lanes: ['reader', 'siblings', 'wayback', 'archive', 'primary'],
        why: 'Metered wall. A reader view or an existing archive snapshot often holds the full text already.'
      };
    case 'register':
      return {
        action: 'pivot',
        lanes: ['subscription', 'reader', 'siblings', 'wayback'],
        why: 'Registration wall. Your own logged-in session reads this directly.'
      };
    case 'blocked':
      return {
        action: 'pivot',
        lanes: ['reader', 'wayback', 'archive', 'siblings', 'primary'],
        why: 'The origin refused us. Nothing to do with the paywall; route around the block.'
      };
    default:
      return { action: 'proceed', lanes: [], why: 'Article is readable as served.' };
  }
}

export { OUTLET_MODELS, WALL_PHRASES };
