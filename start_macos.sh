#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${repo_dir}"
step="시작 준비"
device_file="${repo_dir}/.wardy-device"
tunnel_pid=""

cleanup() {
  if [[ -n "${tunnel_pid}" ]] && kill -0 "${tunnel_pid}" 2>/dev/null; then
    kill "${tunnel_pid}" 2>/dev/null || true
    wait "${tunnel_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

help_on_failure() {
  local status=$?
  echo >&2
  echo "[실패] ${step}" >&2
  echo "다음 명령으로 확인하세요:" >&2
  echo "  node --version && npm --version" >&2
  echo "  curl -vk https://${jetson_host:-JETSON_IP}:8443/api/health" >&2
  echo "  ssh ${WARDY_SSH_USER:-mumallaeng}@${jetson_host:-JETSON_IP} 'systemctl status wardy-edge.service wardy-pose-fall.service'" >&2
  echo "복구 후 다시 실행: ./start_macos.sh [Jetson IP]" >&2
  exit "${status}"
}
trap help_on_failure ERR

command -v node >/dev/null || { step="Node.js 확인: Node.js LTS를 설치하세요"; false; }
command -v npm >/dev/null || { step="npm 확인: Node.js LTS를 다시 설치하세요"; false; }

jetson_host="${1:-${WARDY_JETSON_HOST:-}}"
if [[ -z "${jetson_host}" && -f "${device_file}" ]]; then jetson_host="$(<"${device_file}")"; fi
if [[ -z "${jetson_host}" ]]; then
  for candidate in wardy.local 10.10.20.40; do
    if curl -kfsS --max-time 1 "https://${candidate}:8443/api/health" >/dev/null 2>&1; then jetson_host="${candidate}"; break; fi
  done
fi
if [[ -z "${jetson_host}" && -t 0 ]]; then read -r -p "Jetson IP 또는 DNS: " jetson_host; fi
[[ -n "${jetson_host}" ]] || { step="Jetson 주소 탐색: ./start_macos.sh <Jetson IP>로 한 번 실행하세요"; false; }
printf '%s\n' "${jetson_host}" >"${device_file}"

ssh_target="${WARDY_SSH_ALIAS:-wardy-jetson-macos}"
ssh_alias_host="$(ssh -G "${ssh_target}" 2>/dev/null | awk '$1 == "hostname" {print $2; exit}')"
if ! curl -kfsS --max-time 2 "https://${jetson_host}:8443/api/health" >/dev/null 2>&1; then
  step="Jetson SSH 터널 시작"
  echo "Direct Jetson access is unavailable. Starting the Wardy SSH tunnel."
  echo "Keep this terminal open while using the camera."
  ssh -N -o ExitOnForwardFailure=yes \
    -L "${jetson_host}:8443:127.0.0.1:8443" \
    -L "${jetson_host}:8189:127.0.0.1:8189" \
    "${ssh_target}" &
  tunnel_pid=$!
  for _ in {1..20}; do
    if curl -kfsS --max-time 2 "https://${jetson_host}:8443/api/health" >/dev/null 2>&1; then
      break
    fi
    kill -0 "${tunnel_pid}" 2>/dev/null || false
    sleep 1
  done
  curl -kfsS --max-time 2 "https://${jetson_host}:8443/api/health" >/dev/null
fi

step="웹 의존성 설치"
if [[ ! -d node_modules ]]; then
  echo "Installing Wardy web dependencies. The initial setup can take a few minutes."
  npm ci
fi

ca_file="${HOME}/Library/Application Support/Wardy/wardy-ca.crt"
if [[ ! -f "${ca_file}" ]]; then
  step="Jetson CA 인증서 가져오기"
  mkdir -p "$(dirname "${ca_file}")"
  if [[ -n "${tunnel_pid}" || "${ssh_alias_host}" == "${jetson_host}" ]]; then
    scp "${ssh_target}:/etc/wardy/tls/wardy-ca.crt" "${ca_file}"
  else
    scp "${WARDY_SSH_USER:-mumallaeng}@${jetson_host}:/etc/wardy/tls/wardy-ca.crt" "${ca_file}"
  fi
  step="Jetson CA 인증서 신뢰 등록"
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain "${ca_file}"
fi

step="Jetson health 확인"
curl --silent --show-error --fail --max-time 5 --cacert "${ca_file}" \
  "https://${jetson_host}:8443/api/health" >/dev/null

url="http://localhost:8000/?jetson=https%3A%2F%2F${jetson_host}%3A8443"
step="브라우저 열기"
(sleep 2; open "${url}") &
trap - ERR
echo "Wardy UI 시작: ${url}"
npm run serve
