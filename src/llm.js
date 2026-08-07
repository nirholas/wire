import config from './config.js';

/**
 * Provider chain, ordered for latency.
 *
 * The summary sits on the critical path of a trading decision, so the default
 * order puts the fastest hosted inference first and treats the frontier models
 * as failover. Set WIRE_LLM_PREFER=quality to invert that when you care more
 * about the read than the milliseconds.
 *
 * The budget is for the whole chain, not per attempt: if Groq is having a bad
 * minute we would rather return the extracted text with no summary than spend
 * fifteen seconds walking the chain.
 */

export class NoProviderError extends Error {
  constructor() {
    super('No LLM provider configured. Set GROQ_API_KEY (fastest) or ANTHROPIC_API_KEY.');
    this.name = 'NoProviderError';
  }
}

const jsonInstruction =
  'Respond with a single JSON object and nothing else. No prose, no code fences.';

async function postJson(url, { headers, body, signal, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Most providers speak the OpenAI chat shape; one adapter covers them all. */
function openAiCompatible({ name, endpoint, model, key, extraHeaders = {}, jsonMode = true }) {
  return {
    name,
    model,
    async complete({ system, user, maxTokens, temperature, signal, timeoutMs }) {
      const data = await postJson(endpoint, {
        signal,
        timeoutMs,
        headers: { authorization: `Bearer ${key}`, ...extraHeaders },
        body: {
          model,
          max_tokens: maxTokens,
          temperature,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        }
      });
      const text = data?.choices?.[0]?.message?.content || '';
      if (!text) throw new Error('empty completion');
      return {
        text,
        usage: {
          input: data?.usage?.prompt_tokens ?? null,
          output: data?.usage?.completion_tokens ?? null
        }
      };
    }
  };
}

/**
 * The quality lane's model, shared by the direct Anthropic provider and the
 * OpenRouter mirror of it.
 *
 * Measured cost of one read at this prompt size (~1,516 in / ~400 out):
 *   claude-opus-5     $0.0176   the default; best read
 *   claude-sonnet-5   $0.0105   ~60% of the cost, still far above any open model
 *   claude-haiku-4-5  $0.0035   cheapest Claude tier, fastest
 *
 * At 100 links a day that is $53 / $32 / $11 a month respectively.
 */
function qualityModel() {
  return config.llm.qualityModel;
}

function anthropic(key) {
  return {
    name: 'anthropic',
    model: qualityModel(),
    async complete({ system, user, maxTokens, temperature, signal, timeoutMs }) {
      const data = await postJson('https://api.anthropic.com/v1/messages', {
        signal,
        timeoutMs,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: {
          model: this.model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: 'user', content: user }]
        }
      });
      const text = (data?.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (!text) throw new Error('empty completion');
      return {
        text,
        usage: { input: data?.usage?.input_tokens ?? null, output: data?.usage?.output_tokens ?? null }
      };
    }
  };
}

function gemini(key) {
  const model = 'gemini-2.5-flash-lite';
  return {
    name: 'gemini',
    model,
    async complete({ system, user, maxTokens, temperature, signal, timeoutMs }) {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          signal,
          timeoutMs,
          headers: {},
          body: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              maxOutputTokens: maxTokens,
              temperature,
              responseMimeType: 'application/json'
            }
          }
        }
      );
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((part) => part.text || '')
        .join('');
      if (!text) throw new Error('empty completion');
      return {
        text,
        usage: {
          input: data?.usageMetadata?.promptTokenCount ?? null,
          output: data?.usageMetadata?.candidatesTokenCount ?? null
        }
      };
    }
  };
}

/** Builds the ordered chain from whatever keys are present. */
export function providerChain() {
  const { llm } = config;
  const fast = [];
  const quality = [];

  if (llm.groqKey) {
    fast.push(
      openAiCompatible({
        name: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.3-70b-versatile',
        key: llm.groqKey
      })
    );
    // Rate limits are per model, so the small model is a genuinely independent
    // rung rather than a retry of the same bucket. It is also four times faster,
    // which on a busy key makes it the better answer anyway.
    fast.push(
      openAiCompatible({
        name: 'groq-fast',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.1-8b-instant',
        key: llm.groqKey
      })
    );
  }
  if (llm.cerebrasKey) {
    fast.push(
      openAiCompatible({
        name: 'cerebras',
        endpoint: 'https://api.cerebras.ai/v1/chat/completions',
        model: 'llama-3.3-70b',
        key: llm.cerebrasKey
      })
    );
  }
  if (llm.nvidiaKey) {
    fast.push(
      openAiCompatible({
        name: 'nvidia',
        endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
        model: 'meta/llama-3.3-70b-instruct',
        key: llm.nvidiaKey,
        jsonMode: false
      })
    );
  }

  if (llm.anthropicKey) quality.push(anthropic(llm.anthropicKey));
  for (const key of llm.openrouterKeys) {
    quality.push(
      openAiCompatible({
        name: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        // OpenRouter namespaces Anthropic models and uses dots, not dashes.
        model: `anthropic/${qualityModel().replace(/-(\d)-(\d)$/, '-$1.$2')}`,
        key,
        extraHeaders: {
          'http-referer': 'https://github.com/nirholas/wire',
          'x-title': 'wire'
        }
      })
    );
  }
  if (llm.geminiKey) quality.push(gemini(llm.geminiKey));

  return config.llm.prefer === 'quality' ? [...quality, ...fast] : [...fast, ...quality];
}

export function llmConfigured() {
  return providerChain().length > 0;
}

/** Strips a code fence a model added despite being told not to. */
export function stripJsonFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/** Salvages the first balanced JSON object from a noisy completion. */
export function parseJsonLoose(text) {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to extraction */
  }
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Walks the chain until one provider answers. Every attempt shares one wall
 * clock budget so a slow chain cannot outlive the usefulness of the answer.
 */
export async function complete({
  system,
  user,
  maxTokens = 900,
  temperature = 0.2,
  json = true,
  timeoutMs = config.llmBudgetMs,
  signal
}) {
  const chain = providerChain();
  if (!chain.length) throw new NoProviderError();

  const deadline = Date.now() + timeoutMs;
  const errors = [];

  for (const provider of chain) {
    const remaining = deadline - Date.now();
    if (remaining < 700) break;

    /**
     * Cap each attempt well below the remaining budget. A provider that hangs
     * rather than failing (a dead endpoint answers nothing at all, not a 5xx)
     * would otherwise consume the entire chain's time by itself and we would
     * return nothing, having never tried the providers that were healthy.
     */
    const attemptMs = Math.max(2200, Math.min(remaining, Math.ceil(remaining * 0.55)));

    try {
      const started = Date.now();
      const result = await provider.complete({
        system: json ? `${system}\n\n${jsonInstruction}` : system,
        user,
        maxTokens,
        temperature,
        signal,
        timeoutMs: attemptMs
      });
      return {
        ...result,
        provider: provider.name,
        model: provider.model,
        latencyMs: Date.now() - started,
        attempts: errors.length + 1
      };
    } catch (err) {
      errors.push(`${provider.name}: ${err.message?.slice(0, 160)}`);
    }
  }

  const error = new Error(`All LLM providers failed. ${errors.join(' | ')}`);
  error.name = 'LlmChainError';
  error.attempts = errors;
  throw error;
}

export default { complete, providerChain, llmConfigured, parseJsonLoose, stripJsonFence };
