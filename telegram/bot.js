import config from '../src/config.js';
import { resolve, urlFrom } from '../src/index.js';
import { llmConfigured, providerChain } from '../src/llm.js';
import { jarDomains } from '../src/cookies.js';
import { RESOLVERS } from '../src/resolvers/index.js';
import { renderMessage, renderHelp } from './format.js';

/**
 * The Telegram surface.
 *
 * The product decision that matters here: we post a message within a few
 * hundred milliseconds and then EDIT IT as the answer improves. Nobody watches
 * a spinner and nobody waits for a summary. You get the headline immediately and
 * it fills in while you are still reading it.
 *
 * Telegram throttles edits, so edits are coalesced: at most one API call every
 * EDIT_INTERVAL_MS, and the final state always flushes.
 */

const API = (method) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

/** Telegram tolerates roughly one edit per second per chat before it starts 429ing. */
const EDIT_INTERVAL_MS = 1100;

async function callTelegram(method, payload, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const error = new Error(`${method}: ${data.description || res.status}`);
      error.code = data.error_code;
      error.retryAfter = data.parameters?.retry_after;
      throw error;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function sendMessage(chatId, text, extra = {}) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra
  });
}

function editMessage(chatId, messageId, text, extra = {}) {
  return callTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra
  });
}

/**
 * Coalesces a stream of renders into a paced sequence of edits. Without this,
 * a fast resolution fires five edits in 800ms and Telegram rate-limits the chat.
 */
function createEditor(chatId, messageId) {
  let lastSentText = '';
  let lastSentAt = 0;
  let pendingText = null;
  let timer = null;
  let closed = false;
  let inFlight = Promise.resolve();

  const flush = () => {
    timer = null;
    if (closed || pendingText === null) return;
    const text = pendingText;
    pendingText = null;
    if (text === lastSentText) return;

    lastSentText = text;
    lastSentAt = Date.now();
    inFlight = inFlight
      .then(() => editMessage(chatId, messageId, text))
      .catch((err) => {
        // "message is not modified" is routine and not worth surfacing.
        if (!/not modified/i.test(err.message || '')) {
          process.emitWarning(`wire/telegram edit failed: ${err.message}`);
        }
      });
  };

  return {
    update(text) {
      if (closed) return;
      pendingText = text;
      const since = Date.now() - lastSentAt;
      if (since >= EDIT_INTERVAL_MS) return flush();
      if (!timer) {
        timer = setTimeout(flush, EDIT_INTERVAL_MS - since);
        timer.unref?.();
      }
      return undefined;
    },
    /** Sends the final state immediately, ignoring the pacing window. */
    async finish(text) {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingText = text;
      flush();
      closed = true;
      await inFlight;
    }
  };
}

function allowed(userId) {
  if (!config.telegram.allowedUsers.length) return true;
  return config.telegram.allowedUsers.includes(String(userId));
}

async function handleCommand(chatId, command) {
  if (command === '/start' || command === '/help') {
    return sendMessage(chatId, renderHelp());
  }

  if (command === '/health') {
    const chain = providerChain();
    const domains = jarDomains();
    const lines = [
      '<b>wire status</b>',
      '',
      `lanes: <code>${RESOLVERS.map((r) => r.name).join(', ')}</code>`,
      `models: <code>${chain.length ? chain.map((p) => `${p.name}:${p.model}`).join('\n        ') : 'none'}</code>`,
      `read: ${llmConfigured() ? 'enabled' : '<b>disabled</b> (no LLM key; text only)'}`,
      `subscriptions: <code>${domains.length ? domains.join(', ') : 'none loaded'}</code>`,
      `budget: <code>${config.budgetMs}ms race, ${config.llmBudgetMs}ms read</code>`
    ];
    return sendMessage(chatId, lines.join('\n'));
  }

  return sendMessage(chatId, 'Unknown command. Try /help.');
}

/**
 * Resolves a link and keeps one message updated with the best current answer.
 */
export async function resolveIntoChat(chatId, input, { replyTo } = {}) {
  const state = { stage: 'start', target: urlFrom(input) };

  const placeholder = await sendMessage(chatId, renderMessage(state), {
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
  });
  const editor = createEditor(chatId, placeholder.message_id);

  const apply = (update) => {
    state.stage = update.stage;
    state.elapsedMs = update.elapsedMs;

    switch (update.stage) {
      case 'post':
        state.post = update.post;
        break;
      case 'target':
        state.target = update.target;
        state.outlet = update.outlet;
        state.expectGated = update.expectGated;
        state.haveSubscription = update.haveSubscription;
        break;
      case 'text':
        state.candidate = update.candidate;
        break;
      case 'summary':
        state.summary = update.summary;
        state.provider = update.provider;
        break;
      case 'summary_failed':
        state.summaryError = update.error;
        break;
      case 'cached':
      case 'done':
        state.result = update.result;
        state.summary = update.result.summary || state.summary;
        state.summaryError = update.result.summaryError || state.summaryError;
        state.provider = update.result.summaryMeta?.provider || state.provider;
        break;
      default:
        break;
    }
  };

  try {
    const result = await resolve(input, {
      onUpdate: (update) => {
        apply(update);
        editor.update(renderMessage(state));
      }
    });

    apply({ stage: 'done', result, elapsedMs: result.elapsedMs });
    await editor.finish(renderMessage(state));

    // A late lane can still win after the fast path returned. Keep editing.
    if (result.settled) {
      const upgraded = await result.settled;
      if (upgraded && upgraded !== result) {
        apply({ stage: 'done', result: upgraded, elapsedMs: upgraded.elapsedMs });
        await editMessage(chatId, placeholder.message_id, renderMessage(state)).catch(() => {});
      }
    }
    return result;
  } catch (err) {
    await editor
      .finish(`<b>Could not resolve that.</b>\n\n<code>${err.message.slice(0, 300)}</code>`)
      .catch(() => {});
    return null;
  }
}

export async function handleTelegramUpdate(update) {
  const message = update?.message || update?.channel_post || update?.edited_message;
  if (!message) return;

  const chatId = message.chat?.id;
  const userId = message.from?.id;
  if (!chatId) return;

  if (userId && !allowed(userId)) {
    await sendMessage(chatId, 'Not authorized. Ask the owner to add your id to TELEGRAM_ALLOWED_USERS.').catch(
      () => {}
    );
    return;
  }

  const text = message.text || message.caption || '';
  if (!text) return;

  const trimmed = text.trim();
  if (trimmed.startsWith('/')) {
    const command = trimmed.split(/[\s@]/)[0].toLowerCase();
    await handleCommand(chatId, command).catch(() => {});
    return;
  }

  const link = urlFrom(trimmed);
  if (!link) {
    // In a group, silence is correct for chatter that is not a link.
    if (message.chat.type === 'private') {
      await sendMessage(chatId, 'Send me a link and I will resolve it. /help for what that means.').catch(
        () => {}
      );
    }
    return;
  }

  await resolveIntoChat(chatId, trimmed, { replyTo: message.message_id }).catch(() => {});
}

/* -------------------------------------------------------------------------
 * Long polling. The default, because it needs no public URL, no domain, and no
 * TLS certificate, which is the difference between "works for me and four
 * friends tonight" and "works after I set up infrastructure".
 * ---------------------------------------------------------------------- */

let polling = false;

export async function startPolling() {
  if (polling || !config.telegram.token) return;
  polling = true;

  // Drop any webhook first: Telegram refuses getUpdates while one is registered.
  await callTelegram('deleteWebhook', { drop_pending_updates: false }).catch(() => {});

  let offset = 0;
  let backoffMs = 1000;

  while (polling) {
    try {
      const updates = await callTelegram(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message', 'channel_post'] },
        { timeoutMs: 40_000 }
      );
      backoffMs = 1000;
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        handleTelegramUpdate(update).catch(() => {});
      }
    } catch (err) {
      if (!polling) break;
      process.emitWarning(`wire/telegram poll: ${err.message}`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}

export function stopPolling() {
  polling = false;
}

export async function registerWebhook() {
  if (!config.telegram.token || !config.telegram.webhookBase) return false;
  const url = `${config.telegram.webhookBase.replace(/\/$/, '')}/webhook/telegram`;
  await callTelegram('setWebhook', {
    url,
    secret_token: config.telegram.webhookSecret || undefined,
    allowed_updates: ['message', 'channel_post'],
    max_connections: 40
  });
  return true;
}

/** Running this file directly starts a standalone bot with no HTTP server. */
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!config.telegram.token) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather and put it in .env');
    process.exit(1);
  }
  const me = await callTelegram('getMe', {});
  console.log(`wire bot running as @${me.username} (long polling)`);
  console.log(`  read: ${llmConfigured() ? providerChain()[0].name : 'disabled, no LLM key'}`);
  startPolling();
}

export { sendMessage, editMessage, callTelegram };
