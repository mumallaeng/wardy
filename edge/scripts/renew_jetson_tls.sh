#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# < 1 )); then
  echo "usage: $0 <Jetson DNS name or IPv4 address> [additional DNS name or IPv4 address ...]" >&2
  exit 1
fi
for command_name in openssl flock sudo systemctl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "required command not found: ${command_name}" >&2
    exit 1
  fi
done

jetson_hosts=("$@")
primary_host="${jetson_hosts[0]}"
tls_dir="${WARDY_TLS_DIR:-/etc/wardy/tls}"
tls_parent="$(dirname "${tls_dir}")"
lock_file="${tls_parent}/.wardy-tls.lock"
temporary_dir="$(mktemp -d)"

cleanup() {
  rm -rf "${temporary_dir}"
}
trap cleanup EXIT

host_subject_alt_name() {
  local host="$1"
  local address_part dns_label
  local -a address_parts dns_labels

  if [[ "${host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    IFS='.' read -r -a address_parts <<< "${host}"
    for address_part in "${address_parts[@]}"; do
      if (( 10#${address_part} > 255 )); then return 1; fi
    done
    printf 'IP:%s\n' "${host}"
    return
  fi
  if (( ${#host} == 0 || ${#host} > 253 )) ||
     [[ "${host}" == .* || "${host}" == *. || "${host}" == *..* ]]; then
    return 1
  fi
  IFS='.' read -r -a dns_labels <<< "${host}"
  for dns_label in "${dns_labels[@]}"; do
    if (( ${#dns_label} == 0 || ${#dns_label} > 63 )) ||
       [[ ! "${dns_label}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
      return 1
    fi
  done
  printf 'DNS:%s\n' "${host}"
}

subject_alt_names=()
declare -A seen_hosts=()
for host in "${jetson_hosts[@]}"; do
  if ! subject_alt_name="$(host_subject_alt_name "${host}")"; then
    echo "invalid Jetson DNS name or IPv4 address: ${host}" >&2
    exit 1
  fi
  if [[ -n "${seen_hosts[${host}]:-}" ]]; then continue; fi
  seen_hosts["${host}"]=1
  subject_alt_names+=("${subject_alt_name}")
done
subject_alt_name="$(IFS=,; printf '%s' "${subject_alt_names[*]}")"

for tls_artifact in wardy-ca.key wardy-ca.crt jetson.key jetson.crt; do
  if ! sudo test -f "${tls_dir}/${tls_artifact}"; then
    echo "missing TLS artifact: ${tls_dir}/${tls_artifact}" >&2
    exit 1
  fi
done

sudo touch "${lock_file}"
sudo chown "$(id -un):$(id -gn)" "${lock_file}"
chmod 0600 "${lock_file}"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "another Wardy TLS installation is already running" >&2
  exit 1
fi

cat > "${temporary_dir}/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${subject_alt_name}
EOF

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "${temporary_dir}/jetson.key"
openssl req -new -sha256 \
  -key "${temporary_dir}/jetson.key" \
  -out "${temporary_dir}/jetson.csr" \
  -subj "/CN=${primary_host}"
sudo openssl x509 -req -sha256 -days 825 \
  -in "${temporary_dir}/jetson.csr" \
  -CA "${tls_dir}/wardy-ca.crt" \
  -CAkey "${tls_dir}/wardy-ca.key" \
  -CAserial "${temporary_dir}/wardy-ca.srl" \
  -CAcreateserial \
  -out "${temporary_dir}/jetson.crt" \
  -extfile "${temporary_dir}/server.ext"
sudo chown "$(id -un):$(id -gn)" "${temporary_dir}/jetson.crt"

openssl verify -CAfile "${tls_dir}/wardy-ca.crt" "${temporary_dir}/jetson.crt"
for host in "${jetson_hosts[@]}"; do
  if [[ "${host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    openssl x509 -in "${temporary_dir}/jetson.crt" -noout -checkip "${host}"
  else
    openssl x509 -in "${temporary_dir}/jetson.crt" -noout -checkhost "${host}"
  fi
done

sudo cp -p "${tls_dir}/jetson.key" "${temporary_dir}/jetson.key.backup"
sudo cp -p "${tls_dir}/jetson.crt" "${temporary_dir}/jetson.crt.backup"
sudo install -o "$(id -un)" -g "$(id -gn)" -m 0600 \
  "${temporary_dir}/jetson.key" "${tls_dir}/jetson.key"
sudo install -o "$(id -un)" -g "$(id -gn)" -m 0644 \
  "${temporary_dir}/jetson.crt" "${tls_dir}/jetson.crt"

if ! sudo systemctl restart wardy-edge.service ||
   ! sudo systemctl is-active --quiet wardy-edge.service; then
  echo "Wardy restart failed; restoring the previous server certificate" >&2
  sudo install -o "$(id -un)" -g "$(id -gn)" -m 0600 \
    "${temporary_dir}/jetson.key.backup" "${tls_dir}/jetson.key"
  sudo install -o "$(id -un)" -g "$(id -gn)" -m 0644 \
    "${temporary_dir}/jetson.crt.backup" "${tls_dir}/jetson.crt"
  sudo systemctl restart wardy-edge.service || true
  exit 1
fi

openssl x509 -in "${tls_dir}/jetson.crt" -noout -subject -ext subjectAltName
echo "Renewed the Jetson server certificate without replacing the Wardy local CA"
