#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
versions_file="${edge_dir}/config/jetson-tool-versions.env"
declared_version="$(sed -n 's/^WARDY_CADDY_VERSION=//p' "${versions_file}")"
declared_sha512="$(sed -n 's/^WARDY_CADDY_SHA512=//p' "${versions_file}")"
if [[ -n "${WARDY_CADDY_VERSION:-}" ]]; then
  version="${WARDY_CADDY_VERSION}"
  expected_sha512="${WARDY_CADDY_SHA512:-}"
  if [[ -z "${expected_sha512}" ]]; then
    echo "WARDY_CADDY_SHA512 is required when WARDY_CADDY_VERSION is overridden" >&2
    exit 1
  fi
else
  version="${declared_version:-2.11.3}"
  expected_sha512="${declared_sha512}"
fi
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid Caddy version: ${version}" >&2
  exit 1
fi
if [[ ! "${expected_sha512}" =~ ^[A-Fa-f0-9]{128}$ ]]; then
  echo "invalid Caddy SHA-512 digest" >&2
  exit 1
fi
archive="caddy_${version}_linux_arm64.tar.gz"
base_url="https://github.com/caddyserver/caddy/releases/download/v${version}"
target_dir="${edge_dir}/tools"
temporary_dir="$(mktemp -d)"

cleanup() {
  rm -rf "${temporary_dir}"
}
trap cleanup EXIT

for command in curl sha512sum tar install; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 1
  fi
done

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_dir}/${archive}" "${base_url}/${archive}"
printf '%s  %s\n' "${expected_sha512}" "${archive}" |
  (cd "${temporary_dir}" && sha512sum --check --status)

tar -xzf "${temporary_dir}/${archive}" -C "${temporary_dir}" caddy
mkdir -p "${target_dir}"
install -m 0755 "${temporary_dir}/caddy" "${target_dir}/caddy"
"${target_dir}/caddy" version
