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
database_path="${WARDY_DATABASE_PATH:-/var/lib/wardy/db/wardy.sqlite}"
training_path="${WARDY_TRAINING_DATA_PATH:-/var/lib/wardy/training}"
event_path="${WARDY_EVENT_MEDIA_PATH:-/var/lib/wardy/events}"
[[ -f "${database_path}" ]] || exit 0

read -r event_days training_days < <(
  sqlite3 -separator ' ' "${database_path}" \
    "SELECT event_media_retention_days,training_data_retention_days FROM data_collection_settings WHERE singleton_id=1;"
)
[[ "${event_days}" =~ ^[0-9]+$ && "${training_days}" =~ ^[0-9]+$ ]] || {
  echo "Unable to read Wardy retention settings" >&2
  exit 1
}

safe_remove_relative() {
  local root="$1"
  local relative="$2"
  [[ -n "${relative}" && "${relative}" != /* && "${relative}" != *".."* ]] || return 1
  rm -f -- "${root}/${relative}"
}

while IFS='|' read -r event_id media_path; do
  [[ -n "${event_id}" ]] || continue
  if safe_remove_relative "${event_path}" "${media_path}"; then
    escaped_id="$(printf '%s' "${event_id}" | sed "s/'/''/g")"
    escaped_path="$(printf '%s' "${media_path}" | sed "s/'/''/g")"
    sqlite3 "${database_path}" \
      "UPDATE events SET media_type='none',media_path=NULL,media_started_at=NULL,media_ended_at=NULL WHERE event_id='${escaped_id}' AND media_path='${escaped_path}';"
  fi
done < <(sqlite3 -separator '|' "${database_path}" \
  "SELECT event_id,media_path FROM events WHERE media_path IS NOT NULL AND julianday(COALESCE(media_ended_at,occurred_at)) < julianday('now','-${event_days} days');")

while IFS='|' read -r table_name record_id image_path; do
  [[ -n "${record_id}" ]] || continue
  safe_remove_relative "${training_path}" "${image_path}" || continue
  escaped_id="$(printf '%s' "${record_id}" | sed "s/'/''/g")"
  if [[ "${table_name}" == "identity_reviews" ]]; then
    sqlite3 "${database_path}" "DELETE FROM identity_reviews WHERE review_id='${escaped_id}';"
  else
    sqlite3 "${database_path}" "DELETE FROM dataset_samples WHERE sample_id='${escaped_id}';"
  fi
done < <(sqlite3 -separator '|' "${database_path}" \
  "SELECT 'identity_reviews',review_id,image_path FROM identity_reviews WHERE decision!='subject' AND julianday(captured_at) < julianday('now','-${training_days} days') UNION ALL SELECT 'dataset_samples',sample_id,image_path FROM dataset_samples WHERE review_status!='approved' AND julianday(captured_at) < julianday('now','-${training_days} days');")

echo "Wardy retention cleanup completed. Approved samples and subject references were preserved."
