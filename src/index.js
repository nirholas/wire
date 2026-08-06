import { createHash } from 'node:crypto';

import config from './config.js';
import { race, scoreCandidate } from './race.js';
import { summarize } from './summarize.js';
import { tweetResolver, isTweetUrl } from './resolvers/tweet.js';
import { extractTickers } from './text.js';
import { outletFor } from './paywall.js';
import { cacheGet, cacheSet, recordResolution } from './cache.js';
import { hasSessionFor } from './cookies.js';

export { race, summarize, config };

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Pulls the first URL out of arbitrary text, e.g. a pasted Telegram message. */
export function urlFrom(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const matches = text.match(URL_PATTERN);
  if (!matches?.length) return '';
  // Trailing punctuation is almost always sentence punctuation, not the URL.
  return matches[0].replace(/[.,;:!?)]+$/, '');
}

export function resolutionId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/**
 * Improvement threshold for re-running the summary after a late lane wins. A
 * marginally better candidate is not worth a second inference call and a second
 * message edit; a materially better one is.
 */
const RESUMMARIZE_DELTA = 0.14;

/**
 * Resolve a link to the trade.
 *
 * Emits progressively: the caller gets something to show within a few hundred
 * milliseconds and every improvement after that, in order. The returned promise
 * settles when the fast path is done; `settled` settles when every lane and any
 * follow-up summary have finished.
 *
 * @param {string} input  a URL, or any text containing one
 * @param {object} options
 * @param {(update:object)=>void} [options.onUpdate]
 * @param {number} [options.budgetMs]
 * @param {boolean} [options.withSummary=true]
 * @param {string[]|null} [options.only]
 * @param {boolean} [options.fresh=false]  bypass the resolution cache
 * @param {AbortSignal} [options.signal]
 */
export async function resolve(input, options = {}) {
  const {
    onUpdate = () => {},
    budgetMs = config.budgetMs,
    withSummary = true,
    only = null,
    exclude = [],
    fresh = false,
    signal
  } = options;

  const startedAt = Date.now();
  const url = urlFrom(input);
  if (!url) {
    const error = new Error('No URL found in input.');
    error.code = 'NO_URL';
    throw error;
  }

  const id = resolutionId(url);
  const cacheKey = `resolve:${id}:${withSummary ? 'sum' : 'raw'}`;

  if (!fresh) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      const cachedResult = { ...hit, cached: true, elapsedMs: Date.now() - startedAt };
      onUpdate({ stage: 'cached', elapsedMs: cachedResult.elapsedMs, result: cachedResult });
      return cachedResult;
    }
  }

  const emitted = [];
  const emit = (update) => {
    const payload = { ...update, elapsedMs: Date.now() - startedAt };
    emitted.push({ stage: payload.stage, at: payload.elapsedMs });
    try {
      onUpdate(payload);
    } catch {
      /* a listener that throws must not take the resolution down */
    }
  };

  /* -------------------------------------------------------------------------
   * Stage 1: the post itself. Instant, and often carries the whole trade.
   * ---------------------------------------------------------------------- */
  let tweet = null;
  let target = url;
  const hints = {};

  if (isTweetUrl(url)) {
    try {
      tweet = await tweetResolver.run({
        url,
        signal,
        timeoutMs: 3000,
        hints: {},
        waitForHint: async () => ''
      });
    } catch {
      tweet = null;
    }

    if (tweet) {
      emit({
        stage: 'post',
        post: {
          author: tweet.author,
          title: tweet.title,
          text: tweet.text,
          published: tweet.published,
          verified: tweet.meta.verified,
          followers: tweet.meta.followers,
          links: tweet.meta.outboundLinks
        },
        tickers: extractTickers(tweet.text, 6)
      });

      hints.title = tweet.text.split('\n')[0]?.slice(0, 160) || '';
      const parsed = Date.parse(tweet.published || '');
      if (Number.isFinite(parsed)) hints.publishedAt = parsed;

      // The article the post points at is what we actually want to resolve.
      const [firstLink] = tweet.meta.outboundLinks;
      if (firstLink) target = firstLink;
    }
  }

  const outlet = outletFor(target);
  emit({
    stage: 'target',
    target,
    outlet,
    // Set expectations up front: the UI can say "WSJ, hard wall, routing around it".
    expectGated: outlet.model === 'hard' || outlet.model === 'metered',
    haveSubscription: hasSessionFor(target)
  });

  /* -------------------------------------------------------------------------
   * Stage 2: race every lane, emitting each improvement.
   * ---------------------------------------------------------------------- */
  const isSameAsPost = target === url && Boolean(tweet);
  let raceResult = null;

  if (!isSameAsPost) {
    raceResult = await race(target, {
      budgetMs,
      onUpdate: (update) =>
        emit({
          stage: 'text',
          lane: update.lane,
          score: Number(update.score.toFixed(3)),
          candidate: publicCandidate(update.best),
          candidateCount: update.candidateCount
        }),
      hints,
      only,
      exclude,
      signal
    });
  }

  // With no article to chase, the post IS the answer.
  let best = raceResult?.best || tweet;
  if (!best) {
    const result = finalize({
      id,
      url,
      target,
      tweet,
      best: null,
      raceResult,
      summary: null,
      startedAt,
      emitted
    });
    emit({ stage: 'done', result });
    return result;
  }

  /* -------------------------------------------------------------------------
   * Stage 3: the read.
   * ---------------------------------------------------------------------- */
  const context = {
    tweet: tweet?.text || '',
    coverage: best.meta?.coverage || []
  };

  let summaryResult = null;
  if (withSummary) {
    summaryResult = await summarize({ candidate: best, url: target, context, signal });
    if (summaryResult?.summary) {
      emit({
        stage: 'summary',
        summary: summaryResult.summary,
        provider: summaryResult.provider,
        model: summaryResult.model,
        summaryLatencyMs: summaryResult.latencyMs
      });
    } else if (summaryResult?.error) {
      emit({ stage: 'summary_failed', error: summaryResult.error });
    }
  }

  const result = finalize({
    id,
    url,
    target,
    tweet,
    best,
    raceResult,
    summary: summaryResult,
    startedAt,
    emitted
  });

  emit({ stage: 'done', result });
  cacheSet(cacheKey, result, 30 * 60 * 1000);
  recordResolution(result);

  /* -------------------------------------------------------------------------
   * Stage 4: late upgrades. The slow lanes are still running. If one of them
   * beats what we already reported, re-summarize and emit the improvement so
   * an already-posted message can sharpen in place.
   * ---------------------------------------------------------------------- */
  const settled = (async () => {
    if (!raceResult?.settled) return result;

    const finalRace = await raceResult.settled;
    const improved = finalRace.best;
    if (!improved || improved === best) return result;

    const delta = scoreCandidate(improved) - scoreCandidate(best);
    if (delta < RESUMMARIZE_DELTA) return result;

    emit({
      stage: 'text',
      lane: improved.lane,
      late: true,
      score: Number(scoreCandidate(improved).toFixed(3)),
      candidate: publicCandidate(improved)
    });

    let lateSummary = null;
    if (withSummary) {
      lateSummary = await summarize({
        candidate: improved,
        url: target,
        context: { ...context, coverage: improved.meta?.coverage || context.coverage },
        signal
      });
      if (lateSummary?.summary) {
        emit({
          stage: 'summary',
          late: true,
          summary: lateSummary.summary,
          provider: lateSummary.provider,
          model: lateSummary.model,
          summaryLatencyMs: lateSummary.latencyMs
        });
      }
    }

    const upgraded = finalize({
      id,
      url,
      target,
      tweet,
      best: improved,
      raceResult: finalRace,
      summary: lateSummary || summaryResult,
      startedAt,
      emitted
    });

    emit({ stage: 'done', late: true, result: upgraded });
    cacheSet(cacheKey, upgraded, 30 * 60 * 1000);
    recordResolution(upgraded);
    return upgraded;
  })();

  // A late-upgrade failure must never reject into an unhandled rejection.
  settled.catch(() => {});
  result.settled = settled;
  return result;
}

/** The candidate fields that are safe and useful to expose to a UI. */
function publicCandidate(candidate) {
  if (!candidate) return null;
  return {
    lane: candidate.lane,
    kind: candidate.kind,
    confidence: candidate.confidence,
    title: candidate.title,
    outlet: candidate.outlet,
    url: candidate.url,
    author: candidate.author || '',
    published: candidate.published || '',
    chars: candidate.text?.length || 0,
    excerpt: (candidate.text || '').slice(0, 400),
    latencyMs: candidate.latencyMs ?? null,
    snapshot: candidate.meta?.snapshot || null
  };
}

function finalize({ id, url, target, tweet, best, raceResult, summary, startedAt, emitted }) {
  const access = best?.access || null;

  return {
    id,
    url,
    target,
    permalink: `/r/${id}`,

    route: best?.lane || 'none',
    kind: best?.kind || 'none',
    resolved: Boolean(best?.text),

    title: best?.title || tweet?.title || '',
    outlet: best?.outlet || '',
    author: best?.author || '',
    published: best?.published || '',
    text: best?.text || '',
    paragraphs: best?.paragraphs || [],
    sourceUrl: best?.url || target,

    post: tweet
      ? {
          author: tweet.author,
          text: tweet.text,
          published: tweet.published,
          verified: tweet.meta.verified,
          followers: tweet.meta.followers,
          links: tweet.meta.outboundLinks
        }
      : null,

    gated: Boolean(access?.gated),
    access: access
      ? {
          kind: access.kind,
          confidence: access.confidence,
          signals: access.signals,
          why: access.recommendation?.why || ''
        }
      : null,

    tickers: extractTickers(`${best?.title || ''} ${best?.text || tweet?.text || ''}`, 6),
    coverage: best?.meta?.coverage || [],

    summary: summary?.summary || null,
    summaryMeta: summary
      ? { provider: summary.provider, model: summary.model, latencyMs: summary.latencyMs }
      : null,
    /**
     * Why there is no read, when there is no read. A silent missing summary
     * looks like "nothing to say about this story", which is a different and
     * much worse message than "every provider was rate limited".
     */
    summaryError: summary?.error || null,

    lanes: raceResult?.lanes || [],
    timeline: emitted,
    elapsedMs: Date.now() - startedAt,
    resolvedAt: new Date().toISOString(),
    cached: false
  };
}

export { publicCandidate };
export default resolve;
