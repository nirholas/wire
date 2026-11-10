---
name: resolve-news-link
description: Run wire from a clone to resolve a news or X link to readable text and a short trading read, using the wire CLI, its local HTTP API or its JS library. Use when asked to read a gated or slow news link, find the underlying filing, or judge what a headline means for assets.
---

# Resolve a news link with wire

wire races eight lanes to the same information and takes the first usable answer, then keeps
improving it: `tweet`, `subscription`, `direct`, `reader`, `siblings`, `primary`, `wayback`,
`archive`. It reads public pages, public archives and your own subscription cookies. It has no
paywall circumvention rules. Do not claim it bypasses access controls.

The package is private and not on npm, so run it from a clone. Node 22.5 or newer is required
(it uses `node:sqlite`).

## Setup

```bash
git clone https://github.com/nirholas/wire.git && cd wire
npm install
cp .env.example .env
npm run doctor     # probes every model and data source
```

No key is needed to resolve article text. For the trading read set at least one LLM key in `.env`:
`GROQ_API_KEY` (fastest) or `ANTHROPIC_API_KEY`; `CEREBRAS_API_KEY`, `NVIDIA_API_KEY`,
`OPENROUTER_API_KEY` and `GEMINI_API_KEY` also work. Set `WIRE_CONTACT_EMAIL` because the SEC lane
blocks callers without one. `WIRE_BUDGET_MS` (default 2500) sets when the race stops waiting.

## CLI

```bash
node bin/wire.js <url>                 # resolve and print the read
node bin/wire.js <url> --json          # machine-readable
node bin/wire.js <url> --text          # resolved article text only
node bin/wire.js <url> --no-summary    # skip the LLM
node bin/wire.js <url> --only=siblings,primary
node bin/wire.js <url> --budget=4000 --fresh --quiet
node bin/wire.js --doctor
```

`--only` takes comma-separated lane names, `--fresh` bypasses the cache, `--quiet` hides progress.

## HTTP API

`npm start` serves on port 8787 (`PORT` overrides).

```bash
curl "localhost:8787/api/resolve?url=https://example.com/story"          # one-shot JSON
curl -N "localhost:8787/api/resolve/stream?url=https://example.com/story" # server-sent events
curl localhost:8787/api/recent
curl localhost:8787/healthz
```

Stream events arrive in order: `post`, `target`, `text` (repeats as lanes win), `summary`, `done`,
`end`. If `WIRE_API_TOKEN` is set, send `Authorization: Bearer <token>`.

## Library

```js
import { resolve } from './src/index.js';

const result = await resolve('https://www.wsj.com/articles/some-story', {
  onUpdate: (u) => console.log(u.stage, u.elapsedMs),
});
console.log(result.route, result.gated, result.summary, result.text);
await result.settled; // late lanes may still improve the result
```

## Reading the result

`result.route` is the lane that won, `result.gated` says whether the original was gated, and
`result.summary` holds `headline`, `what_changed`, `why_it_matters`, `assets` (symbol, direction,
exposure), `status`, `priced_in`, `horizon` and `counter`. Report the `counter` along with the
read, and the source URL. The read is analysis of public text, not financial advice.
