#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
missing=0

require_command() {
  local command_name="$1"
  if command -v "${command_name}" >/dev/null 2>&1; then
    printf 'ok command %s\n' "${command_name}"
  else
    printf 'missing command %s\n' "${command_name}" >&2
    missing=1
  fi
}

require_file() {
  local file_path="$1"
  if [[ -x "${file_path}" ]]; then
    printf 'ok executable %s\n' "${file_path}"
  else
    printf 'missing executable %s\n' "${file_path}" >&2
    missing=1
  fi
}

require_plugin() {
  local plugin_name="$1"
  if gst-inspect-1.0 "${plugin_name}" >/dev/null 2>&1; then
    printf 'ok gstreamer %s\n' "${plugin_name}"
  else
    printf 'missing gstreamer %s\n' "${plugin_name}" >&2
    missing=1
  fi
}

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "Wardy Jetson runtime requires Linux aarch64" >&2
  exit 1
fi

for command_name in cmake c++ flock git gst-inspect-1.0 openssl pkg-config v4l2-ctl; do
  require_command "${command_name}"
done

if command -v pkg-config >/dev/null 2>&1; then
  for package_name in opencv4 sqlite3; do
    if pkg-config --exists "${package_name}"; then
      printf 'ok pkg-config %s %s\n' "${package_name}" "$(pkg-config --modversion "${package_name}")"
    else
      printf 'missing pkg-config %s\n' "${package_name}" >&2
      missing=1
    fi
  done
fi

if command -v gst-inspect-1.0 >/dev/null 2>&1; then
  for plugin_name in v4l2src tee queue videoconvert nvvidconv x264enc h264parse rtspclientsink appsink; do
    require_plugin "${plugin_name}"
  done
fi

require_file "${edge_dir}/tools/caddy"
require_file "${edge_dir}/tools/mediamtx"

if [[ -e /dev/video0 ]]; then
  echo "ok camera /dev/video0"
else
  echo "warning camera /dev/video0 is not present" >&2
fi

if (( missing != 0 )); then
  echo "Wardy Jetson dependency check failed" >&2
  exit 1
fi

echo "Wardy Jetson dependencies are ready"
