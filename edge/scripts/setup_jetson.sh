#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
env_file="${WARDY_ENV_FILE:-${edge_dir}/config/jetson.env}"
env_example="${edge_dir}/config/jetson.env.example"
tls_dir="${WARDY_TLS_DIR:-/etc/wardy/tls}"
start_service=true

usage() {
  echo "usage: $0 <Jetson DNS name or IPv4 address> <UI origin> [--no-start]" >&2
}

if (( $# < 2 || $# > 3 )); then
  usage
  exit 1
fi
if (( $# == 3 )); then
  if [[ "$3" != "--no-start" ]]; then
    usage
    exit 1
  fi
  start_service=false
fi

jetson_host="$1"
ui_origin="$2"

validate_host() {
  local host="$1"
  local label
  local -a parts

  if [[ "${host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    IFS='.' read -r -a parts <<< "${host}"
    for label in "${parts[@]}"; do
      if (( 10#${label} > 255 )); then
        return 1
      fi
    done
    return 0
  fi
  if (( ${#host} == 0 || ${#host} > 253 )) ||
     [[ "${host}" == .* || "${host}" == *. || "${host}" == *..* ]]; then
    return 1
  fi
  IFS='.' read -r -a parts <<< "${host}"
  for label in "${parts[@]}"; do
    if (( ${#label} == 0 || ${#label} > 63 )) ||
       [[ ! "${label}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
      return 1
    fi
  done
}

if ! validate_host "${jetson_host}"; then
  echo "invalid Jetson DNS name or IPv4 address: ${jetson_host}" >&2
  exit 1
fi
if [[ ! "${ui_origin}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "UI origin must contain only scheme, host, and optional port" >&2
  exit 1
fi
ui_port="${ui_origin##*:}"
if [[ "${ui_port}" != "${ui_origin}" && "${ui_port}" =~ ^[0-9]+$ ]] &&
   (( 10#${ui_port} > 65535 )); then
  echo "UI origin port is out of range: ${ui_port}" >&2
  exit 1
fi

"${script_dir}/install_jetson_dependencies.sh"

if [[ ! -f "${env_file}" ]]; then
  install -m 0600 "${env_example}" "${env_file}"
else
  chmod 0600 "${env_file}"
fi

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${env_file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${env_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${env_file}"
  fi
}

ensure_token() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "${env_file}" | head -n 1)"
  if [[ -z "${value}" || "${value}" == replace-with-* ]]; then
    set_env_value "${key}" "$(openssl rand -hex 32)"
  fi
}

sed -i '/^WARDY_MEDIAMTX_BIN=/d; /^WARDY_CADDY_BIN=/d' "${env_file}"
set_env_value WARDY_JETSON_HOST "${jetson_host}"
set_env_value WARDY_UI_ORIGIN "${ui_origin}"
set_env_value WARDY_TLS_CERTIFICATE "${tls_dir}/jetson.crt"
set_env_value WARDY_TLS_PRIVATE_KEY "${tls_dir}/jetson.key"
ensure_token WARDY_ACCESS_TOKEN
ensure_token WARDY_VIEWER_TOKEN
ensure_token WARDY_PUBLISH_TOKEN
chmod 0600 "${env_file}"

tls_artifacts=(
  "${tls_dir}/wardy-ca.key"
  "${tls_dir}/wardy-ca.crt"
  "${tls_dir}/jetson.key"
  "${tls_dir}/jetson.crt"
)
tls_artifact_count=0
for tls_artifact in "${tls_artifacts[@]}"; do
  if sudo test -e "${tls_artifact}"; then
    ((tls_artifact_count += 1))
  fi
done

certificate_public_key_digest() {
  sudo openssl x509 -in "$1" -pubkey -noout |
    openssl pkey -pubin -outform DER |
    sha256sum |
    awk '{print $1}'
}

private_key_public_digest() {
  sudo openssl pkey -in "$1" -pubout -outform DER |
    sha256sum |
    awk '{print $1}'
}

require_matching_key_pair() {
  local certificate="$1"
  local private_key="$2"
  local pair_name="$3"
  if [[ "$(certificate_public_key_digest "${certificate}")" !=
        "$(private_key_public_digest "${private_key}")" ]]; then
    echo "${pair_name} certificate and private key do not match; refusing to replace them" >&2
    exit 1
  fi
}

if (( tls_artifact_count == 0 )); then
  WARDY_TLS_DIR="${tls_dir}" "${script_dir}/create_jetson_tls.sh" "${jetson_host}"
elif (( tls_artifact_count == ${#tls_artifacts[@]} )); then
  sudo openssl verify -CAfile "${tls_dir}/wardy-ca.crt" "${tls_dir}/jetson.crt"
  if [[ "${jetson_host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    sudo openssl x509 -in "${tls_dir}/jetson.crt" -noout -checkip "${jetson_host}"
  else
    sudo openssl x509 -in "${tls_dir}/jetson.crt" -noout -checkhost "${jetson_host}"
  fi
  require_matching_key_pair \
    "${tls_dir}/wardy-ca.crt" "${tls_dir}/wardy-ca.key" "Wardy CA"
  require_matching_key_pair \
    "${tls_dir}/jetson.crt" "${tls_dir}/jetson.key" "Jetson TLS"
else
  echo "incomplete TLS set in ${tls_dir}; refusing to overwrite existing artifacts" >&2
  exit 1
fi

cmake -S "${edge_dir}" -B "${edge_dir}/build"
cmake --build "${edge_dir}/build" -j"$(nproc)"
"${script_dir}/check_jetson_dependencies.sh"

echo "Wardy Jetson setup is ready"
echo "Trust ${tls_dir}/wardy-ca.crt on each Windows browser host"
if [[ "${start_service}" == true ]]; then
  exec "${script_dir}/start_jetson_webrtc.sh"
fi
