/**
 * Free outlets that publish full text in public and index fast.
 *
 * This registry is the sibling lane's ammunition. When a gated outlet breaks a
 * story, some subset of these will have their own writeup within minutes, and
 * unlike the gated original we can read every word of it.
 *
 * `weight` is editorial trust used for tie-breaking, not a quality ranking:
 * wires and primary-source distributors score highest because they are closest
 * to the underlying fact.
 */

export const FEEDS = [
  // Wires and primary-source distributors.
  { key: 'prnewswire', name: 'PR Newswire', url: 'https://www.prnewswire.com/rss/news-releases-list.rss', weight: 1.0, tags: ['wire'] },
  { key: 'businesswire', name: 'Business Wire', url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpRWQ==', weight: 1.0, tags: ['wire'] },
  { key: 'globenewswire', name: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/subjectcode/22-Cryptocurrency/feedTitle/GlobeNewswire%20-%20Cryptocurrency', weight: 1.0, tags: ['wire'] },

  // Crypto-native, open, and fast.
  { key: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', weight: 0.95, tags: ['crypto'] },
  { key: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', weight: 0.85, tags: ['crypto'] },
  { key: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', weight: 0.8, tags: ['crypto'] },
  { key: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', weight: 0.9, tags: ['crypto'] },
  { key: 'blockworks', name: 'Blockworks', url: 'https://blockworks.co/feed', weight: 0.9, tags: ['crypto'] },
  { key: 'dlnews', name: 'DL News', url: 'https://www.dlnews.com/arc/outboundfeeds/rss/', weight: 0.85, tags: ['crypto'] },
  { key: 'bitcoinmagazine', name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', weight: 0.7, tags: ['crypto'] },
  { key: 'protos', name: 'Protos', url: 'https://protos.com/feed/', weight: 0.7, tags: ['crypto'] },
  { key: 'cryptoslate', name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', weight: 0.65, tags: ['crypto'] },
  { key: 'thedefiant', name: 'The Defiant', url: 'https://thedefiant.io/api/feed', weight: 0.75, tags: ['crypto'] },

  // General finance and macro, open tiers.
  { key: 'cnbc-markets', name: 'CNBC Markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', weight: 0.85, tags: ['macro'] },
  { key: 'cnbc-crypto', name: 'CNBC Crypto', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', weight: 0.8, tags: ['crypto', 'macro'] },
  { key: 'apnews', name: 'AP Business', url: 'https://rsshub.app/apnews/topics/business', weight: 0.9, tags: ['wire', 'macro'] },
  { key: 'yahoo-finance', name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', weight: 0.7, tags: ['macro'] },
  { key: 'marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', weight: 0.75, tags: ['macro'] },
  { key: 'investing', name: 'Investing.com', url: 'https://www.investing.com/rss/news.rss', weight: 0.6, tags: ['macro'] }
];

/** Feeds worth polling for a given story, cheapest-relevant first. */
export function feedsFor({ tags = ['crypto', 'macro', 'wire'], limit = 10 } = {}) {
  return FEEDS.filter((feed) => feed.tags.some((tag) => tags.includes(tag)))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/**
 * Exchange and regulator announcement endpoints. These are primary sources: the
 * listing, the halt, the enforcement action itself rather than coverage of it.
 */
export const PRIMARY_SOURCES = [
  {
    key: 'binance',
    name: 'Binance Announcements',
    kind: 'json',
    url: 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20',
    pick: (data) =>
      (data?.data?.catalogs || []).flatMap((catalog) =>
        (catalog.articles || []).map((article) => ({
          title: article.title,
          link: `https://www.binance.com/en/support/announcement/${article.code}`,
          published: article.releaseDate || 0
        }))
      )
  },
  {
    key: 'coinbase',
    name: 'Coinbase Blog',
    kind: 'rss',
    url: 'https://blog.coinbase.com/feed'
  },
  {
    key: 'sec-press',
    name: 'SEC Press Releases',
    kind: 'rss',
    url: 'https://www.sec.gov/news/pressreleases.rss'
  },
  {
    key: 'sec-litigation',
    name: 'SEC Litigation',
    kind: 'rss',
    url: 'https://www.sec.gov/rss/litigation/litreleases.xml'
  },
  {
    key: 'fed-press',
    name: 'Federal Reserve Press',
    kind: 'rss',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml'
  },
  {
    key: 'cftc',
    name: 'CFTC Press',
    kind: 'rss',
    url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml'
  },
  {
    key: 'treasury',
    name: 'US Treasury Press',
    kind: 'rss',
    url: 'https://home.treasury.gov/system/files/126/ofac.xml'
  }
];
