#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <remote-workers.json> <publisher-runtime-dir>\n' "$0" >&2
  exit 2
fi

SOURCE_PATH="$1"
RUNTIME_DIR="$2"

if [[ ! -f "${SOURCE_PATH}" ]]; then
  printf 'Remote worker config does not exist: %s\n' "${SOURCE_PATH}" >&2
  exit 1
fi
if [[ ! -d "${RUNTIME_DIR}" ]]; then
  printf 'Static Publisher runtime directory does not exist: %s\n' "${RUNTIME_DIR}" >&2
  exit 1
fi

install -m 0600 "${SOURCE_PATH}" "${RUNTIME_DIR}/remote-workers.json"
printf 'Installed remote worker config: %s/remote-workers.json\n' "${RUNTIME_DIR}"
