#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${repo_dir}"
step="시작 준비"
device_file="${repo_dir}/.wardy-device"

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

step="웹 의존성 설치"
if [[ ! -d node_modules ]]; then
  echo "Installing Wardy web dependencies. The initial setup can take a few minutes."
  npm ci
fi

ca_file="${HOME}/Library/Application Support/Wardy/wardy-ca.crt"
if [[ ! -f "${ca_file}" ]]; then
  step="Jetson CA 인증서 가져오기"
  mkdir -p "$(dirname "${ca_file}")"
  scp "${WARDY_SSH_USER:-mumallaeng}@${jetson_host}:/etc/wardy/tls/wardy-ca.crt" "${ca_file}"
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
exec npm run serve
