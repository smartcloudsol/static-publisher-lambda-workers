ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build

WORKDIR /var/task
COPY runtime-package.json /var/task/package.json

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      cmake \
      g++ \
      libcurl4-openssl-dev \
      make \
      unzip \
      xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY publisher-exporter.tgz /tmp/publisher-exporter.tgz

RUN npm install --omit=dev --no-audit --no-fund /tmp/publisher-exporter.tgz \
    && rm /tmp/publisher-exporter.tgz \
    && npm audit --omit=dev --audit-level=high \
    && npm cache clean --force

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG PLAYWRIGHT_VERSION

ENV NODE_ENV=production \
    PUBLISHER_BROWSER_TEMP_ROOT=/tmp/wpsuite-publisher-browser \
    HOME=/tmp \
    TMPDIR=/tmp \
    NPM_CONFIG_CACHE=/tmp/wpsuite-publisher-runtime/npm \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}

WORKDIR /var/task
COPY --from=build /var/task /var/task
COPY browser-smoke.mjs /var/task/browser-smoke.mjs

RUN node /var/task/browser-smoke.mjs

ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
CMD ["node_modules/@smart-cloud/publisher-exporter/dist/remote-worker.handler"]
