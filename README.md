# wire

Resolve a news link to the trade, in about a second.

You are watching an X tracker on padre.gg or gmgn. Something breaks. The link is to
Bloomberg and you cannot read it, and by the time you could, the candle is gone.

wire fires every route at that story simultaneously, shows you the first useful answer
in a few hundred milliseconds, and sharpens it in place while you are still reading.

```
  351ms  tweet        @zerohedge: FED SIGNALS 50BPS CUT AT SEPTEMBER MEETING
  480ms  gated        The Wall Street Journal
 1420ms  siblings     Reuters, 4.2k chars
 2890ms  read         groq

The Wall Street Journal · gated → read via independent coverage

Fed signals a 50bp cut at the September meeting

Minutes show officials are prepared to cut by half a point, double the 25bp
the market had assumed.

▲ BTC indirect   ▲ ETH indirect   ▼ DXY direct
reported · partially priced in · days

Counter: Minutes are three weeks stale and two officials dissented; the
September dot plot has not moved.
```

## The idea

A paywalled article is almost never the only account of what happened, and it is
usually not the fastest one. So wire does not try to get through the wall. It races
seven other ways to the same information and takes whichever wins:

| Lane | What it does | Typical |
|---|---|---|
| `tweet` | Reads the X post itself via the public syndication endpoint. Often the whole trade. | 250ms |
| `subscription` | Reads the article with **your own** subscription cookies. | 400ms |
| `direct` | Fetches the page and reads what the server sends, including the JSON-LD body publishers embed for Google. | 300ms |
| `reader` | Renders JavaScript-only pages through Jina Reader. | 400ms |
| `siblings` | Finds free outlets covering the same story and reads one in full. | 900ms |
| `primary` | Resolves to the underlying document: the 8-K, the SEC action, the exchange notice, the release. | 800ms |
| `wayback` | Pulls an existing Internet Archive snapshot. | 1.5s |
| `archive` | Pulls an existing archive.today snapshot. | 2s |

The first usable answer is emitted immediately. Every better answer replaces it. The
budget bounds when wire stops *waiting*, not when it stops *listening*, which is why a
Telegram message can keep improving after it has already been posted.

**What wire does not do:** it does not defeat access controls. There are no
per-publisher cookie-wipe, user-agent-spoof, or paywall-script-strip rules, and there
never will be. That is the thing DMCA §1201 targets, and it is also the slowest and most
fragile route to the information. The lanes above are faster and they keep working when
a publisher tightens their edge.

## Install

```bash
git clone <your-remote> wire && cd wire
npm install
cp .env.example .env
```

Node 22.5+ is required (wire uses the built-in `node:sqlite`).

wire runs with **zero API keys** and will resolve and return article text. Add one LLM
key to get the trading read. Groq is recommended because the summary is on the critical
path and Groq is the fastest hosted inference available:

```bash
# .env
GROQ_API_KEY=gsk_...
```

Check everything at once:

```bash
npm run doctor
```

```
Models
  groq           llama-3.3-70b-versatile     ok 161ms
Data sources
  tweet syndication    ok 203ms
  google news          ok 486ms
  wayback cdx          ok 343ms
  sec edgar            ok 386ms
```

## Use it

### CLI

```bash
npx wire https://www.wsj.com/articles/some-story
npx wire https://x.com/user/status/1234567890
npx wire <url> --json          # machine readable
npx wire <url> --text          # just the resolved article text
npx wire <url> --no-summary    # skip the LLM
npx wire <url> --only=siblings,primary
```

### Telegram

This is the surface that matters. You are already in Telegram when news breaks, and an
app switch costs more than the entire latency budget.

1. Message [@BotFather](https://t.me/botfather), `/newbot`, copy the token.
2. Put it in `.env` as `TELEGRAM_BOT_TOKEN`.
3. `npm run bot`

That is the whole setup. It uses long polling by default, so there is **no domain, no
TLS certificate, and no public URL required**. Send the bot a link, or add it to a group
and paste links there.

**Lock it down before you share the username.** The bot defaults to open access,
and anyone who finds it will spend your model quota. Send it `/whoami`, then:

```bash
TELEGRAM_ALLOWED_USERS=11111111,22222222
```

Restart, and everyone else gets refused. Your friends each send `/whoami` to get
their own id. `/health` warns in bold whenever access is still open.

The bot posts a message immediately and edits it in place three or four times as the
answer sharpens. Edits are paced to stay inside Telegram's rate limits.

For a hosted deployment with a public URL, set `TELEGRAM_MODE=webhook` and
`TELEGRAM_WEBHOOK_BASE=https://your.host`, then `npm start`.

### Web

```bash
npm start   # http://localhost:8787
```

Paste a link and watch the lanes light up. `Cmd/Ctrl+K` focuses the input.

### HTTP API

```bash
# Streaming, the same events the bot consumes
curl -N "localhost:8787/api/resolve/stream?url=https://example.com/story"

# One-shot JSON
curl "localhost:8787/api/resolve?url=https://example.com/story"

curl localhost:8787/healthz
curl localhost:8787/api/recent
```

Set `WIRE_API_TOKEN` to require `Authorization: Bearer <token>` on every API route.

SSE events, in order: `post`, `target`, `text` (repeats as lanes win), `summary`,
`done`, `end`.

### As a library

```js
import { resolve } from 'wire';

const result = await resolve('https://www.wsj.com/articles/some-story', {
  onUpdate: (u) => console.log(u.stage, u.elapsedMs)
});

console.log(result.route);        // which lane won
console.log(result.gated);        // was the original gated
console.log(result.summary);      // the trading read
console.log(result.text);         // the resolved article
await result.settled;             // late lanes may still improve it
```

## Reading outlets you pay for

If you subscribe to WSJ, Bloomberg, or The Information, wire can read those articles
with your own session. This is the only lane that reliably returns the full text of a
hard-gated story, and it is simply what your browser does.

1. Install a `cookies.txt` exporter extension in a browser where you are signed in.
2. Export the cookies for that outlet in **Netscape format**.
3. Save to `data/cookies/jar.txt` (or set `WIRE_COOKIE_JAR`).

```bash
npm run doctor   # confirms which domains have a live session
```

The file is gitignored. wire reloads it automatically when it changes, sends cookies
only to the domain that issued them, and skips expired ones. If a session stops
unlocking articles, wire says so explicitly rather than handing you a teaser.

## The read

"Summarize this article" produces something nobody needs. The prompt asks the four
questions a trader actually has, and it is instructed hard against the two failure modes
that make an LLM summary worse than useless here: inventing specifics that were not in
the text, and hedging every claim into mush.

```json
{
  "headline": "Fed signals a 50bp cut at the September meeting",
  "what_changed": "Minutes show officials prepared to cut by half a point...",
  "why_it_matters": "A faster easing path lowers real yields...",
  "assets": [{ "symbol": "BTC", "exposure": "indirect", "direction": "bullish", "why": "lower real yields" }],
  "status": "reported",
  "priced_in": "partially",
  "horizon": "days",
  "numbers": ["50bp cut signaled vs 25bp expected"],
  "counter": "Minutes are three weeks stale and two officials dissented."
}
```

The model is told exactly what kind of text it received: a full article, a paywall
teaser, independent coverage of the same event, or a primary-source document. That
provenance line is what keeps it honest when the source is thin.

`counter` is mandatory. A read with no counter-argument is a pitch.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `WIRE_BUDGET_MS` | `2500` | When the race stops waiting |
| `WIRE_LLM_BUDGET_MS` | `6000` | Whole-chain ceiling for the read |
| `WIRE_RESOLVER_TIMEOUT_MS` | `4000` | Per-lane ceiling |
| `WIRE_LLM_PREFER` | `speed` | `quality` puts Anthropic first instead of Groq |
| `WIRE_COOKIE_JAR` | `./data/cookies/jar.txt` | Netscape cookie file |
| `WIRE_CONTACT_EMAIL` | none | Sent in the User-Agent; **the SEC blocks callers without one** |
| `WIRE_API_TOKEN` | none | Requires a bearer token on API routes |
| `PORT` | `8787` | |

LLM providers are tried in order and any subset can be configured: `GROQ_API_KEY`,
`ANTHROPIC_API_KEY`, `CEREBRAS_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`.

## How it fits together

```
src/
  index.js       orchestration: post → target → race → read → late upgrades
  race.js        the race engine, scoring, and the hint registry lanes share
  resolvers/     one file per lane
  extract.js     HTML/markdown → prose (readability-style + JSON-LD body)
  paywall.js     is it gated, how, and where to go instead
  summarize.js   the trading prompt and output normalization
  llm.js         provider chain with per-attempt timeout caps
  fetch.js       the single outbound door: SSRF guard, timeouts, byte caps
  cache.js       in-process LRU + node:sqlite
server/          HTTP, SSE, static, Telegram webhook
telegram/        the bot and the progressive message renderer
web/             the browser client
```

Two details worth knowing before you change anything:

**Feeds are parsed as XML, not HTML.** `<link>` is a void element in HTML, so an HTML
parser silently returns an empty link for every RSS item. This cost real debugging time;
`src/rss.js` uses `fast-xml-parser` and there is a regression test.

**Every outbound request goes through `safeFetch`.** URLs arrive from strangers via
Telegram. Without the SSRF guard the server is an open proxy into whatever network it
runs on, including cloud metadata endpoints. Redirects are re-validated on every hop.

## Running it 24/7

wire is one container. `Dockerfile` and `fly.toml` are in the repo and both are
verified: the image builds, serves, resolves a live article, drains on SIGTERM,
and keeps its sqlite cache on a mounted volume across restarts.

```bash
fly launch --no-deploy --copy-config
fly volumes create wire_data --size 1 --region iad
fly secrets set TELEGRAM_BOT_TOKEN=... GROQ_API_KEY=...
fly deploy
```

About $3-4/month. Long polling needs no domain and no TLS.

**The machine must not sleep.** A host that suspends between HTTP requests stops
the bot receiving anything, with no error to see. `fly.toml` disables
`auto_stop_machines` for exactly this reason; leave it that way. And run only one
instance: two processes polling the same token split updates at random.

Hetzner plus the systemd unit in `deploy/wire.service`, or Cloud Run in webhook
mode, both work too. Full instructions and the hosts to avoid:
[docs/deploy.md](docs/deploy.md).

## Tests

```bash
npm test    # 48 tests, no network required
```

## Limits

- **Breaking news is the hard case for archives.** Nothing has crawled the URL yet, so
  the `wayback` and `archive` lanes miss. The `siblings` and `primary` lanes are what
  carry a genuinely fresh story.
- **The sibling lane needs a headline.** It starts from the URL slug immediately and
  upgrades to the real `og:title` when another lane produces one, usually within 700ms.
  On an outlet that serves a bot interstitial with no metadata at all, only the slug is
  available.
- **archive.today rate limits anonymous callers hard** and is often unavailable. That
  lane is opportunistic.
- **GDELT allows one request per five seconds per IP.** wire gates it client-side and
  treats it as a bonus, never blocking on it.
- **Google News gives coverage evidence, not article URLs.** Its links are redirectors
  that cannot be cheaply unwrapped, so those results tell you *who* ran the story and
  *when*; readable full text comes from the open feed registry in `src/feeds.js`.

## Legal note

wire reads what is public, what public archives already hold, and what you personally
pay for. It contains no circumvention rules for any publisher. Google News results carry
Google's own terms restricting them to personal, non-commercial use, and this tool is
built for personal use. If you are going to run it for a group, run it for a group of
people who are reading, not republishing.
