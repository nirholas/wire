import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * wire resolves URLs that arrive from Telegram messages and an X feed, which is
 * to say from strangers. Without this guard the server is an open proxy into
 * whatever private network it happens to run on: cloud metadata endpoints,
 * localhost admin panels, the LAN. Every outbound fetch goes through here.
 */

export class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedAddressError';
    this.blocked = true;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hosts that are never a legitimate news source and are classic SSRF pivots. */
const DENIED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data'
]);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata at 169.254.169.254
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved
].map(([base, bits]) => ({
  base: ipv4ToInt(base),
  mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
}));

function isPrivateV4(ip) {
  const value = ipv4ToInt(ip);
  return V4_BLOCKS.some((block) => (value & block.mask) === (block.base & block.mask));
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) smuggles a private v4 address through v6.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // multicast
  return false;
}

export function isPrivateAddress(ip) {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // unparseable means untrusted
}

/**
 * Validates a URL and resolves it to concrete IPs, rejecting anything that
 * points inside the network. Returns the parsed URL plus the addresses DNS gave
 * us, so a caller that wants to pin the connection can reuse them.
 */
export async function assertPublicUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new BlockedAddressError(`Not a valid URL: ${String(input).slice(0, 120)}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedAddressError(`Refusing protocol ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new BlockedAddressError('URL has no host');
  if (DENIED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new BlockedAddressError(`Refusing host ${hostname}`);
  }

  // A bare IP in the URL skips DNS entirely, so check it directly.
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) {
      throw new BlockedAddressError(`Refusing private address ${literal}`);
    }
    return { url, addresses: [literal] };
  }

  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch (err) {
    throw new BlockedAddressError(`Cannot resolve ${hostname}: ${err.code || err.message}`);
  }

  const addresses = records.map((record) => record.address);
  if (!addresses.length) throw new BlockedAddressError(`No addresses for ${hostname}`);

  const bad = addresses.find((address) => isPrivateAddress(address));
  if (bad) throw new BlockedAddressError(`${hostname} resolves to private address ${bad}`);

  return { url, addresses };
}
