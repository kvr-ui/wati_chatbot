# The WATI chatbot as one image: webhook, simulator UI and leads dashboard are
# a single Express process (src/server.js).
#
# Two stages so the runtime image carries no dev dependencies — the test runner
# and its tree have no business on a production box.

# ─── 1. dependencies, production only ──────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /build

# Manifests on their own layer: `npm ci` is the slow step and only needs to
# re-run when these two files actually change, not on every edit to a route.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── 2. the image that actually runs ───────────────────────────────────────
FROM node:22-alpine AS runtime

# `wget` for the healthcheck below; `tzdata` because session TTLs and the
# conversation log are read by humans in Asia/Kolkata, and a box with no zone
# database silently reports everything in UTC.
RUN apk add --no-cache tzdata wget

ENV NODE_ENV=production
ENV TZ=Asia/Kolkata

# Properties of running inside this container, not of the deployment, so they
# are fixed here rather than in .env:
#   HOST - .env says 127.0.0.1, which inside a container means "nobody can
#          reach me", including the port mapping. It must bind all interfaces;
#          the container is only published to localhost anyway (compose).
#   PORT - the internal port. The host-side port lives in docker-compose.yml.
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY --from=deps /build/node_modules ./node_modules
COPY package.json ./
COPY src/       ./src/
COPY public/    ./public/
COPY scripts/   ./scripts/

# The knowledge base is baked into the image: the bot may only say what is in
# here, so the answers a container gives are pinned to the commit it was built
# from. Editing a .md file therefore needs a rebuild — deliberate, because the
# alternative is a live bot whose script nobody can reproduce.
COPY knowledge/ ./knowledge/

# The embeddings cache. In the volume rather than the image because it is
# derived data (~MBs, rebuilt by POST /reindex) and because rebuilding it on
# every redeploy is a pointless OpenAI bill.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Runs as the `node` user the base image already provides. Root inside a
# container is still root on the kernel, and nothing here needs it.
USER node

VOLUME ["/app/data"]
EXPOSE 3000

# Asks the app the same question an operator would: are you serving? /health
# answers even when Mongo is unreachable (that is exactly when it matters), so
# a healthy container means the process is up, NOT that Atlas is reachable —
# check the `conversations` field in the response for that.
#
# start-period is generous because the first request may wait on the Atlas
# handshake, and a container killed mid-handshake never gets to report why.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:$PORT/health || exit 1

CMD ["node", "src/server.js"]
