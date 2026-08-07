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

## Google Cloud

Three ways, and the cheapest is also the best fit. Rates below are from the
Cloud Billing Catalog API for `us-central1`, not from a pricing page summary.

### Compute Engine e2-micro on Always Free (recommended on GCP, $0)

GCP's Always Free tier includes one `e2-micro` per month in `us-west1`,
`us-central1`, or `us-east1`, plus 30GB of **Standard** persistent disk. That is
an always-on VM, so long polling works, the disk is real so the sqlite cache
persists, and it costs nothing indefinitely.

```bash
gcloud compute instances create wire \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --boot-disk-type=pd-standard \
  --boot-disk-size=30GB \
  --image-family=debian-12 --image-project=debian-cloud
```

Then follow the VPS instructions above: Docker, `/etc/wire.env`, and the systemd
unit in `deploy/wire.service`.

Watch three things or it stops being free: the machine type must stay `e2-micro`,
the boot disk must be `pd-standard` (Balanced and SSD are billed), and the region
must be one of the three listed. Only one such instance is free per billing
account, so if three.ws already uses it, this is not free for you.

e2-micro is shared-core: 0.25 vCPU baseline bursting to 2, and 1GB RAM. That is
fine here, because wire spends nearly all of its wall clock waiting on outbound
HTTP rather than computing.

### Cloud Run, webhook mode, scale to zero ($0 at low volume)

Cloud Run's free tier is 180,000 vCPU-seconds and 360,000 GiB-seconds per month.
At 100 resolutions a day averaging 5 seconds, that is about 15,000 vCPU-seconds a
month, roughly 8% of the free allowance. So this genuinely costs nothing.

The catch is latency: a scaled-to-zero instance cold-starts in one to two seconds,
which is most of the budget the entire product is designed around. The first
message after a quiet period feels broken. Acceptable for the web UI, poor for
the bot.

### Cloud Run, webhook mode, `--min-instances=1` (about $9/month)

No cold starts. Idle time on a min instance bills at the reduced rate:

| SKU (us-central1) | Rate | Monthly (1 vCPU, 512MiB, 2,592,000s) |
|---|---|---|
| Services Min Instance CPU | $0.0000025 / vCPU-s | $6.48 |
| Services Min Instance Memory | $0.0000025 / GiB-s | $3.24 |
| Active request time | $0.000024 / vCPU-s | under $0.50 |

About **$9-10/month** before the free tier, a little under after.

### The expensive mistake

Do **not** reach for instance-based billing ("CPU always allocated") thinking it
will let the bot long-poll. It bills the full instance lifetime at
$0.000018/vCPU-s plus $0.00000193/GiB-s, which is **about $49/month** for the same
machine, five times the min-instances approach and twelve times a Hetzner box.
It also still does not guarantee the process stays alive the way a VM does.

### Whichever Cloud Run path you pick

- **Use webhook mode.** Cloud Run has no always-on process guarantee, so long
  polling will not survive. Compute Engine is the option that supports it.
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
