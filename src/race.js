import config from './config.js';
import { resolversFor } from './resolvers/index.js';

/**
 * The race.
 *
 * Every lane starts at once. The first usable answer is emitted immediately,
 * and every strictly better answer that arrives afterwards is emitted as an
 * upgrade. The budget bounds when we stop *waiting*, not when we stop
 * *listening*: slow lanes keep running and their results still flow to the
 * caller, which is what lets a Telegram message keep sharpening after it has
 * already been posted.
 *
 * This is the whole latency story. Nobody waits for the best answer when a good
 * one is available now and the best one will replace it in place.
 */

/** How much a kind of answer is worth, independent of the lane's own confidence. */
const KIND_WEIGHT = {
  primary: 1.0,
  article: 0.98,
  sibling: 0.9,
  tweet: 0.72,
  coverage: 0.45,
  pointer: 0.35,
  teaser: 0.3,
  signal: 0.1
};

/**
 * Score at which the race stops waiting. Reachable by a full article from the
 * subscription, direct, or primary lanes; not reachable by reader, archive, or
 * a sibling on its own.
 */
export const EARLY_EXIT_SCORE = 0.93;

export function scoreCandidate(candidate) {
  if (!candidate) return 0;
  const kind = KIND_WEIGHT[candidate.kind] ?? 0.4;
  const chars = candidate.text?.length || 0;

  // Text volume matters up to about two thousand characters, past which more
  // words stop meaning more information.
  const depth = Math.min(chars / 2000, 1);

  // A teaser or a bare signal should never beat real prose on volume alone.
  const substance = candidate.kind === 'teaser' || candidate.kind === 'signal' ? depth * 0.15 : depth;

  return candidate.confidence * 0.6 + kind * 0.3 + substance * 0.1;
}

/**
 * A hint registry the lanes share. The direct lane learns the headline in a few
 * hundred milliseconds; the sibling and primary lanes need exactly that to build
 * a query. Rather than serializing them, they subscribe and continue.
 */
function createHints(initial = {}) {
  const values = { ...initial };
  const waiters = new Map();

  const set = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (values[key]) return; // first writer wins; later lanes are not better informed
    values[key] = value;
    const pending = waiters.get(key);
    if (pending) {
      waiters.delete(key);
      for (const resolve of pending) resolve(value);
    }
  };

  const wait = (key, maxMs) =>
    new Promise((resolve) => {
      if (values[key]) return resolve(values[key]);
      const list = waiters.get(key) || [];
      list.push(resolve);
      waiters.set(key, list);
      setTimeout(() => {
        const current = waiters.get(key);
        if (current) {
          const index = current.indexOf(resolve);
          if (index >= 0) current.splice(index, 1);
        }
        resolve(values[key] || '');
      }, maxMs).unref?.();
    });

  return { values, set, wait };
}

/**
 * @param {string} url
 * @param {object} options
 * @param {number} [options.budgetMs]      when to stop waiting and report
 * @param {(update:object)=>void} [options.onUpdate]  called on every improvement
 * @param {object} [options.hints]         seed hints, e.g. a title from a tweet
 * @param {string[]|null} [options.only]   restrict to named lanes
 * @param {string[]} [options.exclude]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{best:object|null, candidates:object[], lanes:object[], settled:Promise}>}
 */
export async function race(url, options = {}) {
  const {
    budgetMs = config.budgetMs,
    resolverTimeoutMs = config.resolverTimeoutMs,
    onUpdate = () => {},
    hints: seedHints = {},
    only = null,
    exclude = [],
    signal: externalSignal
  } = options;

  const startedAt = Date.now();
  const hints = createHints(seedHints);
  const controller = new AbortController();
  externalSignal?.addEventListener('abort', () => controller.abort(), { once: true });

  const lanes = resolversFor(url, { only, exclude });
  const candidates = [];
  const laneReports = [];

  let best = null;
  let bestScore = 0;

  const consider = (candidate) => {
    if (!candidate) return;
    candidates.push(candidate);

    // Feed what we learned back to lanes still waiting on it.
    hints.set('title', candidate.title);
    if (candidate.published) {
      const parsed = Date.parse(candidate.published);
      if (Number.isFinite(parsed)) hints.set('publishedAt', parsed);
    }
    if (candidate.outlet) hints.set('outlet', candidate.outlet);

    const score = scoreCandidate(candidate);
    if (score <= bestScore) return;

    best = candidate;
    bestScore = score;
    onUpdate({
      best: candidate,
      score,
      elapsedMs: Date.now() - startedAt,
      lane: candidate.lane,
      candidateCount: candidates.length
    });
  };

  const runLane = async (resolver) => {
    const laneStart = Date.now();
    try {
      const candidate = await resolver.run({
        url,
        signal: controller.signal,
        timeoutMs: resolverTimeoutMs,
        hints: hints.values,
        waitForHint: hints.wait
      });
      const elapsedMs = Date.now() - laneStart;
      laneReports.push({
        lane: resolver.name,
        ok: Boolean(candidate),
        elapsedMs,
        kind: candidate?.kind || null
      });
      if (candidate) consider({ ...candidate, latencyMs: elapsedMs });
      return candidate;
    } catch (err) {
      laneReports.push({
        lane: resolver.name,
        ok: false,
        elapsedMs: Date.now() - laneStart,
        error: err?.message?.slice(0, 200) || String(err)
      });
      return null;
    }
  };

  const running = lanes.map(runLane);
  /** Resolves when every lane has finished, however long that takes. */
  const allSettled = Promise.allSettled(running);

  // Wait for the budget, but return early once we hold an answer good enough
  // that no remaining lane could plausibly improve on it.
  await Promise.race([
    allSettled,
    new Promise((resolve) => setTimeout(resolve, budgetMs).unref?.()),
    new Promise((resolve) => {
      const check = setInterval(() => {
        /**
         * Only bail early on a near-certain answer. A merely good candidate
         * that happens to arrive first (a reader view at 350ms) would otherwise
         * end the race before the outlet's own copy lands at 1.1s and wins.
         * The bar is set above what any single mid-confidence lane can reach
         * alone, so early exit means "a trusted lane returned a full article".
         */
        if (bestScore >= EARLY_EXIT_SCORE) {
          clearInterval(check);
          resolve();
        }
      }, 40);
      check.unref?.();
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, budgetMs).unref?.();
    })
  ]);

  /**
   * Handed back so the caller can keep listening. Late lanes still call
   * onUpdate; awaiting this tells you the race is fully done.
   */
  const settled = allSettled.then(() => ({
    best,
    bestScore,
    candidates,
    lanes: laneReports,
    elapsedMs: Date.now() - startedAt
  }));

  return {
    best,
    bestScore,
    candidates: [...candidates],
    lanes: [...laneReports],
    elapsedMs: Date.now() - startedAt,
    hints: hints.values,
    settled,
    abort: () => controller.abort()
  };
}

export { KIND_WEIGHT, createHints };
