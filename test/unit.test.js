import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateAddress, assertPublicUrl, BlockedAddressError } from '../src/ssrf.js';
import { parseFeed, stripHtml } from '../src/rss.js';
import {
  titleFromUrl,
  salientTerms,
  searchQuery,
  storyMatchScore,
  titleContainment,
  extractTickers,
  clampText,
  normalizeTitle
} from '../src/text.js';
import { extractFromHtml, extractFromMarkdown, isChromeLine, proseRatio } from '../src/extract.js';
import { classifyAccess, outletFor, likelyGated } from '../src/paywall.js';
import { scoreCandidate, EARLY_EXIT_SCORE } from '../src/race.js';
import { parseJsonLoose, stripJsonFence } from '../src/llm.js';
import { normalize as normalizeSummary } from '../src/summarize.js';
import { parseJar } from '../src/cookies.js';
import { urlFrom, resolutionId } from '../src/index.js';
import { tweetIdFrom, isTweetUrl, outboundLinks } from '../src/resolvers/tweet.js';
import { topicContext, isDigest, coversStory } from '../src/resolvers/siblings.js';

describe('ssrf guard', () => {
  test('blocks the address ranges that make a fetcher an open proxy', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:10.0.0.1' // v4-mapped private smuggled through v6
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be blocked`);
    }
  });

  test('allows real public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} must be allowed`);
    }
  });

  test('rejects non-http protocols and localhost by name', async () => {
    await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl('gopher://example.com'), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl('http://localhost:8080/admin'), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl('not a url'), BlockedAddressError);
  });
});

describe('feed parsing', () => {
  // Regression: <link> is a VOID element in HTML. Parsing feeds with an HTML
  // parser silently returned empty links for every RSS item in the registry.
  test('reads RSS 2.0 links from the link element, not the guid fallback', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Feed</title>
        <item>
          <title>Fed cuts rates by 50bps</title>
          <link>https://example.com/articles/fed-cuts-rates</link>
          <guid isPermaLink="false">urn:uuid:1234</guid>
          <pubDate>Wed, 06 Aug 2026 12:00:00 GMT</pubDate>
          <description>The Federal Reserve lowered its benchmark rate.</description>
        </item>
      </channel></rss>`;
    const [item] = parseFeed(xml);
    assert.equal(item.link, 'https://example.com/articles/fed-cuts-rates');
    assert.equal(item.title, 'Fed cuts rates by 50bps');
    assert.ok(item.published > 0);
    assert.match(item.summary, /Federal Reserve/);
  });

  test('reads Atom entries where the link is an attribute', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>SEC approves listing</title>
          <link rel="alternate" href="https://example.com/sec-approves"/>
          <published>2026-08-06T12:00:00Z</published>
          <summary>Approval granted.</summary>
        </entry>
      </feed>`;
    const [item] = parseFeed(xml);
    assert.equal(item.link, 'https://example.com/sec-approves');
    assert.equal(item.title, 'SEC approves listing');
  });

  test('unwraps CDATA titles and keeps the source element', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel><item>
        <title><![CDATA[Bitcoin & Ether rally]]></title>
        <link>https://example.com/a</link>
        <source url="https://www.coindesk.com">CoinDesk</source>
      </item></channel></rss>`;
    const [item] = parseFeed(xml);
    assert.equal(item.title, 'Bitcoin & Ether rally');
    assert.equal(item.sourceName, 'CoinDesk');
    assert.equal(item.sourceUrl, 'https://www.coindesk.com');
  });

  test('skips items with no usable link and survives malformed xml', () => {
    assert.deepEqual(parseFeed('<rss><channel><item><title>No link</title></item></channel></rss>'), []);
    assert.deepEqual(parseFeed('not xml at all <<<'), []);
    assert.deepEqual(parseFeed(''), []);
  });

  test('strips markup from feed text', () => {
    assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
    assert.equal(stripHtml('A &amp; B'), 'A & B');
  });
});

describe('query building and story matching', () => {
  test('recovers a headline from a URL slug', () => {
    assert.equal(
      titleFromUrl('https://www.wsj.com/articles/nikkei-may-rise-as-weak-yen-raises-hopes-776a8056'),
      'nikkei may rise as weak yen raises hopes'
    );
    assert.equal(
      titleFromUrl('https://www.coindesk.com/policy/2026/08/06/power-struggle-erupts-at-ondo'),
      'power struggle erupts at ondo'
    );
    // Nothing headline-shaped to recover.
    assert.equal(titleFromUrl('https://example.com/'), '');
    assert.equal(titleFromUrl('https://decrypt.co/?p=375078'), '');
    assert.equal(titleFromUrl('not a url'), '');
  });

  test('drops the outlet suffix that would poison a search query', () => {
    assert.equal(normalizeTitle('Fed Signals Rate Cut - WSJ'), 'Fed Signals Rate Cut');
    assert.equal(normalizeTitle('Bitcoin Rallies | Bloomberg'), 'Bitcoin Rallies');
    assert.equal(
      normalizeTitle('Ondo Finance hit by control fight - CoinDesk'),
      'Ondo Finance hit by control fight'
    );
  });

  // Regression: the suffix stripper matched " | Coinbase Sues the SEC" and left
  // the single word "Opinion" as the entire search query.
  test('strips a section prefix without eating the headline behind it', () => {
    assert.equal(normalizeTitle('Opinion | Coinbase Sues the SEC'), 'Coinbase Sues the SEC');
    assert.equal(normalizeTitle('Breaking: Fed cuts rates'), 'Fed cuts rates');
    // Nothing left to be a headline means the suffix was not an outlet name.
    assert.equal(normalizeTitle('Markets - Some Very Long Trailing Clause Here'), 'Markets - Some Very Long Trailing Clause Here');
  });

  test('ranks acronyms, cashtags and numbers as the distinctive terms', () => {
    const terms = salientTerms('SEC approves $BTC ETF options with 25000 contract limit');
    assert.ok(terms.includes('SEC'), 'acronym should rank');
    assert.ok(terms.includes('$BTC'), 'cashtag should rank');
    assert.ok(terms.includes('25000'), 'number should rank');
    assert.ok(!terms.includes('with'), 'stopword should be dropped');
  });

  test('appends topic context to disambiguate an ambiguous headline', () => {
    const query = searchQuery('power struggle erupts at ondo', 'crypto');
    assert.match(query, /crypto$/);
  });

  test('scores the same story high and an unrelated story low', () => {
    const source = 'Ondo Finance hit by corporate control fight as founder mother seizes board';
    const sibling = 'Ondo Finance Control Fight Escalates as Founder Mother Sues';
    const unrelated = 'Inside Ondo APC power struggle ahead of 2027 polls';

    assert.ok(storyMatchScore(source, sibling) > 0.45, 'same story must clear the bar');
    assert.ok(
      storyMatchScore(source, sibling) > storyMatchScore(source, unrelated),
      'same story must outrank a lookalike'
    );
  });

  test('containment tolerates a longer restatement of a short headline', () => {
    assert.ok(
      titleContainment('Fed cuts rates', 'Federal Reserve cuts rates as markets rally sharply') >= 0.6
    );
  });

  test('pulls asset symbols from prose, preferring cashtags', () => {
    const tickers = extractTickers('Bitcoin and $SOL rallied while the ETF saw outflows');
    assert.ok(tickers.includes('SOL'));
    assert.ok(tickers.includes('BTC'), 'named asset maps to its symbol');
    assert.ok(tickers.includes('ETF'));
  });

  test('clamps on a sentence boundary when there is one', () => {
    const text = 'First sentence here. Second sentence follows. Third one trails off';
    const clamped = clampText(text, 45);
    assert.ok(clamped.length <= 45);
    assert.ok(clamped.endsWith('.'), `expected a sentence boundary, got: ${clamped}`);
    assert.equal(clampText('short', 100), 'short');
  });
});

describe('extraction', () => {
  test('prefers the JSON-LD article body when it is richer than the DOM', () => {
    const body = 'The Federal Reserve lowered rates today by fifty basis points. '.repeat(12);
    const html = `<html><head>
      <meta property="og:title" content="Fed cuts rates"/>
      <meta property="og:description" content="${'A long teaser description that the publisher serves publicly to everyone.'}"/>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'NewsArticle',
        headline: 'Fed cuts rates by 50bps',
        articleBody: body,
        author: { name: 'Jane Reporter' },
        datePublished: '2026-08-06T12:00:00Z',
        isAccessibleForFree: false
      })}</script>
      </head><body><article><p>Short teaser paragraph that stops abruptly here.</p></article></body></html>`;

    const result = extractFromHtml(html, 'https://example.com/a');
    assert.equal(result.source, 'json-ld');
    assert.equal(result.title, 'Fed cuts rates by 50bps');
    assert.equal(result.author, 'Jane Reporter');
    assert.equal(result.jsonLdAccessibleForFree, false);
    assert.ok(result.chars > 400);
  });

  test('walks @graph and tolerates a malformed JSON-LD block', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">${JSON.stringify({
        '@graph': [{ '@type': 'NewsArticle', headline: 'Nested headline', isAccessibleForFree: true }]
      })}</script>
      </head><body><p>${'Real body text that is long enough to survive the filter. '.repeat(6)}</p></body></html>`;
    const result = extractFromHtml(html, 'https://example.com/b');
    assert.equal(result.title, 'Nested headline');
    assert.equal(result.jsonLdAccessibleForFree, true);
  });

  test('drops navigation and keeps prose', () => {
    const html = `<html><body>
      <nav><a href="/a">News</a><a href="/b">Markets</a></nav>
      <aside class="related"><p>Related: some other story you might like today.</p></aside>
      <article>
        <p>${'The central bank announced a change in policy this morning. '.repeat(4)}</p>
        <p>${'Analysts said the move was larger than the market expected. '.repeat(4)}</p>
      </article>
      <footer><p>Copyright 2026 all rights reserved by the publisher.</p></footer>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/c');
    assert.match(result.text, /central bank announced/);
    assert.ok(!/Related:/.test(result.text), 'related module must be dropped');
    assert.ok(!/Copyright/.test(result.text), 'footer must be dropped');
  });

  test('identifies reader-view chrome lines', () => {
    assert.equal(isChromeLine('NewsLearnVideosNewsletters'), true);
    assert.equal(isChromeLine('* * *'), true);
    assert.equal(isChromeLine('Coin Prices BTC'), true);
    assert.equal(
      isChromeLine('The central bank announced a change in policy this morning after a long debate.'),
      false
    );
  });

  test('markdown extraction strips reader chrome and the repeated title', () => {
    const markdown = [
      'Title: Tokyo asks Washington to stop',
      'URL Source: https://example.com/x',
      'Markdown Content:',
      '',
      'NewsLearnVideosNewsletters',
      '',
      'Tokyo asks Washington to stop',
      '',
      '[](https://example.com/author)',
      '',
      '* * *',
      '',
      'Japanese officials have repeatedly asked the United States government to stop posting memes that use protected characters.'
    ].join('\n');

    const result = extractFromMarkdown(markdown, 'https://example.com/x');
    assert.equal(result.title, 'Tokyo asks Washington to stop');
    assert.equal(result.paragraphs.length, 1);
    assert.match(result.paragraphs[0], /Japanese officials/);
  });

  test('prose ratio separates an article from a navigation dump', () => {
    const article = [
      'The central bank announced a significant change in monetary policy this morning.',
      'Analysts across the market said the decision was larger than anyone had expected.'
    ];
    const navDump = ['News Markets Videos', 'Sign in Register Search', 'Home About Contact Us'];
    assert.ok(proseRatio(article) > 0.9);
    assert.ok(proseRatio(navDump) < 0.2);
  });
});

describe('paywall classification', () => {
  test('trusts the publisher schema.org declaration above everything else', () => {
    const access = classifyAccess({
      extracted: { jsonLdAccessibleForFree: false, chars: 300, description: 'x'.repeat(200), paragraphs: ['a'] },
      html: '',
      url: 'https://www.wsj.com/articles/x'
    });
    assert.equal(access.gated, true);
    assert.equal(access.kind, 'hard');
    assert.ok(access.signals.includes('schema_isAccessibleForFree_false'));
    assert.equal(access.recommendation.action, 'pivot');
  });

  test('detects a metered wall from interstitial copy plus a truncated body', () => {
    const access = classifyAccess({
      extracted: { chars: 400, description: 'y'.repeat(200), paragraphs: ['The story begins here'] },
      html: '<div>You have reached your monthly limit. Subscribe to continue reading.</div>',
      url: 'https://www.nytimes.com/2026/08/06/x.html'
    });
    assert.equal(access.gated, true);
    assert.ok(['metered', 'hard'].includes(access.kind));
    assert.equal(access.usable, false);
  });

  test('flags a bot interstitial as empty rather than as article text', () => {
    const access = classifyAccess({
      extracted: {
        chars: 43,
        text: 'Please enable JS and disable any ad blocker',
        paragraphs: ['Please enable JS and disable any ad blocker'],
        description: ''
      },
      html: 'Please enable JS and disable any ad blocker',
      url: 'https://www.wsj.com/articles/x'
    });
    assert.equal(access.empty, true);
    assert.equal(access.usable, false);
    assert.equal(access.kind, 'blocked');
  });

  test('leaves a full open article alone', () => {
    const access = classifyAccess({
      extracted: {
        chars: 5000,
        description: 'A normal description',
        paragraphs: ['Full paragraph one ending properly.'],
        jsonLdAccessibleForFree: true
      },
      html: '<article>full text</article>',
      status: 200,
      url: 'https://decrypt.co/x'
    });
    assert.equal(access.gated, false);
    assert.equal(access.usable, true);
    assert.equal(access.recommendation.action, 'proceed');
  });

  test('knows which outlets gate by default', () => {
    assert.equal(likelyGated('https://www.wsj.com/a'), true);
    assert.equal(likelyGated('https://www.bloomberg.com/a'), true);
    assert.equal(likelyGated('https://decrypt.co/a'), false);
    assert.equal(outletFor('https://www.coindesk.com/x').name, 'CoinDesk');
    assert.equal(outletFor('https://sub.wsj.com/x').model, 'hard');
    assert.equal(outletFor('garbage').model, 'unknown');
  });
});

describe('race scoring', () => {
  const make = (over) => ({ confidence: 0.9, kind: 'article', text: 'x'.repeat(3000), ...over });

  test('a full article beats a gated teaser regardless of arrival order', () => {
    const article = make({ lane: 'direct', confidence: 0.92, kind: 'article' });
    const teaser = make({ lane: 'direct', confidence: 0.35, kind: 'teaser', text: 'x'.repeat(600) });
    assert.ok(scoreCandidate(article) > scoreCandidate(teaser));
  });

  test('the primary source outranks coverage of it', () => {
    assert.ok(
      scoreCandidate(make({ kind: 'primary', confidence: 0.9 })) >
        scoreCandidate(make({ kind: 'sibling', confidence: 0.9 }))
    );
  });

  // Regression: a chrome-heavy reader view once won on character count alone.
  test('volume alone does not beat a cleaner, more confident candidate', () => {
    const junky = make({ lane: 'reader', confidence: 0.62, kind: 'article', text: 'x'.repeat(9000) });
    const clean = make({ lane: 'direct', confidence: 0.92, kind: 'article', text: 'x'.repeat(3200) });
    assert.ok(scoreCandidate(clean) > scoreCandidate(junky));
  });

  test('only a trusted full article can trip the early exit', () => {
    const subscription = make({ lane: 'subscription', confidence: 0.97, kind: 'article' });
    const reader = make({ lane: 'reader', confidence: 0.88, kind: 'article' });
    assert.ok(scoreCandidate(subscription) >= EARLY_EXIT_SCORE);
    assert.ok(scoreCandidate(reader) < EARLY_EXIT_SCORE, 'reader must not end the race early');
  });

  test('a null candidate scores zero rather than throwing', () => {
    assert.equal(scoreCandidate(null), 0);
  });
});

describe('llm output handling', () => {
  test('parses clean json, fenced json, and json buried in prose', () => {
    assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('Here you go:\n{"a":1}\nHope that helps'), { a: 1 });
    assert.deepEqual(parseJsonLoose('{"a":"has } brace"}'), { a: 'has } brace' });
    assert.equal(parseJsonLoose('no json here'), null);
    assert.equal(parseJsonLoose(''), null);
  });

  test('strips fences without eating content', () => {
    assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripJsonFence('{"a":1}'), '{"a":1}');
  });
});

describe('summary normalization', () => {
  const candidate = { title: 'Fed cuts rates', text: 'Bitcoin and $SOL moved on the Fed decision.' };

  test('coerces a well-formed model response into the documented shape', () => {
    const out = normalizeSummary(
      {
        headline: 'Fed cuts by 50bps',
        what_changed: 'The Fed cut rates.',
        assets: [{ symbol: '$btc', exposure: 'direct', direction: 'bullish', why: 'rate sensitive' }],
        status: 'CONFIRMED',
        priced_in: 'partially',
        horizon: 'days',
        numbers: ['50bps cut'],
        counter: 'Already telegraphed.'
      },
      candidate
    );
    assert.equal(out.headline, 'Fed cuts by 50bps');
    assert.equal(out.assets[0].symbol, 'BTC', 'cashtag and case are normalized');
    assert.equal(out.status, 'confirmed', 'enum case is normalized');
    assert.equal(out.horizon, 'days');
  });

  test('rejects invalid enum values instead of passing them through', () => {
    const out = normalizeSummary(
      { headline: 'x', status: 'totally-made-up', priced_in: 'nonsense', horizon: 'eons' },
      candidate
    );
    assert.equal(out.status, 'reported');
    assert.equal(out.priced_in, 'unclear');
    assert.equal(out.horizon, 'hours');
  });

  test('falls back to tickers found in the text when the model names no assets', () => {
    const out = normalizeSummary({ headline: 'x', assets: [] }, candidate);
    assert.ok(out.assets.length > 0, 'should backfill from the text');
    assert.ok(out.assets.some((asset) => asset.symbol === 'SOL'));
  });

  test('survives a garbage response without throwing', () => {
    const out = normalizeSummary({}, candidate);
    assert.equal(out.headline, 'Fed cuts rates', 'falls back to the candidate title');
    assert.deepEqual(out.numbers, []);
  });
});

describe('cookie jar', () => {
  const jarText = [
    '# Netscape HTTP Cookie File',
    '.wsj.com\tTRUE\t/\tTRUE\t9999999999\twsjsession\tabc123',
    '#HttpOnly_.ft.com\tTRUE\t/\tTRUE\t9999999999\tftsession\txyz789',
    'old.example.com\tTRUE\t/\tTRUE\t1\texpired\tgone',
    'malformed line without tabs'
  ].join('\n');

  test('parses a Netscape jar including the HttpOnly prefix', () => {
    const jar = parseJar(jarText);
    assert.ok(jar.has('wsj.com'));
    assert.ok(jar.has('ft.com'), '#HttpOnly_ prefix is a curl extension, not a comment');
    assert.equal(jar.get('wsj.com')[0].name, 'wsjsession');
  });

  test('drops expired cookies', () => {
    assert.equal(parseJar(jarText).has('old.example.com'), false);
  });
});

describe('input handling', () => {
  test('pulls a URL out of arbitrary pasted text', () => {
    assert.equal(urlFrom('check this https://example.com/a out'), 'https://example.com/a');
    assert.equal(urlFrom('https://example.com/a.'), 'https://example.com/a', 'trailing period is punctuation');
    assert.equal(urlFrom('(https://example.com/a)'), 'https://example.com/a');
    assert.equal(urlFrom('no link here'), '');
    assert.equal(urlFrom(''), '');
    assert.equal(urlFrom(null), '');
  });

  test('resolution ids are stable and url-derived', () => {
    assert.equal(resolutionId('https://example.com/a'), resolutionId('https://example.com/a'));
    assert.notEqual(resolutionId('https://example.com/a'), resolutionId('https://example.com/b'));
    assert.match(resolutionId('https://example.com/a'), /^[a-f0-9]{16}$/);
  });

  test('recognizes tweet URLs across the mirror domains', () => {
    assert.equal(tweetIdFrom('https://x.com/user/status/1234567890'), '1234567890');
    assert.equal(tweetIdFrom('https://twitter.com/user/status/1234567890'), '1234567890');
    assert.equal(tweetIdFrom('https://fxtwitter.com/user/status/1234567890'), '1234567890');
    assert.equal(isTweetUrl('https://example.com/a'), false);
  });

  test('collects outbound links from a tweet and its quote, skipping X itself', () => {
    const links = outboundLinks({
      entities: {
        urls: [
          { url: 'https://t.co/a', expanded_url: 'https://wsj.com/article' },
          { url: 'https://t.co/b', expanded_url: 'https://x.com/other/status/1' }
        ]
      },
      quoted_tweet: {
        entities: { urls: [{ url: 'https://t.co/c', expanded_url: 'https://reuters.com/x' }] }
      }
    });
    assert.deepEqual(links, ['https://wsj.com/article', 'https://reuters.com/x']);
  });

  // Regression: a "what happened in crypto today" roundup won the sibling lane
  // and the summary attributed an ETF-inflow figure from an unrelated item in
  // that digest to the story being resolved.
  test('rejects roundups and digests as siblings', () => {
    for (const title of [
      'Here’s what happened in crypto today',
      'Crypto Today: Bitcoin steadies',
      'Daily roundup: markets in brief',
      'Morning Briefing: what to watch',
      'Week in review',
      '5 things to know before the open',
      'Bitcoin liveblog',
      'Market wrap for Thursday'
    ]) {
      assert.equal(isDigest(title), true, `"${title}" should be treated as a digest`);
    }
    assert.equal(isDigest('Wintermute registers as SEC broker-dealer'), false);
    assert.equal(isDigest('Fed cuts rates by 50bps'), false);
  });

  test('verifies a fetched sibling actually covers the story', () => {
    const title = 'Wintermute registers as SEC broker-dealer to trade stocks and crypto ETFs';

    assert.equal(
      coversStory(title, 'Wintermute has registered with the SEC as a broker-dealer, allowing it to trade stocks and ETFs.'),
      true
    );
    // A digest that merely mentions the topic but is mostly other stories.
    assert.equal(
      coversStory(title, 'Bitcoin ETFs saw $620 million in inflows today. Ether rallied. Solana volumes rose.'),
      false
    );
    // Too little in the headline to verify against: do not reject.
    assert.equal(coversStory('Fed cuts', 'anything at all here'), true);
  });

  test('assigns topic context from the outlet or the path', () => {
    assert.equal(topicContext('https://www.coindesk.com/policy/2026/08/06/x'), 'crypto');
    assert.equal(topicContext('https://www.wsj.com/markets/x'), 'markets');
    assert.equal(topicContext('https://example.com/about'), '');
  });
});
