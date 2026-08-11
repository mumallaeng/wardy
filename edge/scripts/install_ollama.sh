#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
versions_file="${edge_dir}/config/jetson-tool-versions.env"

# shellcheck disable=SC1090
source "${versions_file}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "Wardy Ollama installation requires Linux aarch64" >&2
  exit 1
fi
for command_name in curl jq sha256sum sudo; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "required command not found: ${command_name}" >&2
    exit 1
  fi
done
if [[ ! "${WARDY_OLLAMA_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ||
      ! "${WARDY_OLLAMA_INSTALL_SHA256}" =~ ^[a-f0-9]{64}$ ||
      ! "${WARDY_LLM_MODEL_DIGEST}" =~ ^[a-f0-9]{64}$ ||
      -z "${WARDY_LLM_MODEL}" ]]; then
  echo "invalid pinned Ollama configuration" >&2
  exit 1
fi

installed_version=""
if command -v ollama >/dev/null 2>&1; then
  installed_version="$(ollama --version 2>&1 | sed -n 's/.*version is \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
fi
if [[ "${installed_version}" != "${WARDY_OLLAMA_VERSION}" ]]; then
  temporary_dir="$(mktemp -d)"
  cleanup() { rm -rf "${temporary_dir}"; }
  trap cleanup EXIT
  installer="${temporary_dir}/install.sh"
  curl --fail --location --silent --show-error \
    "https://github.com/ollama/ollama/releases/download/v${WARDY_OLLAMA_VERSION}/install.sh" \
    --output "${installer}"
  printf '%s  %s\n' "${WARDY_OLLAMA_INSTALL_SHA256}" "${installer}" |
    sha256sum --check --status
  sudo env OLLAMA_VERSION="${WARDY_OLLAMA_VERSION}" bash "${installer}"
fi

sudo systemctl enable --now ollama.service
ollama_ready=false
for _ in {1..60}; do
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      http://127.0.0.1:11434/api/version >/dev/null; then
    ollama_ready=true
    break
  fi
  sleep 0.5
done
if [[ "${ollama_ready}" != true ]]; then
  echo "Ollama did not become ready on Jetson loopback" >&2
  exit 1
fi

ollama_model_digest() {
  curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
      http://127.0.0.1:11434/api/tags |
    jq --raw-output --arg model "${WARDY_LLM_MODEL}" \
      'first(.models[] | select(.name == $model or .model == $model) | .digest) // empty'
}

if [[ "$(ollama_model_digest)" != "${WARDY_LLM_MODEL_DIGEST}" ]]; then
  ollama pull "${WARDY_LLM_MODEL}"
fi
if [[ "$(ollama_model_digest)" != "${WARDY_LLM_MODEL_DIGEST}" ]]; then
  echo "Ollama model digest does not match the Wardy manifest" >&2
  exit 1
fi
ollama stop "${WARDY_LLM_MODEL}" >/dev/null 2>&1 || true
echo "Wardy on-device LLM is ready: ${WARDY_LLM_MODEL}"
