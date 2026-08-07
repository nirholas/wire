# Deploying wire

wire is one container: web UI, HTTP API, and the Telegram bot in a single Node
process. Any host that runs a container 24/7 with about 512MB of RAM works.

**The one setting that matters everywhere: the machine must not sleep.** A
Telegram bot in long-polling mode holds an open connection. A host that suspends
between HTTP requests silently stops the bot from receiving anything, and there
is no error to see. Scale-to-zero is wrong for this workload unless you switch to
webhook mode.

Everything below has been verified against the image in this repo: it builds,
serves, resolves a live article, drains cleanly on SIGTERM, and keeps its sqlite
cache across a restart.

---

## Fly.io (recommended)

Best fit: long polling works with no domain or TLS setup, a persistent volume
keeps the cache across deploys, and it costs roughly $3-4/month for an always-on
512MB machine plus about $0.15/month for the volume.

```bash
# One time
fly launch --no-deploy --copy-config     # keeps the committed fly.toml
fly volumes create wire_data --size 1 --region iad

fly secrets set \
  TELEGRAM_BOT_TOKEN=... \
  GROQ_API_KEY=... \
  OPENROUTER_API_KEY=... \
  TELEGRAM_ALLOWED_USERS=11111111,22222222

fly deploy
```

Then:

```bash
fly logs                      # watch it boot
fly status                    # confirm one machine, running
curl https://<app>.fly.dev/healthz
```

`fly.toml` already sets `auto_stop_machines = false` and
`min_machines_running = 1`. **Do not turn those on.** They are what keep the bot
awake, and Fly's default for a new app is the opposite.

Secrets go through `fly secrets`, never into `fly.toml`, which is committed.

### Updating

```bash
git push && fly deploy
```

The volume persists, so the resolution history and cache survive.

---

## A plain VPS (Hetzner, DigitalOcean, Vultr)

Pick this if you want no platform behavior to reason about. A Hetzner CX22 is
about EUR 3.79/month and is more machine than wire will ever use.

```bash
# On the box, as root
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/wire/data

# Bring the image over: either build on the box from a git clone, or
docker build -t wire /opt/wire/src

cat > /etc/wire.env <<'EOF'
TELEGRAM_BOT_TOKEN=...
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
TELEGRAM_ALLOWED_USERS=11111111,22222222
WIRE_DATA_DIR=/data
EOF
chmod 600 /etc/wire.env
```

Install the unit shipped in this repo and start it:

```bash
cp deploy/wire.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wire
journalctl -u wire -f
```

`Restart=always` brings it back after a crash or a reboot, which is the whole
reason to use systemd rather than `docker run -d`.

---

## Google Cloud Run

Workable, and free if you are spending existing credits, but it is the weakest
fit of the three and needs the most care:

- **Use webhook mode.** Cloud Run has no always-on process guarantee, so long
  polling will not survive.
- **Pin `--min-instances=1`.** Otherwise a cold start adds one to two seconds to
  a budget the whole product is built around. This is what makes it cost roughly
  $12-15/month rather than nothing.
- **The filesystem is ephemeral.** The sqlite cache resets on every revision and
  every new instance. Nothing breaks, but `/api/recent` and permalinks only cover
  the life of the current instance. Mount a GCS volume if that matters.

```bash
gcloud run deploy wire \
  --source . \
  --region us-central1 \
  --min-instances=1 \
  --memory=512Mi \
  --allow-unauthenticated \
  --set-env-vars TELEGRAM_MODE=webhook,WIRE_DATA_DIR=/tmp \
  --set-secrets TELEGRAM_BOT_TOKEN=wire-tg-token:latest,GROQ_API_KEY=wire-groq:latest
```

Then point Telegram at it. The server registers the webhook itself on boot when
`TELEGRAM_WEBHOOK_BASE` is set:

```bash
gcloud run services update wire --region us-central1 \
  --update-env-vars TELEGRAM_WEBHOOK_BASE=https://<service-url>,TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)
```

`--update-env-vars` merges. `--set-env-vars` replaces the entire set and will
drop your other variables.

---

## Not recommended

- **Render free tier, Railway trial, Heroku eco** spin down when idle. The bot
  goes deaf and nothing tells you.
- **Vercel, Netlify, Cloudflare Workers** are request-scoped. There is no process
  to hold a poll open, and wire's `node:sqlite` cache and long-running race do
  not fit the model. Webhook mode on Workers would need a rewrite.
- **Oracle Cloud Always Free** is genuinely free and generous, but account
  suspensions and capacity errors are common enough that it is a bad place for
  something you want up.

---

## After any deploy

```bash
curl https://<host>/healthz
```

Confirm `llm.configured` is true and the chain lists your providers. Then message
the bot:

- `/health` reports lanes, models, and **warns in bold if access is still open**
- `/whoami` gives you the id for `TELEGRAM_ALLOWED_USERS`

Send it a link. You should see the message post within about a second and then
edit itself as the answer sharpens.

## Operating notes

- **Only ever run one instance.** Two processes polling the same bot token split
  updates between them at random, so roughly half your messages get answered by
  the instance without the context. Fly's `min_machines_running = 1` plus no
  autoscaling handles this; on a VPS, systemd handles it.
- **Rotate a leaked token immediately** with `/revoke` in BotFather. A bot token
  is a full credential for the bot.
- **The cookie jar is a real credential too.** If you use the subscription lane,
  that file is a live session for an account you pay for. Mount it read-only,
  keep it off any shared host, and prefer running on a box only you can reach.
