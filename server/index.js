import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import config from '../src/config.js';
import { resolve, urlFrom } from '../src/index.js';
import { getResolution, recentResolutions, sweepCache } from '../src/cache.js';
import { llmConfigured, providerChain } from '../src/llm.js';
import { jarDomains } from '../src/cookies.js';
import { RESOLVERS } from '../src/resolvers/index.js';
import { handleTelegramUpdate, startPolling, stopPolling, registerWebhook } from '../telegram/bot.js';

const WEB_DIR = join(config.root, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'object' && !Buffer.isBuffer(body)
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
}

/**
 * The API token is optional so `npm start` on a laptop just works, but the
 * moment one is set every non-static route requires it. The Telegram webhook
 * authenticates separately with its own secret.
 */
function authorized(req) {
  if (!config.server.apiToken) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = new URL(req.url, 'http://localhost').searchParams.get('token');
  return bearer === config.server.apiToken || query === config.server.apiToken;
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = join(WEB_DIR, normalize(relative));
  // normalize() plus the prefix check keeps ../ traversal out of the filesystem.
  if (!target.startsWith(WEB_DIR)) return send(res, 403, 'Forbidden');

  try {
    const body = await readFile(target);
    return send(res, 200, body, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      'cache-control': 'public, max-age=60'
    });
  } catch {
    return null;
  }
}

/**
 * Server-sent events. The whole point of the product is that the answer arrives
 * in pieces, so the transport has to stream. A plain JSON endpoint is available
 * too for callers that only want the final result.
 */
function startStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  // Proxies drop idle connections; a comment frame every 15s keeps it open.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  keepAlive.unref?.();

  return {
    send(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
  };
}

async function handleResolveStream(req, res, params) {
  const input = params.get('url') || params.get('q') || '';
  const target = urlFrom(input);
  if (!target) return send(res, 400, { error: 'Pass ?url= with a link to resolve.' });

  const stream = startStream(res);
  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
    stream.close();
  });

  try {
    const result = await resolve(target, {
      budgetMs: Number(params.get('budget')) || config.budgetMs,
      withSummary: params.get('summary') !== '0',
      fresh: params.get('fresh') === '1',
      signal: controller.signal,
      onUpdate: (update) => stream.send(update.stage, update)
    });

    // Late lanes may still upgrade the answer after the fast path returned.
    if (result.settled) {
      await result.settled;
    }
  } catch (err) {
    stream.send('error', { error: err.message });
  } finally {
    stream.send('end', {});
    stream.close();
  }
}

async function handleResolveJson(req, res, params) {
  const target = urlFrom(params.get('url') || params.get('q') || '');
  if (!target) return send(res, 400, { error: 'Pass ?url= with a link to resolve.' });

  try {
    const result = await resolve(target, {
      budgetMs: Number(params.get('budget')) || config.budgetMs,
      withSummary: params.get('summary') !== '0',
      fresh: params.get('fresh') === '1'
    });
    const { settled, ...body } = result;
    return send(res, 200, body);
  } catch (err) {
    return send(res, err.code === 'NO_URL' ? 400 : 502, { error: err.message });
  }
}

function handleHealth(res) {
  return send(res, 200, {
    ok: true,
    version: '0.1.0',
    lanes: RESOLVERS.map((resolver) => resolver.name),
    llm: {
      configured: llmConfigured(),
      chain: providerChain().map((provider) => `${provider.name}:${provider.model}`)
    },
    subscriptions: jarDomains(),
    telegram: { enabled: Boolean(config.telegram.token), mode: config.telegram.mode },
    budgets: {
      raceMs: config.budgetMs,
      llmMs: config.llmBudgetMs,
      resolverMs: config.resolverTimeoutMs
    }
  });
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
  }

  // Telegram authenticates with its own header secret, not the API token.
  if (pathname === '/webhook/telegram' && req.method === 'POST') {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (config.telegram.webhookSecret && secret !== config.telegram.webhookSecret) {
      return send(res, 401, { error: 'bad secret' });
    }
    try {
      const update = JSON.parse(await readBody(req));
      // Answer immediately; Telegram retries anything it waits on.
      send(res, 200, { ok: true });
      handleTelegramUpdate(update).catch(() => {});
    } catch {
      if (!res.writableEnded) send(res, 400, { error: 'bad update' });
    }
    return undefined;
  }

  if (pathname === '/healthz' || pathname === '/api/health') return handleHealth(res);

  if (pathname.startsWith('/api/') || pathname.startsWith('/r/')) {
    if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
  }

  if (pathname === '/api/resolve/stream') return handleResolveStream(req, res, searchParams);
  if (pathname === '/api/resolve') return handleResolveJson(req, res, searchParams);

  if (pathname === '/api/recent') {
    return send(res, 200, { items: recentResolutions(Number(searchParams.get('limit')) || 25) });
  }

  // Permalink: a resolution anyone can reopen later, by id.
  if (pathname.startsWith('/r/')) {
    const id = pathname.slice(3).replace(/[^a-f0-9]/g, '');
    const stored = getResolution(id);
    if (!stored) return send(res, 404, { error: 'Unknown resolution' });
    if (req.headers.accept?.includes('application/json')) return send(res, 200, stored);
    const page = await serveStatic(req, res, '/index.html');
    return page ?? send(res, 404, 'Not found');
  }

  if (req.method === 'GET') {
    const served = await serveStatic(req, res, pathname);
    if (served !== null) return served;
  }

  return send(res, 404, { error: 'Not found' });
});

const sweeper = setInterval(sweepCache, 10 * 60 * 1000);
sweeper.unref?.();

server.listen(config.server.port, () => {
  const chain = providerChain();
  console.log(`wire listening on http://localhost:${config.server.port}`);
  console.log(`  lanes    : ${RESOLVERS.map((r) => r.name).join(', ')}`);
  console.log(`  llm      : ${chain.length ? chain.map((p) => p.name).join(' -> ') : 'none (text only, no summaries)'}`);
  const domains = jarDomains();
  console.log(`  sessions : ${domains.length ? domains.join(', ') : 'none (set WIRE_COOKIE_JAR to read your subscriptions)'}`);

  if (config.telegram.token) {
    if (config.telegram.mode === 'webhook') {
      registerWebhook().then(
        (ok) => console.log(`  telegram : webhook ${ok ? 'registered' : 'FAILED to register'}`),
        (err) => console.log(`  telegram : webhook error ${err.message}`)
      );
    } else {
      startPolling();
      console.log('  telegram : long polling (no public URL needed)');
    }
  } else {
    console.log('  telegram : disabled (no TELEGRAM_BOT_TOKEN)');
  }
});

/**
 * Graceful shutdown.
 *
 * Every host sends SIGTERM before it replaces or stops a machine, and gives you
 * a short grace period. Without this the process is hard-killed mid-resolution:
 * a Telegram message is left frozen on "resolving…" forever, and the long-poll
 * connection is dropped in a way that makes Telegram redeliver the update to the
 * next instance, which then answers a question the user already saw answered.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nwire: ${signal} received, draining`);

  stopPolling();
  server.close();

  // Give in-flight resolutions a moment to finish and post their final edit.
  const deadline = setTimeout(() => {
    console.log('wire: drain timed out, exiting');
    process.exit(0);
  }, 8000);
  deadline.unref?.();

  server.closeIdleConnections?.();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  clearTimeout(deadline);
  console.log('wire: stopped');
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal).catch(() => process.exit(1));
  });
}

// A crash in a background lane must not take the whole bot down with it.
process.on('unhandledRejection', (reason) => {
  console.error('wire: unhandled rejection', reason instanceof Error ? reason.message : reason);
});

export { server };
