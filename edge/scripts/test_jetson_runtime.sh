#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
env_file="${WARDY_ENV_FILE:-${edge_dir}/config/jetson.env}"

if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

base_url="${1:-http://127.0.0.1:8787}"
ui_origin="${2:-${WARDY_UI_ORIGIN:-}}"
access_token="${WARDY_ACCESS_TOKEN:-}"
ca_certificate="${WARDY_CA_CERTIFICATE:-}"

if [[ -z "${ui_origin}" || -z "${access_token}" ]]; then
  echo "WARDY_UI_ORIGIN and WARDY_ACCESS_TOKEN are required" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
cleanup() { rm -rf "${work_dir}"; }
trap cleanup EXIT

curl_args=(--silent --show-error --fail --max-time 5)
if [[ -n "${ca_certificate}" ]]; then
  curl_args+=(--cacert "${ca_certificate}")
fi

request() {
  local path="$1"
  local output="$2"
  curl "${curl_args[@]}" \
    --header "Origin: ${ui_origin}" \
    --header "X-Wardy-Access-Token: ${access_token}" \
    --output "${output}" \
    "${base_url}${path}"
}

request "/api/health" "${work_dir}/health.json"
grep -q '"service":"wardy-edge"' "${work_dir}/health.json"

declare -A expected=(
  [state]='"care_state"'
  [events]='"events"'
  [subjects]='"subjects"'
  [managed-items]='"managedItems"'
  [zones]='"zones"'
  [notification-settings]='"notifications"'
  [identity-reviews]='"reviews"'
)

for endpoint in state events subjects managed-items zones notification-settings identity-reviews; do
  request "/api/${endpoint}" "${work_dir}/${endpoint}.json"
  grep -q "${expected[${endpoint}]}" "${work_dir}/${endpoint}.json"
  echo "ok /api/${endpoint}"
done

echo "Wardy Jetson non-AI runtime APIs are ready at ${base_url}"
