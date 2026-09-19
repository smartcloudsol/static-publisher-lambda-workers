#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="${PUBLISHER_INFRA_CONFIG:-${1:-config/environments/local.json}}"

cd "${INFRA_DIR}"
node scripts/prepare-local-exporter.mjs "${CONFIG_PATH}"
npm run build
npm exec cdk synth -- --strict -c "config=${CONFIG_PATH}"
