import { parse } from 'node-html-parser';

/**
 * HTML to clean prose.
 *
 * This is a readability-style density scorer rather than a wrapper around
 * Readability itself, because we need two things that library does not give us:
 * the JSON-LD article body (which publishers embed for Google and which is
 * frequently richer than the rendered DOM), and a truncation signal we can feed
 * to the paywall classifier.
 */

const STRIP_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'form',
  'nav',
  'aside',
  'header',
  'footer',
  'figure',
  'figcaption',
  'button',
  'template'
];

/** Class and id fragments that reliably mark chrome rather than article body. */
const JUNK_PATTERN =
  /(^|[-_\s])(nav|menu|sidebar|promo|advert|ad-|ads?$|banner|newsletter|signup|subscribe|paywall|meter|related|recirc|trending|most-read|share|social|comment|disqus|cookie|consent|modal|popup|breadcrumb|byline-social|tags?|footer|masthead)([-_\s]|$)/i;

/** Boilerplate lines that survive extraction and add nothing. */
const NOISE_LINE =
  /^(share this|read more|advertisement|sign up|subscribe|follow us|related:|image:|photo:|source:|getty images|reuters\/|copyright|all rights reserved|click here|listen to this article|create an account|add \w+ as your preferred source|edited by|in brief|\d+ min read)/i;

/**
 * Reader-view markdown carries the page's navigation as prose. These lines pass
 * a naive length filter and then dominate the extraction by sheer volume, which
 * is how a nav bar beats an article. Each test below is a shape that only
 * chrome has.
 */
function isChromeLine(text) {
  if (/^[*\-_\s]+$/.test(text)) return true; // rule separators

  // Run-together nav: "NewsLearnVideosNewsletters", "NewsPredictLearnVideos".
  if (/[a-z][A-Z]/.test(text) && !/[.!?]/.test(text) && text.split(/\s+/).length < 8) return true;

  // A line that was mostly link syntax before we stripped it.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 12 && !/[.!?]$/.test(text) && /https?:\/\//.test(text)) return true;

  // No sentence punctuation and too short to be a real paragraph.
  if (words.length < 9 && !/[.!?:]$/.test(text)) return true;

  return false;
}

function textOf(node) {
  return (node.text || '').replace(/\s+/g, ' ').trim();
}

function looksLikeJunk(node) {
  const attrs = `${node.getAttribute?.('class') || ''} ${node.getAttribute?.('id') || ''}`;
  return JUNK_PATTERN.test(attrs);
}

/** Splits a blob of prose into paragraphs when the source lost its markup. */
function paragraphsFromBlob(blob) {
  return blob
    .split(/\n{2,}|(?<=[.!?"”])\s{2,}/)
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter((chunk) => chunk.length > 40);
}

function cleanParagraphs(candidates, { strict = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < 25) continue;
    if (NOISE_LINE.test(text)) continue;
    if (strict && isChromeLine(text)) continue;
    const key = text.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Fraction of the extraction that reads like prose. A page whose "article" is
 * 70% fragments is a navigation dump, and the resolver should score it as such
 * rather than winning the race on character count.
 */
export function proseRatio(paragraphs) {
  if (!paragraphs.length) return 0;
  const prose = paragraphs.filter(
    (text) => text.split(/\s+/).length >= 12 && /[.!?]/.test(text)
  );
  const proseChars = prose.reduce((sum, text) => sum + text.length, 0);
  const totalChars = paragraphs.reduce((sum, text) => sum + text.length, 0);
  return totalChars ? proseChars / totalChars : 0;
}

/**
 * Walks every JSON-LD block. Publishers put `articleBody` here for search
 * engines, and it is plain text in the document they already served us.
 */
export function jsonLdArticle(root) {
  const blocks = root.querySelectorAll('script[type="application/ld+json"]');
  const found = { body: '', headline: '', published: '', author: '', accessibleForFree: null };

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node['@graph']) visit(node['@graph']);

    if (typeof node.articleBody === 'string' && node.articleBody.length > found.body.length) {
      found.body = node.articleBody;
    }
    if (!found.headline && typeof node.headline === 'string') found.headline = node.headline;
    if (!found.published && typeof node.datePublished === 'string') found.published = node.datePublished;
    if (!found.author) {
      const author = node.author;
      if (typeof author === 'string') found.author = author;
      else if (author?.name) found.author = author.name;
      else if (Array.isArray(author) && author[0]?.name) found.author = author[0].name;
    }
    if (found.accessibleForFree === null && node.isAccessibleForFree !== undefined) {
      const value = node.isAccessibleForFree;
      found.accessibleForFree = value === true || value === 'True' || value === 'true';
    }
  };

  for (const block of blocks) {
    try {
      visit(JSON.parse(block.rawText || block.text || '{}'));
    } catch {
      /* a malformed block is common and not worth failing over */
    }
  }
  return found;
}

export function metaContent(root, names) {
  for (const name of names) {
    const node =
      root.querySelector(`meta[property="${name}"]`) || root.querySelector(`meta[name="${name}"]`);
    const value = node?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return '';
}

/**
 * Scores every plausible container by the amount of paragraph text it holds,
 * discounting link-heavy blocks (navigation and recirculation modules are dense
 * with anchors and light on sentences).
 */
function bestContainer(root) {
  const containers = [
    ...root.querySelectorAll('article'),
    ...root.querySelectorAll('main'),
    ...root.querySelectorAll('[itemprop="articleBody"]'),
    ...root.querySelectorAll('[class*="article-body"]'),
    ...root.querySelectorAll('[class*="story-body"]'),
    ...root.querySelectorAll('[class*="post-content"]'),
    ...root.querySelectorAll('[class*="entry-content"]'),
    ...root.querySelectorAll('div'),
    ...root.querySelectorAll('section')
  ];

  let best = null;
  let bestScore = 0;

  for (const node of containers) {
    if (looksLikeJunk(node)) continue;
    const paragraphs = node.querySelectorAll('p');
    if (paragraphs.length < 2) continue;

    let score = 0;
    for (const p of paragraphs) {
      if (looksLikeJunk(p)) continue;
      const text = textOf(p);
      if (text.length < 40) continue;
      const linkChars = p
        .querySelectorAll('a')
        .reduce((sum, anchor) => sum + textOf(anchor).length, 0);
      const linkDensity = text.length ? linkChars / text.length : 1;
      if (linkDensity > 0.5) continue;
      score += text.length * (1 - linkDensity);
    }

    // Prefer the tightest container at a given score so we do not swallow the
    // whole page when a wrapper div happens to contain the article.
    if (score > bestScore * 1.1) {
      bestScore = score;
      best = node;
    }
  }

  return { node: best, score: bestScore };
}

/**
 * @returns {{
 *   title: string, paragraphs: string[], text: string, chars: number,
 *   author: string, published: string, description: string, image: string,
 *   siteName: string, canonical: string, source: string,
 *   jsonLdAccessibleForFree: boolean|null, jsonLdBodyChars: number
 * }}
 */
export function extractFromHtml(html, url = '') {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: true, style: true, noscript: true }
  });

  const jsonLd = jsonLdArticle(root);
  const description = metaContent(root, [
    'og:description',
    'twitter:description',
    'description'
  ]);
  const title =
    jsonLd.headline ||
    metaContent(root, ['og:title', 'twitter:title']) ||
    textOf(root.querySelector('h1') || {}) ||
    textOf(root.querySelector('title') || {});

  for (const tag of STRIP_TAGS) {
    for (const node of root.querySelectorAll(tag)) node.remove();
  }

  const { node: container } = bestContainer(root);
  const domParagraphs = container
    ? cleanParagraphs(
        container
          .querySelectorAll('p, li, h2, h3, blockquote')
          .filter((node) => !looksLikeJunk(node))
          .map(textOf)
      )
    : cleanParagraphs(root.querySelectorAll('p').map(textOf));

  const ldParagraphs = jsonLd.body ? cleanParagraphs(paragraphsFromBlob(jsonLd.body)) : [];

  const domChars = domParagraphs.join(' ').length;
  const ldChars = ldParagraphs.join(' ').length;

  // Whichever view of the same served document is more complete wins.
  const useLd = ldChars > domChars * 1.15;
  const paragraphs = useLd ? ldParagraphs : domParagraphs;

  return {
    title: title.trim(),
    paragraphs,
    text: paragraphs.join('\n\n'),
    chars: paragraphs.join(' ').length,
    author: jsonLd.author || metaContent(root, ['article:author', 'author']),
    published:
      jsonLd.published ||
      metaContent(root, ['article:published_time', 'og:article:published_time', 'date']),
    description,
    image: metaContent(root, ['og:image', 'twitter:image']),
    siteName: metaContent(root, ['og:site_name']),
    canonical: root.querySelector('link[rel="canonical"]')?.getAttribute('href') || url,
    source: useLd ? 'json-ld' : 'dom',
    jsonLdAccessibleForFree: jsonLd.accessibleForFree,
    jsonLdBodyChars: ldChars
  };
}

/**
 * Jina Reader returns markdown, not HTML. Strip the wrapper it prepends and the
 * link/image syntax, then reuse the same paragraph hygiene.
 */
export function extractFromMarkdown(markdown, url = '') {
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  const body = markdown
    .replace(/^Title:.*$/m, '')
    .replace(/^URL Source:.*$/m, '')
    .replace(/^Published Time:.*$/m, '')
    .replace(/^Markdown Content:\s*/m, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*\-\s]{0,6}/gm, (match) => (match.includes('#') ? '' : match))
    .replace(/```[\s\S]*?```/g, '');

  const title = (titleMatch?.[1] || '').trim();
  // Reader output is chrome-heavy, so it gets the strict filter.
  const paragraphs = cleanParagraphs(body.split(/\n{2,}/), { strict: true }).filter(
    // The headline is repeated two or three times around the nav; keep none of
    // those copies, the title field already holds it.
    (text) => !title || text.toLowerCase() !== title.toLowerCase()
  );

  return {
    title,
    paragraphs,
    text: paragraphs.join('\n\n'),
    chars: paragraphs.join(' ').length,
    author: '',
    published: (markdown.match(/^Published Time:\s*(.+)$/m)?.[1] || '').trim(),
    description: '',
    image: '',
    siteName: '',
    canonical: url,
    source: 'reader',
    jsonLdAccessibleForFree: null,
    jsonLdBodyChars: 0,
    prose: proseRatio(paragraphs)
  };
}

export { cleanParagraphs, paragraphsFromBlob, isChromeLine };
