#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
package_file="${edge_dir}/config/jetson-apt-packages.txt"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "Wardy Jetson dependency installation requires Linux aarch64" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get is required" >&2
  exit 1
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required" >&2
  exit 1
fi

mapfile -t packages < <(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "${package_file}")
if (( ${#packages[@]} == 0 )); then
  echo "no APT packages declared in ${package_file}" >&2
  exit 1
fi

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"

"${script_dir}/install_caddy.sh"
"${script_dir}/install_mediamtx.sh"
"${script_dir}/check_jetson_dependencies.sh"
