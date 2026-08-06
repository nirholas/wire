#!/usr/bin/env node
import config from '../src/config.js';
import { resolve, urlFrom } from '../src/index.js';
import { providerChain } from '../src/llm.js';
import { jarDomains } from '../src/cookies.js';
import { RESOLVERS } from '../src/resolvers/index.js';
import { safeFetch } from '../src/fetch.js';

/* ANSI, disabled when piped so the JSON output stays clean. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s)
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const positional = args.filter((a) => !a.startsWith('-'));
const flagValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

function usage() {
  console.log(`
${c.bold('wire')} - resolve a news link to the trade

${c.bold('Usage')}
  wire <url>                 resolve a link and print the read
  wire <url> --json          machine-readable output
  wire <url> --text          the resolved article text only
  wire <url> --no-summary    skip the LLM read, just resolve the text
  wire --doctor              check every lane and model
  wire --help

${c.bold('Options')}
  --budget=<ms>              race budget (default ${config.budgetMs})
  --only=<lanes>             comma-separated lanes to run
  --fresh                    bypass the cache
  --quiet                    no progress output

${c.bold('Lanes')}
  ${RESOLVERS.map((r) => r.name).join(', ')}
`);
}

function printResult(result) {
  const s = result.summary;

  console.log('');
  const route = [];
  if (result.outlet) route.push(c.bold(result.outlet));
  if (result.gated) route.push(c.yellow(`${result.access?.kind || 'gated'} wall`));
  route.push(c.green(`via ${result.route}`));
  route.push(c.dim(`${(result.elapsedMs / 1000).toFixed(2)}s`));
  console.log(route.join(c.dim(' · ')));

  if (result.post) {
    console.log('');
    console.log(c.cyan(result.post.author));
    console.log(c.dim(result.post.text.split('\n').join('\n')));
  }

  if (!s) {
    console.log('');
    console.log(c.bold(result.title || '(no title)'));
    if (result.text) {
      console.log('');
      console.log(result.text.slice(0, 1200));
      if (result.text.length > 1200) console.log(c.dim(`\n… ${result.text.length - 1200} more chars`));
    }
    if (result.summaryError) {
      console.log('');
      console.log(c.red(`No read: ${result.summaryError}`));
    }
    return;
  }

  console.log('');
  console.log(c.bold(s.headline));
  if (s.what_changed) console.log(`\n${s.what_changed}`);
  if (s.why_it_matters) console.log(c.dim(`\n${s.why_it_matters}`));

  if (s.assets?.length) {
    console.log('');
    const mark = { bullish: c.green('▲'), bearish: c.red('▼'), mixed: '↔', neutral: '·' };
    console.log(
      s.assets.map((a) => `${mark[a.direction] || '·'} ${c.bold(a.symbol)} ${c.dim(a.exposure)}`).join('   ')
    );
  }

  console.log('');
  console.log(c.dim(`${s.status} · ${s.priced_in} priced in · ${s.horizon}${s.status_note ? ` · ${s.status_note}` : ''}`));

  if (s.numbers?.length) {
    console.log('');
    for (const number of s.numbers) console.log(`  • ${number}`);
  }
  if (s.counter) {
    console.log('');
    console.log(`${c.yellow('Counter:')} ${s.counter}`);
  }
  if (result.coverage?.length > 1) {
    const outlets = [...new Set(result.coverage.map((e) => e.outlet).filter(Boolean))].slice(0, 6);
    if (outlets.length > 1) {
      console.log('');
      console.log(c.dim(`Also running it: ${outlets.join(', ')}`));
    }
  }

  console.log('');
  console.log(c.dim(`source: ${result.sourceUrl}`));
  if (result.summaryMeta) {
    console.log(c.dim(`read by ${result.summaryMeta.provider}/${result.summaryMeta.model} in ${result.summaryMeta.latencyMs}ms`));
  }
}

/** Probes every dependency and says exactly what is and is not working. */
async function doctor() {
  console.log(c.bold('\nwire doctor\n'));

  const chain = providerChain();
  console.log(c.bold('Models'));
  if (!chain.length) {
    console.log(`  ${c.yellow('none configured')} - wire resolves text but cannot write the read.`);
    console.log(c.dim('  Set GROQ_API_KEY (fastest) or ANTHROPIC_API_KEY (best) in .env'));
  }
  for (const provider of chain) {
    process.stdout.write(`  ${provider.name.padEnd(14)} ${c.dim(provider.model.padEnd(34))} `);
    const started = Date.now();
    try {
      await provider.complete({
        system: 'Reply with JSON.',
        user: 'Return {"ok":true}',
        maxTokens: 20,
        temperature: 0,
        timeoutMs: 12_000
      });
      console.log(c.green(`ok ${Date.now() - started}ms`));
    } catch (err) {
      console.log(c.red(`fail`), c.dim(err.message.slice(0, 90)));
    }
  }

  console.log(c.bold('\nData sources'));
  const probes = [
    ['tweet syndication', 'https://cdn.syndication.twimg.com/tweet-result?id=20&lang=en&token=x'],
    ['jina reader', 'https://r.jina.ai/https://example.com'],
    ['google news', 'https://news.google.com/rss/search?q=test&hl=en-US&gl=US&ceid=US:en'],
    ['wayback cdx', 'https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=1'],
    ['archive.today', 'https://archive.ph/timemap/https://example.com'],
    ['sec edgar', 'https://efts.sec.gov/LATEST/search-index?q=%22test%22'],
    ['gdelt', 'https://api.gdeltproject.org/api/v2/doc/doc?query=test&mode=artlist&format=json&maxrecords=1']
  ];
  for (const [name, url] of probes) {
    process.stdout.write(`  ${name.padEnd(20)} `);
    const started = Date.now();
    try {
      await safeFetch(url, { timeoutMs: 12_000, browserIdentity: true, maxBytes: 256 * 1024 });
      console.log(c.green(`ok ${Date.now() - started}ms`));
    } catch (err) {
      console.log(c.yellow('unreachable'), c.dim(err.message.slice(0, 70)));
    }
  }

  console.log(c.bold('\nSubscriptions'));
  const domains = jarDomains();
  if (domains.length) {
    console.log(`  ${c.green(`${domains.length} loaded`)}: ${domains.join(', ')}`);
  } else {
    console.log(`  ${c.dim('none')} - export cookies.txt to ${config.cookieJarPath} to read outlets you pay for`);
  }

  console.log(c.bold('\nTelegram'));
  console.log(
    config.telegram.token
      ? `  ${c.green('configured')} (${config.telegram.mode} mode)`
      : `  ${c.dim('disabled')} - set TELEGRAM_BOT_TOKEN`
  );

  console.log(c.bold('\nBudgets'));
  console.log(`  race ${config.budgetMs}ms · read ${config.llmBudgetMs}ms · per lane ${config.resolverTimeoutMs}ms`);
  console.log('');
}

async function main() {
  if (flags.has('--help') || flags.has('-h') || (!positional.length && !flags.has('--doctor'))) {
    usage();
    process.exit(positional.length ? 0 : 1);
  }

  if (flags.has('--doctor')) {
    await doctor();
    return;
  }

  const input = positional.join(' ');
  const url = urlFrom(input);
  if (!url) {
    console.error(c.red('No URL found in the input.'));
    process.exit(1);
  }

  const quiet = flags.has('--quiet') || flags.has('--json');
  const only = flagValue('--only', null);

  const result = await resolve(url, {
    budgetMs: Number(flagValue('--budget', config.budgetMs)),
    withSummary: !flags.has('--no-summary') && !flags.has('--text'),
    only: only ? only.split(',').map((s) => s.trim()) : null,
    fresh: flags.has('--fresh'),
    onUpdate: quiet
      ? () => {}
      : (update) => {
          const at = c.dim(`${String(update.elapsedMs).padStart(5)}ms`);
          if (update.stage === 'text') {
            process.stderr.write(`${at}  ${c.green(update.lane.padEnd(13))}${update.candidate.chars} chars\n`);
          } else if (update.stage === 'summary') {
            process.stderr.write(`${at}  ${c.cyan('read'.padEnd(13))}${update.provider}\n`);
          } else if (update.stage === 'target' && update.expectGated) {
            process.stderr.write(`${at}  ${c.yellow('gated'.padEnd(13))}${update.outlet.name || update.outlet.host}\n`);
          }
        }
  });

  // Late lanes may still improve the answer; the CLI can afford to wait for them.
  const final = result.settled ? await result.settled.catch(() => result) : result;

  if (flags.has('--json')) {
    const { settled, ...body } = final;
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (flags.has('--text')) {
    console.log(final.text || '');
    return;
  }
  printResult(final);
}

main().catch((err) => {
  console.error(c.red(`\n${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
