import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader. We do this ourselves rather than pulling dotenv because
 * it is fifteen lines and one fewer dependency on the critical path.
 * Real environment variables always win over the file.
 */
function loadEnvFile() {
  for (const name of ['.env.local', '.env']) {
    let raw;
    try {
      raw = readFileSync(resolve(ROOT, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const num = (key, fallback) => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const str = (key, fallback = '') => (process.env[key] || '').trim() || fallback;

const list = (key) =>
  str(key)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const contact = str('WIRE_CONTACT_EMAIL');

/** Where writable state lives. A mounted volume in production, the repo locally. */
const dataDir = () => resolve(ROOT, str('WIRE_DATA_DIR', resolve(ROOT, 'data')));

export const config = {
  root: ROOT,

  budgetMs: num('WIRE_BUDGET_MS', 2500),
  llmBudgetMs: num('WIRE_LLM_BUDGET_MS', 6000),
  resolverTimeoutMs: num('WIRE_RESOLVER_TIMEOUT_MS', 4000),

  /**
   * The SEC blocks requests without a contact string, and several archives rate
   * limit anonymous traffic harder. Identifying honestly is both the polite and
   * the more reliable option.
   */
  userAgent:
    str('WIRE_USER_AGENT') ||
    `wire/0.1 (+https://github.com/nirholas/wire${contact ? `; ${contact}` : ''})`,
  contactEmail: contact,

  /** A plain browser UA, used only where a server rejects unknown clients outright. */
  browserUserAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',

  llm: {
    prefer: str('WIRE_LLM_PREFER', 'speed'),
    anthropicKey: str('ANTHROPIC_API_KEY'),
    groqKey: str('GROQ_API_KEY'),
    cerebrasKey: str('CEREBRAS_API_KEY'),
    nvidiaKey: str('NVIDIA_API_KEY'),
    geminiKey: str('GEMINI_API_KEY'),
    openrouterKeys: [str('OPENROUTER_API_KEY'), ...list('OPENROUTER_FALLBACK_KEYS')].filter(Boolean)
  },

  telegram: {
    token: str('TELEGRAM_BOT_TOKEN'),
    allowedUsers: list('TELEGRAM_ALLOWED_USERS'),
    mode: str('TELEGRAM_MODE', 'poll'),
    webhookBase: str('TELEGRAM_WEBHOOK_BASE'),
    webhookSecret: str('TELEGRAM_WEBHOOK_SECRET')
  },

  server: {
    port: num('PORT', 8787),
    apiToken: str('WIRE_API_TOKEN')
  },

  /**
   * Writable state lives here. On a host with a mounted volume this points at
   * the mount (/data on Fly), so the cache and the resolution history survive a
   * deploy. Left unset it stays inside the repo, which is what you want locally.
   */
  dataDir: dataDir(),
  /**
   * Always absolute. A relative path here resolves against the process CWD,
   * which in a container is /app rather than the mounted volume, so a jar
   * configured as "./data/cookies/jar.txt" would silently sit outside
   * persistent storage and vanish on the next deploy.
   */
  cookieJarPath: resolve(dataDir(), str('WIRE_COOKIE_JAR') || 'cookies/jar.txt'),
  dbPath: resolve(dataDir(), 'wire.db')
};

export default config;
