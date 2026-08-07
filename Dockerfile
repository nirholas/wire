# wire runs as one container: web UI, HTTP API, and the Telegram bot in a single
# process. Node 22.5+ is required for the built-in node:sqlite module.
FROM node:22-slim

# Non-root by default. The image writes only to the data volume.
ENV NODE_ENV=production \
    WIRE_DATA_DIR=/data \
    PORT=8787

WORKDIR /app

# Install dependencies first so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY server ./server
COPY telegram ./telegram
COPY web ./web
COPY bin ./bin

# `node` is uid 1000 in the official image. The volume is chowned so the sqlite
# cache and the cookie jar are writable without running as root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787

# Fails the container health check if the process is up but not serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One process serves everything. In TELEGRAM_MODE=poll (the default) this also
# starts the long-polling loop, so no public URL is needed.
CMD ["node", "server/index.js"]
