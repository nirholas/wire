import { XMLParser } from 'fast-xml-parser';

/**
 * RSS and Atom reading.
 *
 * This uses a real XML parser rather than the HTML parser the rest of the
 * extraction pipeline uses, and the distinction is load-bearing: `<link>` is a
 * void element in HTML, so an HTML parser closes it immediately and every feed
 * link silently comes back empty. Feeds are XML and have to be parsed as XML.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Namespaced tags (dc:date, content:encoded) lose their prefix so we can read
  // them without knowing which namespace a given publisher chose.
  removeNSPrefix: true,
  cdataPropName: '__cdata',
  processEntities: true
});

/** fast-xml-parser returns a bare value, an object, or an array depending on the doc. */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Unwraps CDATA, attribute-bearing nodes, and plain strings to text. */
function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    if (node.__cdata !== undefined) return textOf(node.__cdata);
    if (node['#text'] !== undefined) return String(node['#text']);
  }
  return '';
}

export function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Atom puts the URL in an attribute and can carry several links per entry;
 * the one we want is rel="alternate" (or the first one with no rel at all).
 */
function linkFrom(node) {
  const direct = textOf(node.link);
  if (direct && /^https?:/i.test(direct)) return direct;

  for (const candidate of asArray(node.link)) {
    if (typeof candidate !== 'object') continue;
    const rel = candidate['@rel'];
    const href = candidate['@href'];
    if (!href) continue;
    if (!rel || rel === 'alternate') return href;
  }

  // Some feeds only carry a permalink guid.
  const guid = textOf(node.guid) || textOf(node.id);
  return /^https?:/i.test(guid) ? guid : '';
}

/**
 * @returns {Array<{title:string,link:string,published:number,summary:string,sourceName:string,sourceUrl:string}>}
 */
export function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }

  const channel = doc?.rss?.channel || doc?.RDF?.channel || doc?.feed || {};
  const nodes = [
    ...asArray(channel.item),
    ...asArray(doc?.rss?.channel?.item),
    ...asArray(doc?.RDF?.item),
    ...asArray(channel.entry),
    ...asArray(doc?.feed?.entry)
  ];

  const items = [];
  const seen = new Set();

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;

    const title = stripHtml(textOf(node.title));
    const link = linkFrom(node);
    if (!title || !/^https?:/i.test(link)) continue;
    if (seen.has(link)) continue;
    seen.add(link);

    const dateText =
      textOf(node.pubDate) || textOf(node.published) || textOf(node.updated) || textOf(node.date);

    const source = node.source;
    const sourceName = source ? stripHtml(textOf(source)) : '';
    const sourceUrl = (typeof source === 'object' ? source['@url'] : '') || '';

    items.push({
      title,
      link,
      published: Date.parse(dateText) || 0,
      summary: stripHtml(
        textOf(node.description) || textOf(node.summary) || textOf(node.encoded) || textOf(node.content)
      ).slice(0, 600),
      sourceName,
      sourceUrl
    });
  }

  return items;
}

export { textOf, asArray };
