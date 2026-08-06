import { safeFetch, HttpError } from '../fetch.js';
import { extractFromHtml } from '../extract.js';
import { classifyAccess, likelyGated } from '../paywall.js';

/**
 * Fetch the page and read what the server sends. No trickery: one plain GET
 * with an honest browser identity, then parse the document that arrives.
 *
 * On an open outlet this is the best possible answer and it usually lands
 * first. On a gated one it still earns its slot, because it produces the
 * classification that tells the planner which lane to trust instead, and the
 * teaser it returns is a usable fallback if every other lane comes back empty.
 */
export const directResolver = {
  name: 'direct',
  tier: 1,
  appliesTo: (url) => /^https?:/i.test(url),

  async run({ url, signal, timeoutMs }) {
    let html = '';
    let status = null;
    let finalUrl = url;

    try {
      const res = await safeFetch(url, {
        signal,
        timeoutMs,
        browserIdentity: true,
        maxBytes: 3 * 1024 * 1024
      });
      html = res.text;
      status = res.status;
      finalUrl = res.url;
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        html = err.body || '';
      } else {
        throw err;
      }
    }

    const extracted = html ? extractFromHtml(html, finalUrl) : null;
    const access = classifyAccess({ extracted, status, html, url: finalUrl });

    if (!extracted || !extracted.paragraphs.length) {
      // Nothing readable, but the classification is still worth returning so the
      // planner can pivot with confidence rather than guessing.
      return {
        lane: 'direct',
        kind: 'signal',
        confidence: 0.15,
        title: extracted?.title || '',
        text: extracted?.description || '',
        paragraphs: extracted?.description ? [extracted.description] : [],
        url: finalUrl,
        outlet: access.outlet.name || access.outlet.host,
        author: extracted?.author || '',
        published: extracted?.published || '',
        access,
        meta: { status, reason: 'no_body' }
      };
    }

    // An interstitial carries no content at all. Report the classification so
    // the planner can pivot, but never offer the stub as readable text.
    if (access.empty) {
      return {
        lane: 'direct',
        kind: 'signal',
        confidence: 0.1,
        title: extracted.title || '',
        text: '',
        paragraphs: [],
        url: finalUrl,
        outlet: access.outlet.name || access.outlet.host,
        access,
        meta: { status, reason: 'bot_interstitial' }
      };
    }

    // A gated teaser is not a substitute for the article. Score it low so any
    // real prose from another lane outranks it, but keep it as a floor.
    const confidence = access.usable ? 0.92 : 0.35;

    return {
      lane: 'direct',
      kind: access.usable ? 'article' : 'teaser',
      confidence,
      title: extracted.title,
      text: extracted.text,
      paragraphs: extracted.paragraphs,
      url: extracted.canonical || finalUrl,
      outlet: extracted.siteName || access.outlet.name || access.outlet.host,
      author: extracted.author,
      published: extracted.published,
      image: extracted.image,
      access,
      meta: { status, extraction: extracted.source, chars: extracted.chars }
    };
  },

  /**
   * On an outlet we know hard-gates, the direct lane still runs (we want the
   * classification) but the planner should not hold the budget open for it.
   */
  deprioritize: (url) => likelyGated(url)
};

export default directResolver;
