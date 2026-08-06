import { complete, parseJsonLoose, llmConfigured, NoProviderError } from './llm.js';
import { clampText, extractTickers } from './text.js';
import config from './config.js';

/**
 * The summary.
 *
 * "Summarize this article" produces something nobody needs. A trader reading a
 * headline mid-position has four questions and they are always the same ones:
 * what actually changed, is it real or is somebody talking their book, what does
 * it touch, and what is the case that I am reading it wrong.
 *
 * So the prompt asks for exactly that, with hard instructions against the two
 * failure modes that make an LLM summary worse than useless here: inventing
 * specifics that were not in the text, and hedging every claim into mush.
 */

const SYSTEM = `You are a markets analyst writing for professional crypto traders who are reading this mid-position. They are technical, they are fast, and they punish vagueness.

Write the read, not a recap. Assume the reader can see the headline; tell them what it MEANS.

Hard rules:
- Use ONLY facts present in the supplied text. If a number, name, date, or causal claim is not in the text, it does not exist. Never fill a gap with what is usually true.
- If the supplied text is a teaser, a stub, or coverage headlines rather than a full article, say so in "coverage" and keep every other field to what is actually supported. A short honest answer beats a padded one.
- Distinguish what HAPPENED from what someone SAID or SPECULATED. An unnamed-source report is not a confirmed event.
- No hedging filler. Do not write "could potentially" or "it remains to be seen". Commit, and put your uncertainty in the confidence fields where it belongs.
- Never give financial advice, price targets, or entries. Describe exposure and mechanism; the reader decides the trade.

Return this exact JSON shape:
{
  "headline": "under 90 chars, what actually happened, plain language",
  "what_changed": "1-2 sentences. The concrete delta versus the state of the world yesterday.",
  "why_it_matters": "1-2 sentences on the mechanism. WHY does this move anything? Skip if genuinely unclear from the text.",
  "assets": [{"symbol":"BTC","exposure":"direct|indirect|sentiment","direction":"bullish|bearish|mixed|neutral","why":"under 15 words"}],
  "status": "confirmed|reported|rumored|opinion",
  "status_note": "under 20 words on who is asserting this and how firmly",
  "priced_in": "likely|partially|unlikely|unclear",
  "horizon": "minutes|hours|days|weeks|structural",
  "numbers": ["the 2-5 figures that matter, each with its unit and what it measures"],
  "counter": "The strongest reason this is less important than it looks. Always fill this in.",
  "coverage": "one line on the quality of the source text you were given"
}`;

/** Keeps the prompt inside a size where every provider stays fast. */
const MAX_BODY_CHARS = 9000;

function buildUserPrompt({ candidate, url, context }) {
  const lines = [];

  lines.push(`SOURCE URL: ${url}`);
  if (candidate.outlet) lines.push(`OUTLET: ${candidate.outlet}`);
  if (candidate.published) lines.push(`PUBLISHED: ${candidate.published}`);
  if (candidate.author) lines.push(`AUTHOR: ${candidate.author}`);

  // Telling the model exactly what kind of text it received is what keeps it
  // honest when the text is a teaser rather than an article.
  const provenance = {
    subscription: 'FULL ARTICLE, read with the user\'s own paid subscription.',
    direct: 'FULL ARTICLE as served publicly by the outlet.',
    reader: 'FULL ARTICLE via a reader-view renderer.',
    siblings:
      'A DIFFERENT OUTLET\'S ARTICLE about the same event. The link the user sent was gated; this is independent coverage of the same story.',
    primary:
      'THE PRIMARY SOURCE DOCUMENT this story is about (filing, announcement, or release), not press coverage.',
    wayback: 'AN ARCHIVED SNAPSHOT of the article. It may be an earlier revision.',
    archive: 'AN ARCHIVED SNAPSHOT of the article. It may be an earlier revision.',
    tweet: 'A SINGLE POST from X. Short by nature; do not treat it as a reported article.'
  };
  lines.push(`TEXT PROVENANCE: ${provenance[candidate.lane] || 'Unverified extraction.'}`);

  if (candidate.kind === 'teaser') {
    lines.push('WARNING: This is a PAYWALL TEASER, not the article. Only the opening survives.');
  }
  if (candidate.kind === 'coverage') {
    lines.push('WARNING: These are HEADLINES from multiple outlets, not article text.');
  }
  if (candidate.meta?.snapshot) {
    lines.push(`SNAPSHOT DATE: ${candidate.meta.snapshot} (the live article may have since changed)`);
  }

  if (context?.tweet) {
    lines.push('', 'THE POST THAT SURFACED THIS:', context.tweet);
  }
  if (context?.coverage?.length) {
    const others = context.coverage
      .slice(0, 6)
      .map((entry) => `- ${entry.outlet}: ${entry.title}`)
      .join('\n');
    lines.push('', 'OTHER OUTLETS RUNNING THE SAME STORY:', others);
  }

  lines.push('', `TITLE: ${candidate.title || '(none)'}`, '', 'TEXT:', clampText(candidate.text, MAX_BODY_CHARS));

  return lines.join('\n');
}

/** Coerces model output into the documented shape so consumers can trust it. */
function normalize(raw, candidate) {
  const asString = (value, max = 400) =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';
  const oneOf = (value, allowed, fallback) =>
    allowed.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : fallback;

  const assets = Array.isArray(raw?.assets)
    ? raw.assets
        .filter((asset) => asset && typeof asset.symbol === 'string')
        .slice(0, 8)
        .map((asset) => ({
          symbol: asset.symbol.toUpperCase().replace(/^\$/, '').slice(0, 10),
          exposure: oneOf(asset.exposure, ['direct', 'indirect', 'sentiment'], 'indirect'),
          direction: oneOf(asset.direction, ['bullish', 'bearish', 'mixed', 'neutral'], 'neutral'),
          why: asString(asset.why, 120)
        }))
    : [];

  // Backstop: if the model named no assets, fall back to symbols we can find in
  // the text ourselves rather than returning an empty list.
  if (!assets.length) {
    for (const symbol of extractTickers(`${candidate.title} ${candidate.text}`, 4)) {
      assets.push({ symbol, exposure: 'indirect', direction: 'neutral', why: 'mentioned in the text' });
    }
  }

  return {
    headline: asString(raw?.headline, 140) || candidate.title?.slice(0, 140) || '',
    what_changed: asString(raw?.what_changed, 500),
    why_it_matters: asString(raw?.why_it_matters, 500),
    assets,
    status: oneOf(raw?.status, ['confirmed', 'reported', 'rumored', 'opinion'], 'reported'),
    status_note: asString(raw?.status_note, 200),
    priced_in: oneOf(raw?.priced_in, ['likely', 'partially', 'unlikely', 'unclear'], 'unclear'),
    horizon: oneOf(raw?.horizon, ['minutes', 'hours', 'days', 'weeks', 'structural'], 'hours'),
    numbers: Array.isArray(raw?.numbers)
      ? raw.numbers.filter((entry) => typeof entry === 'string').slice(0, 6).map((entry) => entry.slice(0, 160))
      : [],
    counter: asString(raw?.counter, 400),
    coverage: asString(raw?.coverage, 240)
  };
}

/**
 * @returns {Promise<{summary:object, provider:string, model:string, latencyMs:number}|null>}
 *          null when no provider is configured, which is a supported mode:
 *          wire still returns the extracted text.
 */
export async function summarize({ candidate, url, context = {}, signal, timeoutMs } = {}) {
  if (!candidate?.text || candidate.text.length < 80) return null;
  if (!llmConfigured()) return null;

  try {
    const result = await complete({
      system: SYSTEM,
      user: buildUserPrompt({ candidate, url, context }),
      maxTokens: 1100,
      temperature: 0.15,
      json: true,
      timeoutMs: timeoutMs || config.llmBudgetMs,
      signal
    });

    const parsed = parseJsonLoose(result.text);
    if (!parsed) return null;

    return {
      summary: normalize(parsed, candidate),
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage
    };
  } catch (err) {
    if (err instanceof NoProviderError) return null;
    return { summary: null, error: err.message?.slice(0, 300), provider: null, model: null };
  }
}

export { SYSTEM as SUMMARY_SYSTEM_PROMPT, buildUserPrompt, normalize };
