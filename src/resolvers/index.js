import tweetResolver from './tweet.js';
import subscriptionResolver from './subscription.js';
import directResolver from './direct.js';
import readerResolver from './reader.js';
import siblingsResolver from './siblings.js';
import primaryResolver from './primary.js';
import waybackResolver from './wayback.js';
import archiveResolver from './archive.js';

/**
 * Every lane, in rough order of how often it produces the winning answer.
 * `tier` drives scheduling, not ranking: tier 0 and 1 start immediately, higher
 * tiers start immediately too but the race will not hold the budget open for
 * them if a tier-1 lane has already produced something good.
 */
export const RESOLVERS = [
  tweetResolver,
  subscriptionResolver,
  directResolver,
  readerResolver,
  siblingsResolver,
  primaryResolver,
  waybackResolver,
  archiveResolver
];

export const byName = Object.fromEntries(RESOLVERS.map((resolver) => [resolver.name, resolver]));

export function resolversFor(url, { only = null, exclude = [] } = {}) {
  return RESOLVERS.filter((resolver) => {
    if (only && !only.includes(resolver.name)) return false;
    if (exclude.includes(resolver.name)) return false;
    try {
      return resolver.appliesTo(url);
    } catch {
      return false;
    }
  });
}

export {
  tweetResolver,
  subscriptionResolver,
  directResolver,
  readerResolver,
  siblingsResolver,
  primaryResolver,
  waybackResolver,
  archiveResolver
};
