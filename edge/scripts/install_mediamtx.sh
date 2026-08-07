#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
version="${WARDY_MEDIAMTX_VERSION:-1.18.2}"
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
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_dir}/checksums.sha256" "${base_url}/checksums.sha256"

expected_line="$(grep "  ${archive}$" "${temporary_dir}/checksums.sha256" || true)"
if [[ -z "${expected_line}" ]]; then
  echo "checksum entry not found for ${archive}" >&2
  exit 1
fi
printf '%s\n' "${expected_line}" | (cd "${temporary_dir}" && sha256sum --check --status)

tar -xzf "${temporary_dir}/${archive}" -C "${temporary_dir}"
mkdir -p "${target_dir}"
install -m 0755 "${temporary_dir}/mediamtx" "${target_dir}/mediamtx"
"${target_dir}/mediamtx" --version
