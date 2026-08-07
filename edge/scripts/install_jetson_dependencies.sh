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

if ! dpkg-query -W -f='${Version}\n' nvidia-l4t-core >/dev/null 2>&1; then
  echo "nvidia-l4t-core is required; run this installer on a JetPack-provisioned Jetson" >&2
  exit 1
fi
l4t_core_version="$(dpkg-query -W -f='${Version}\n' nvidia-l4t-core)"
l4t_gstreamer_status="$(dpkg-query -W -f='${Status}\n' nvidia-l4t-gstreamer 2>/dev/null || true)"
l4t_gstreamer_version="$(dpkg-query -W -f='${Version}\n' nvidia-l4t-gstreamer 2>/dev/null || true)"
if [[ "${l4t_gstreamer_status}" != "install ok installed" ||
      "${l4t_gstreamer_version}" != "${l4t_core_version}" ]]; then
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades \
    --no-install-recommends \
    "nvidia-l4t-gstreamer=${l4t_core_version}"
fi

"${script_dir}/install_caddy.sh"
"${script_dir}/install_mediamtx.sh"
"${script_dir}/check_jetson_dependencies.sh"
