FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

WORKDIR /var/task

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      cmake \
      g++ \
      libcurl4-openssl-dev \
      make \
      unzip \
      xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm init -y \
    && npm install --omit=dev --no-audit --no-fund \
      "aws-lambda-ric@4.0.2" \
    && npm cache clean --force

COPY publisher-exporter.tgz /tmp/publisher-exporter.tgz

RUN npm install --omit=dev --no-audit --no-fund /tmp/publisher-exporter.tgz \
    && rm /tmp/publisher-exporter.tgz \
    && npm cache clean --force

FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PUBLISHER_BROWSER_TEMP_ROOT=/tmp/wpsuite-publisher-browser \
    HOME=/tmp \
    TMPDIR=/tmp \
    NPM_CONFIG_CACHE=/tmp/wpsuite-publisher-runtime/npm \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /var/task
COPY --from=build /var/task /var/task

ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
CMD ["node_modules/@smart-cloud/publisher-exporter/dist/remote-worker.handler"]
