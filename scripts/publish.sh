#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="${PUBLISHER_INFRA_CONFIG:-${1:-config/environments/local.json}}"
OUTPUTS_PATH="${PUBLISHER_CDK_OUTPUTS:-cdk-outputs.json}"
EXPORTER_CONFIG_PATH="remote-workers.json"
INSTALL_TARGET="${2:-}"
PUBLISHER_RUNTIME_DIR="${PUBLISHER_RUNTIME_DIR:-}"
PUBLISHER_REMOTE_WORKER_SCP_TARGET="${PUBLISHER_REMOTE_WORKER_SCP_TARGET:-}"

cd "${INFRA_DIR}"
if [[ -n "${INSTALL_TARGET}" ]]; then
  if [[ -n "${PUBLISHER_RUNTIME_DIR}" || -n "${PUBLISHER_REMOTE_WORKER_SCP_TARGET}" ]]; then
    printf '%s\n' \
      'Do not combine the second install-target argument with PUBLISHER_RUNTIME_DIR or PUBLISHER_REMOTE_WORKER_SCP_TARGET.' >&2
    exit 1
  fi
  if [[ "${INSTALL_TARGET}" == *:* ]]; then
    PUBLISHER_REMOTE_WORKER_SCP_TARGET="${INSTALL_TARGET}"
  else
    PUBLISHER_RUNTIME_DIR="${INSTALL_TARGET}"
  fi
fi
if [[ -n "${PUBLISHER_RUNTIME_DIR}" && -n "${PUBLISHER_REMOTE_WORKER_SCP_TARGET}" ]]; then
  printf '%s\n' \
    'Use either PUBLISHER_RUNTIME_DIR for a locally accessible runtime or PUBLISHER_REMOTE_WORKER_SCP_TARGET for an SSH destination, not both.' >&2
  exit 1
fi
if [[ -n "${PUBLISHER_RUNTIME_DIR}" && ! -d "${PUBLISHER_RUNTIME_DIR}" ]]; then
  printf '%s\n' \
    "Static Publisher runtime directory is not locally accessible: ${PUBLISHER_RUNTIME_DIR}" \
    'Omit PUBLISHER_RUNTIME_DIR when the runtime is on another host, then transfer remote-workers.json after deployment.' >&2
  exit 1
fi
node scripts/prepare-local-exporter.mjs "${CONFIG_PATH}"
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' \
    'Docker is not available. Start Docker Desktop and enable WSL integration, or start a local Docker daemon.' >&2
  exit 1
fi
npm run check
npm exec cdk diff -- --strict -c "config=${CONFIG_PATH}"
npm exec cdk deploy -- --strict --require-approval broadening \
  --outputs-file "${OUTPUTS_PATH}" -c "config=${CONFIG_PATH}"
node scripts/export-config.mjs \
  --outputs "${OUTPUTS_PATH}" \
  --destination "${EXPORTER_CONFIG_PATH}"

printf 'Exporter config written to %s\n' "${INFRA_DIR}/${EXPORTER_CONFIG_PATH}"
if [[ -n "${PUBLISHER_RUNTIME_DIR}" ]]; then
  "${SCRIPT_DIR}/install-runtime-config.sh" \
    "${EXPORTER_CONFIG_PATH}" \
    "${PUBLISHER_RUNTIME_DIR}"
elif [[ -n "${PUBLISHER_REMOTE_WORKER_SCP_TARGET}" ]]; then
  command -v scp >/dev/null 2>&1 || {
    printf 'Required command not found: scp\n' >&2
    exit 1
  }
  scp -- "${EXPORTER_CONFIG_PATH}" "${PUBLISHER_REMOTE_WORKER_SCP_TARGET}"
  printf 'Uploaded remote worker config to %s\n' \
    "${PUBLISHER_REMOTE_WORKER_SCP_TARGET}"
else
  printf '%s\n' \
    'Required before enabling Lambda rendering: install this file as <site-runtime>/remote-workers.json.' \
    'Pass a local runtime directory or an scp destination as the second publish.sh argument.'
fi
