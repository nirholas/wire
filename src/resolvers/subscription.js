import { safeFetch, HttpError } from '../fetch.js';
import { extractFromHtml } from '../extract.js';
import { classifyAccess } from '../paywall.js';
import { cookieHeaderFor, hasSessionFor } from '../cookies.js';

/**
 * Read a gated article with your own subscription.
 *
 * This is the only lane that reliably returns the full text of a hard-gated
 * article, and it is also the cleanest: it presents credentials the publisher
 * issued to you, for content you are paying for. It is what a browser does.
 *
 * It runs only for hosts you have a session for, so it costs nothing and
 * discloses nothing on every other URL.
 */
export const subscriptionResolver = {
  name: 'subscription',
  tier: 1,
  appliesTo: (url) => /^https?:/i.test(url) && hasSessionFor(url),

  async run({ url, signal, timeoutMs }) {
    const cookie = cookieHeaderFor(url);
    if (!cookie) return null;

    let html = '';
    let status = null;
    let finalUrl = url;

    try {
      const res = await safeFetch(url, {
        signal,
        timeoutMs,
        browserIdentity: true,
        maxBytes: 4 * 1024 * 1024,
        headers: {
          cookie,
          // Publishers commonly vary the response on these for logged-in users.
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
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

    if (!html) return null;

    const extracted = extractFromHtml(html, finalUrl);
    if (!extracted.paragraphs.length) return null;

    const access = classifyAccess({ extracted, status, html, url: finalUrl });

    // If the wall is still up, the session is expired or does not cover this
    // title. Say so plainly rather than returning a teaser as if it worked.
    if (!access.usable) {
      return {
        lane: 'subscription',
        kind: 'signal',
        confidence: 0.12,
        title: extracted.title,
        text: extracted.description || '',
        paragraphs: [],
        url: finalUrl,
        outlet: access.outlet.name || access.outlet.host,
        access,
        meta: {
          status,
          reason: 'session_did_not_unlock',
          hint: 'Session cookie is present but the article is still gated. Re-export your cookies, or this title is outside your plan.'
        }
      };
    }

    return {
      lane: 'subscription',
      kind: 'article',
      // The best answer available: full text, from the publisher, first-hand.
      confidence: 0.97,
      title: extracted.title,
      text: extracted.text,
      paragraphs: extracted.paragraphs,
      url: extracted.canonical || finalUrl,
      outlet: extracted.siteName || access.outlet.name || access.outlet.host,
      author: extracted.author,
      published: extracted.published,
      image: extracted.image,
      access,
      meta: { status, chars: extracted.chars, viaSubscription: true }
    };
  }
};

export default subscriptionResolver;
