#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${repo_dir}"
step="시작 준비"
device_file="${repo_dir}/.wardy-device"
tunnel_pid=""
loopback_alias_added=0
ui_tls_temp=""

cleanup() {
  if [[ -n "${ui_tls_temp}" && -d "${ui_tls_temp}" ]]; then
    rm -rf -- "${ui_tls_temp}"
  fi
  if [[ -n "${tunnel_pid}" ]] && kill -0 "${tunnel_pid}" 2>/dev/null; then
    kill "${tunnel_pid}" 2>/dev/null || true
    wait "${tunnel_pid}" 2>/dev/null || true
  fi
  if (( loopback_alias_added )); then
    sudo ifconfig lo0 -alias "${jetson_host}" 2>/dev/null || true
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
command -v openssl >/dev/null || { step="OpenSSL 확인: brew install openssl로 설치하세요"; false; }
command -v security >/dev/null || { step="macOS Keychain 도구 확인"; false; }

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
  if ! ifconfig lo0 | grep -Fq "inet ${jetson_host} "; then
    step="Jetson 터널용 로컬 주소 준비"
    echo "Preparing the local Jetson tunnel address. macOS may request your password."
    sudo ifconfig lo0 alias "${jetson_host}" 255.255.255.255
    loopback_alias_added=1
  fi
  # The Wardy SSH alias owns its LocalForward declarations. Repeating the
  # same -L options here makes OpenSSH bind each address twice and leaves the
  # browser without a working API tunnel.
  ssh -N -o ExitOnForwardFailure=yes "${ssh_target}" &
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

ui_host="${WARDY_UI_HOST:-}"
if [[ -z "${ui_host}" ]]; then
  default_interface="$(route -n get default 2>/dev/null | awk '$1 == "interface:" {print $2; exit}')"
  if [[ -n "${default_interface}" ]]; then
    ui_host="$(ipconfig getifaddr "${default_interface}" 2>/dev/null || true)"
  fi
fi
ui_host="${ui_host:-localhost}"
ui_tls_dir="${HOME}/Library/Application Support/Wardy/ui-tls"
ui_ca_key="${ui_tls_dir}/wardy-ui-ca.key"
ui_ca_cert="${ui_tls_dir}/wardy-ui-ca.crt"
ui_private_key="${ui_tls_dir}/wardy-ui.key"
ui_certificate="${ui_tls_dir}/wardy-ui.crt"
mkdir -p "${ui_tls_dir}"

if [[ ! -f "${ui_ca_key}" || ! -f "${ui_ca_cert}" ]]; then
  step="Mac UI CA 생성"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${ui_ca_key}"
  openssl req -x509 -new -sha256 -days 3650 \
    -key "${ui_ca_key}" -out "${ui_ca_cert}" -subj "/CN=Wardy Local UI CA"
  chmod 0600 "${ui_ca_key}"
fi

ui_ca_fingerprint="$(openssl x509 -in "${ui_ca_cert}" -noout -fingerprint -sha1 | awk -F= '{ gsub(":", "", $2); print $2 }')"
if ! security find-certificate -Z -c "Wardy Local UI CA" \
  "${HOME}/Library/Keychains/login.keychain-db" 2>/dev/null | \
  awk '/SHA-1 hash:/ { print $3 }' | grep -Fxq "${ui_ca_fingerprint}"; then
  step="Mac UI CA 신뢰 등록"
  security add-trusted-cert -r trustRoot \
    -k "${HOME}/Library/Keychains/login.keychain-db" "${ui_ca_cert}"
fi

if [[ ! -f "${ui_private_key}" || ! -f "${ui_certificate}" ]] || \
   ! openssl verify -CAfile "${ui_ca_cert}" "${ui_certificate}" >/dev/null 2>&1 || \
   ! openssl x509 -in "${ui_certificate}" -noout -checkhost localhost >/dev/null 2>&1 || \
   { [[ "${ui_host}" != "localhost" ]] && \
     ! openssl x509 -in "${ui_certificate}" -noout -checkip "${ui_host}" >/dev/null 2>&1; }; then
  step="Mac UI HTTPS 인증서 생성"
  ui_tls_temp="$(mktemp -d)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${ui_tls_temp}/wardy-ui.key"
  openssl req -new -sha256 -key "${ui_tls_temp}/wardy-ui.key" \
    -out "${ui_tls_temp}/wardy-ui.csr" -subj "/CN=${ui_host}"
  {
    printf '%s\n' 'basicConstraints=critical,CA:FALSE'
    printf '%s\n' 'keyUsage=critical,digitalSignature,keyEncipherment'
    printf '%s\n' 'extendedKeyUsage=serverAuth'
    if [[ "${ui_host}" == "localhost" ]]; then
      printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    else
      printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:%s\n' "${ui_host}"
    fi
  } >"${ui_tls_temp}/wardy-ui.ext"
  openssl x509 -req -sha256 -days 825 \
    -in "${ui_tls_temp}/wardy-ui.csr" \
    -CA "${ui_ca_cert}" -CAkey "${ui_ca_key}" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -extfile "${ui_tls_temp}/wardy-ui.ext" \
    -out "${ui_tls_temp}/wardy-ui.crt"
  install -m 0600 "${ui_tls_temp}/wardy-ui.key" "${ui_private_key}"
  install -m 0644 "${ui_tls_temp}/wardy-ui.crt" "${ui_certificate}"
  rm -rf "${ui_tls_temp}"
  ui_tls_temp=""
fi

phone_origin="https://${ui_host}:8000"
mac_origin="https://${ui_host}:8000"
export VITE_WARDY_JETSON_URL="https://${jetson_host}:8443"
export WARDY_UI_TLS_CERTIFICATE="${ui_certificate}"
export WARDY_UI_TLS_PRIVATE_KEY="${ui_private_key}"
url="${mac_origin}/?jetson=https%3A%2F%2F${jetson_host}%3A8443"
step="브라우저 열기"
(sleep 2; open "${url}") &
trap - ERR
echo "Wardy UI 시작: ${url}"
echo "휴대전화 Wardy 주소: ${phone_origin}/"
npm run serve
