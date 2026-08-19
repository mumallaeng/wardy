#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${edge_dir}/.." && pwd)"
service_name="wardy-edge.service"
service_user="${WARDY_SERVICE_USER:-$(id -un)}"
service_home="$(getent passwd "${service_user}" | cut -d: -f6)"
start_service=true

if (( $# > 1 )); then
  echo "usage: $0 [--no-start]" >&2
  exit 1
fi
if (( $# == 1 )); then
  if [[ "$1" != "--no-start" ]]; then
    echo "usage: $0 [--no-start]" >&2
    exit 1
  fi
  start_service=false
fi
if [[ -z "${service_home}" ]]; then
  echo "home directory not found for service user: ${service_user}" >&2
  exit 1
fi

unit_file="$(mktemp)"
cleanup() { rm -f "${unit_file}"; }
trap cleanup EXIT

cat > "${unit_file}" <<EOF
[Unit]
Description=Wardy Jetson camera and local edge service
Wants=network-online.target ollama.service
After=network-online.target ollama.service

[Service]
Type=simple
User=${service_user}
WorkingDirectory=${repo_dir}
Environment=HOME=${service_home}
Environment=MTX_WEBRTCLOCALTCPADDRESS=:8189
ExecStart=${edge_dir}/scripts/start_jetson_webrtc.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 0644 "${unit_file}" "/etc/systemd/system/${service_name}"
sudo systemctl daemon-reload
sudo systemctl enable "${service_name}"
if [[ "${start_service}" == true ]]; then
  sudo systemctl restart "${service_name}"
fi

echo "installed ${service_name} for ${service_user}"
if [[ "${start_service}" == true ]]; then
  sudo systemctl --no-pager --full status "${service_name}" || true
fi
