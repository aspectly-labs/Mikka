# syntax=docker/dockerfile:1
# Pre-baked Playwright Chromium + WebKit CI runtime for Cloudflare Containers.
# Versions match Mikka/pnpm-lock.yaml (playwright@1.64.1), Node 24.22.1, and pnpm@10.34.3.
# Contains zero private UI source and zero credentials.

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS node-tools
ADD --checksum=sha256:1c40544020a2e633068ed43a98eb5c0fed7d64a1c6d6f2382e43df91419dad62 https://registry.npmjs.org/pnpm/-/pnpm-10.34.3.tgz /tmp/pnpm.tgz
RUN mkdir -p /opt/pnpm && tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/pnpm

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f

COPY --from=node-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=node-tools /opt/pnpm /opt/pnpm
RUN rm -f /usr/bin/node \
  && ln -sf /usr/local/bin/node /usr/bin/node \
  && ln -sf /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git unzip zip \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /ms-playwright/firefox*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  CI=true \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_ENABLE_NETWORK=0

WORKDIR /tmp
CMD ["node", "-e", "setTimeout(() => {}, 900000)"]
