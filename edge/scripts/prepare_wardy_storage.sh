#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
env_file="${WARDY_ENV_FILE:-${edge_dir}/config/jetson.env}"
service_user="${WARDY_SERVICE_USER:-${SUDO_USER:-${USER}}}"

if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

database_path="${WARDY_DATABASE_PATH:-/var/lib/wardy/db/wardy.sqlite}"
training_path="${WARDY_TRAINING_DATA_PATH:-/var/lib/wardy/training}"
event_path="${WARDY_EVENT_MEDIA_PATH:-/var/lib/wardy/events}"
backup_path="${WARDY_BACKUP_PATH:-/var/lib/wardy/backups}"

for path in "$(dirname "${database_path}")" "${training_path}" "${event_path}" "${backup_path}"; do
  sudo install -d -m 0700 -o "${service_user}" -g "$(id -gn "${service_user}")" "${path}"
done

legacy_database="${edge_dir}/db/wardy.sqlite"
if [[ ! -e "${database_path}" && -f "${legacy_database}" ]]; then
  echo "Migrating existing SQLite data to ${database_path}"
  sudo -u "${service_user}" sqlite3 "${legacy_database}" ".backup '${database_path}'"
  chmod 0600 "${database_path}"
fi

copy_legacy_directory() {
  local source="$1"
  local destination="$2"
  local label="$3"
  if [[ -d "${source}" && -z "$(find "${destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Migrating existing ${label} to ${destination}"
    cp -a "${source}/." "${destination}/"
  fi
}

copy_legacy_directory "${edge_dir}/data/training" "${training_path}" "training data"
copy_legacy_directory "${edge_dir}/data/events" "${event_path}" "event media"

chmod 0700 "$(dirname "${database_path}")" "${training_path}" "${event_path}" "${backup_path}"
echo "Persistent storage ready at $(dirname "$(dirname "${database_path}")")"
