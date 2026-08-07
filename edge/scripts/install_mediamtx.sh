#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
versions_file="${edge_dir}/config/jetson-tool-versions.env"
declared_version="$(sed -n 's/^WARDY_MEDIAMTX_VERSION=//p' "${versions_file}")"
declared_sha256="$(sed -n 's/^WARDY_MEDIAMTX_SHA256=//p' "${versions_file}")"
if [[ -n "${WARDY_MEDIAMTX_VERSION:-}" ]]; then
  version="${WARDY_MEDIAMTX_VERSION}"
  expected_sha256="${WARDY_MEDIAMTX_SHA256:-}"
  if [[ -z "${expected_sha256}" ]]; then
    echo "WARDY_MEDIAMTX_SHA256 is required when WARDY_MEDIAMTX_VERSION is overridden" >&2
    exit 1
  fi
else
  version="${declared_version:-1.18.2}"
  expected_sha256="${declared_sha256}"
fi
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid MediaMTX version: ${version}" >&2
  exit 1
fi
if [[ ! "${expected_sha256}" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  echo "invalid MediaMTX SHA-256 digest" >&2
  exit 1
fi
archive="mediamtx_v${version}_linux_arm64.tar.gz"
base_url="https://github.com/bluenviron/mediamtx/releases/download/v${version}"
target_dir="${edge_dir}/tools"
temporary_dir="$(mktemp -d)"

cleanup() {
  rm -rf "${temporary_dir}"
}
trap cleanup EXIT

for command in curl sha256sum tar install; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 1
  fi
done

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_dir}/${archive}" "${base_url}/${archive}"
printf '%s  %s\n' "${expected_sha256}" "${archive}" |
  (cd "${temporary_dir}" && sha256sum --check --status)

tar -xzf "${temporary_dir}/${archive}" -C "${temporary_dir}"
mkdir -p "${target_dir}"
install -m 0755 "${temporary_dir}/mediamtx" "${target_dir}/mediamtx"
"${target_dir}/mediamtx" --version
