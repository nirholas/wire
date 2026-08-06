import { safeFetch } from '../fetch.js';
import { extractFromMarkdown } from '../extract.js';
import { classifyAccess } from '../paywall.js';

/**
 * Jina Reader (r.jina.ai) renders a page and returns clean markdown. Free,
 * keyless, and it succeeds on the large class of pages where the prose is
 * behind client-side rendering rather than behind a wall, which our own static
 * parse cannot see.
 *
 * It is not a paywall tool and does not behave like one: against a hard wall it
 * returns the same teaser a browser would. We run it because roughly a third of
 * "broken" links are JavaScript-rendered, not gated.
 */
export const readerResolver = {
  name: 'reader',
  tier: 1,
  appliesTo: (url) => /^https?:/i.test(url),

  async run({ url, signal, timeoutMs }) {
    const { text: markdown } = await safeFetch(`https://r.jina.ai/${url}`, {
      signal,
      timeoutMs,
      accept: 'text/plain,text/markdown,*/*;q=0.8',
      headers: {
        'x-return-format': 'markdown',
        'x-retain-images': 'none'
      },
      maxBytes: 2 * 1024 * 1024
    });

    if (!markdown || markdown.length < 200) return null;

    const extracted = extractFromMarkdown(markdown, url);
    if (!extracted.paragraphs.length) return null;

    const access = classifyAccess({ extracted, html: markdown, url });

    /**
     * Reader output is rendered chrome and all, so a low prose ratio means we
     * are holding a navigation dump. Scoring that as a confident article is how
     * a nav bar wins a race against the real body.
     */
    const quality = extracted.prose ?? 1;
    const confidence = access.usable ? 0.88 * (0.55 + quality * 0.45) : 0.3;

    return {
      lane: 'reader',
      kind: access.usable ? 'article' : 'teaser',
      confidence: Number(confidence.toFixed(3)),
      title: extracted.title,
      text: extracted.text,
      paragraphs: extracted.paragraphs,
      url,
      outlet: access.outlet.name || access.outlet.host,
      author: '',
      published: extracted.published,
      access,
      meta: { chars: extracted.chars, extraction: 'reader', prose: Number(quality.toFixed(2)) }
    };
  }
};

export default readerResolver;
