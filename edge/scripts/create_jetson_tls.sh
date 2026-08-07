#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# != 1 )); then
  echo "usage: $0 <Jetson DNS name or IPv4 address>" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required" >&2
  exit 1
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required" >&2
  exit 1
fi

jetson_host="$1"
service_user="$(id -un)"
service_group="$(id -gn)"
tls_dir="${WARDY_TLS_DIR:-/etc/wardy/tls}"
tls_parent="$(dirname "${tls_dir}")"
lock_file="${tls_parent}/.wardy-tls.lock"
temporary_dir="$(mktemp -d)"
installed_artifacts=()

cleanup() {
  exit_status=$?
  trap - EXIT
  if (( exit_status != 0 && ${#installed_artifacts[@]} > 0 )); then
    sudo rm -f -- "${installed_artifacts[@]}"
  fi
  rm -rf "${temporary_dir}"
  exit "${exit_status}"
}
trap cleanup EXIT

sudo install -d -o root -g root -m 0755 "${tls_parent}"
sudo touch "${lock_file}"
sudo chown "${service_user}:${service_group}" "${lock_file}"
chmod 0600 "${lock_file}"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "another Wardy TLS installation is already running" >&2
  exit 1
fi

tls_artifacts=(
  "${tls_dir}/wardy-ca.key"
  "${tls_dir}/wardy-ca.crt"
  "${tls_dir}/jetson.key"
  "${tls_dir}/jetson.crt"
)
for tls_artifact in "${tls_artifacts[@]}"; do
  if sudo test -e "${tls_artifact}"; then
    echo "TLS artifact already exists: ${tls_artifact}; refusing to replace the set" >&2
    exit 1
  fi
done

if [[ "${jetson_host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  IFS='.' read -r -a address_parts <<< "${jetson_host}"
  for address_part in "${address_parts[@]}"; do
    if (( 10#${address_part} > 255 )); then
      echo "invalid IPv4 address: ${jetson_host}" >&2
      exit 1
    fi
  done
  subject_alt_name="IP:${jetson_host}"
else
  valid_dns_name=true
  if (( ${#jetson_host} == 0 || ${#jetson_host} > 253 )) ||
     [[ "${jetson_host}" == .* || "${jetson_host}" == *. || "${jetson_host}" == *..* ]]; then
    valid_dns_name=false
  else
    IFS='.' read -r -a dns_labels <<< "${jetson_host}"
    for dns_label in "${dns_labels[@]}"; do
      if (( ${#dns_label} == 0 || ${#dns_label} > 63 )) ||
         [[ ! "${dns_label}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
        valid_dns_name=false
        break
      fi
    done
  fi
  if [[ "${valid_dns_name}" != true ]]; then
    echo "invalid Jetson DNS name or IPv4 address: ${jetson_host}" >&2
    exit 1
  fi
  subject_alt_name="DNS:${jetson_host}"
fi

cat > "${temporary_dir}/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${subject_alt_name}
EOF

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "${temporary_dir}/wardy-ca.key"
openssl req -x509 -new -sha256 -days 3650 \
  -key "${temporary_dir}/wardy-ca.key" \
  -out "${temporary_dir}/wardy-ca.crt" \
  -subj "/CN=Wardy Local CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "${temporary_dir}/jetson.key"
openssl req -new -sha256 \
  -key "${temporary_dir}/jetson.key" \
  -out "${temporary_dir}/jetson.csr" \
  -subj "/CN=${jetson_host}"
openssl x509 -req -sha256 -days 825 \
  -in "${temporary_dir}/jetson.csr" \
  -CA "${temporary_dir}/wardy-ca.crt" \
  -CAkey "${temporary_dir}/wardy-ca.key" \
  -CAcreateserial \
  -out "${temporary_dir}/jetson.crt" \
  -extfile "${temporary_dir}/server.ext"

openssl verify -CAfile "${temporary_dir}/wardy-ca.crt" "${temporary_dir}/jetson.crt"
openssl x509 -in "${temporary_dir}/jetson.crt" -noout -checkend 86400 >/dev/null

install_tls_artifact() {
  local owner="$1"
  local group="$2"
  local mode="$3"
  local source_path="$4"
  local target_path="$5"

  if sudo install -o "${owner}" -g "${group}" -m "${mode}" "${source_path}" "${target_path}"; then
    installed_artifacts+=("${target_path}")
    return
  fi
  if sudo test -e "${target_path}"; then
    installed_artifacts+=("${target_path}")
  fi
  return 1
}

sudo install -d -o root -g root -m 0755 "${tls_dir}"
install_tls_artifact root root 0600 "${temporary_dir}/wardy-ca.key" "${tls_dir}/wardy-ca.key"
install_tls_artifact root root 0644 "${temporary_dir}/wardy-ca.crt" "${tls_dir}/wardy-ca.crt"
install_tls_artifact "${service_user}" "${service_group}" 0600 "${temporary_dir}/jetson.key" "${tls_dir}/jetson.key"
install_tls_artifact "${service_user}" "${service_group}" 0644 "${temporary_dir}/jetson.crt" "${tls_dir}/jetson.crt"

sudo openssl verify -CAfile "${tls_dir}/wardy-ca.crt" "${tls_dir}/jetson.crt"
openssl x509 -in "${temporary_dir}/jetson.crt" -noout -subject -ext subjectAltName
echo "Trust ${tls_dir}/wardy-ca.crt on each Windows browser host"
