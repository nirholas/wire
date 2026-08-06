import config from './config.js';
import { assertPublicUrl, BlockedAddressError } from './ssrf.js';

export { BlockedAddressError };

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class TooLargeError extends Error {
  constructor(limit) {
    super(`Response exceeded ${limit} bytes`);
    this.name = 'TooLargeError';
  }
}

/**
 * Reads a response body with a hard byte ceiling, aborting the stream the
 * moment it is exceeded. A plain `res.text()` on a hostile or merely enormous
 * URL will happily buffer the whole thing into memory first.
 */
async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new TooLargeError(maxBytes);

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      await res.body.cancel?.().catch(() => {});
      throw new TooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The single outbound door. Every request in wire goes through here so that the
 * SSRF check, the timeout, the byte cap, and redirect re-validation are
 * impossible to forget. Redirects are followed manually because each new hop is
 * a fresh chance to land on 169.254.169.254.
 */
export async function safeFetch(input, options = {}) {
  const {
    timeoutMs = config.resolverTimeoutMs,
    maxBytes = DEFAULT_MAX_BYTES,
    headers = {},
    method = 'GET',
    body,
    signal: externalSignal,
    browserIdentity = false,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    parse = 'text'
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onExternalAbort = () => controller.abort(new Error('aborted'));
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    let current = String(input);
    let redirects = 0;

    while (true) {
      const { url } = await assertPublicUrl(current);

      const res = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': browserIdentity ? config.browserUserAgent : config.userAgent,
          accept,
          'accept-language': 'en-US,en;q=0.9',
          ...headers
        }
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (++redirects > MAX_REDIRECTS) throw new HttpError(res.status, current, 'too many redirects');
        await res.body?.cancel?.().catch(() => {});
        current = new URL(res.headers.get('location'), url).toString();
        continue;
      }

      if (!res.ok) {
        const preview = await readCapped(res, 4096).catch(() => '');
        throw new HttpError(res.status, current, preview);
      }

      const text = await readCapped(res, maxBytes);
      const finalUrl = current;

      if (parse === 'json') {
        try {
          return { data: JSON.parse(text), url: finalUrl, headers: res.headers, status: res.status };
        } catch (err) {
          throw new Error(`Bad JSON from ${finalUrl}: ${err.message}`);
        }
      }
      return { text, url: finalUrl, headers: res.headers, status: res.status };
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Convenience wrapper for the many JSON APIs wire talks to. */
export async function fetchJson(input, options = {}) {
  const { data } = await safeFetch(input, {
    ...options,
    parse: 'json',
    accept: 'application/json,text/plain;q=0.9,*/*;q=0.8'
  });
  return data;
}

/** Convenience wrapper for HTML and XML. */
export async function fetchText(input, options = {}) {
  const { text, url } = await safeFetch(input, options);
  return { text, url };
}
