#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# != 2 )) || [[ "$2" != "--confirm-replace" ]]; then
  echo "usage: $0 <wardy-backup.tar.gz> --confirm-replace" >&2
  echo "This replaces the active database, training data, and event media after creating a safety backup." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
env_file="${WARDY_ENV_FILE:-${edge_dir}/config/jetson.env}"
archive="$(realpath "$1")"
"${script_dir}/verify_wardy_backup.sh" "${archive}"

if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi
database_path="${WARDY_DATABASE_PATH:-/var/lib/wardy/db/wardy.sqlite}"
training_path="${WARDY_TRAINING_DATA_PATH:-/var/lib/wardy/training}"
event_path="${WARDY_EVENT_MEDIA_PATH:-/var/lib/wardy/events}"

stage="$(mktemp -d)"
restore_succeeded=0
edge_was_active=0
pose_was_active=0
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
old_root="$(dirname "${database_path}")/.wardy-restore-old-${timestamp}"
restore_cleanup() {
  local status=$?
  if (( status != 0 && restore_succeeded == 0 )) && [[ -d "${old_root}" ]]; then
    rm -rf -- "${database_path}" "${training_path}" "${event_path}"
    [[ -e "${old_root}/db" ]] && mv -- "${old_root}/db" "${database_path}"
    [[ -e "${old_root}/training" ]] && mv -- "${old_root}/training" "${training_path}"
    [[ -e "${old_root}/events" ]] && mv -- "${old_root}/events" "${event_path}"
  fi
  rm -rf -- "${stage}" "${old_root}"
  if (( status != 0 && restore_succeeded == 0 )); then
    (( edge_was_active )) && sudo systemctl start wardy-edge.service || true
    (( pose_was_active )) && sudo systemctl start wardy-pose-fall.service || true
  fi
  return "$status"
}
trap restore_cleanup EXIT
tar -C "${stage}" -xzf "${archive}"
[[ -d "${stage}/training" ]] || { echo "backup is missing training data" >&2; exit 1; }
[[ -d "${stage}/events" ]] || { echo "backup is missing event data" >&2; exit 1; }
if [[ -f "${stage}/db/wardy.sqlite" ]]; then
  integrity="$(sqlite3 "${stage}/db/wardy.sqlite" 'PRAGMA integrity_check;')"
  [[ "${integrity}" == "ok" ]] || { echo "staged SQLite integrity check failed: ${integrity}" >&2; exit 1; }
fi

systemctl is-active --quiet wardy-edge.service && edge_was_active=1 || true
systemctl is-active --quiet wardy-pose-fall.service && pose_was_active=1 || true
sudo systemctl stop wardy-edge.service wardy-pose-fall.service 2>/dev/null || true
"${script_dir}/backup_wardy_data.sh"

install -d -m 0700 "${old_root}/db" "${old_root}/training" "${old_root}/events"
[[ -e "${database_path}" ]] && mv -- "${database_path}" "${old_root}/db/wardy.sqlite" || true
[[ -e "${training_path}" ]] && mv -- "${training_path}" "${old_root}/training/data" || true
[[ -e "${event_path}" ]] && mv -- "${event_path}" "${old_root}/events/data" || true
install -d -m 0700 "$(dirname "${database_path}")" "$(dirname "${training_path}")" "$(dirname "${event_path}")"
if [[ -f "${stage}/db/wardy.sqlite" ]]; then
  install -m 0600 "${stage}/db/wardy.sqlite" "${database_path}"
fi
mv -- "${stage}/training" "${training_path}"
mv -- "${stage}/events" "${event_path}"

sudo systemctl start wardy-pose-fall.service wardy-edge.service
restore_succeeded=1
echo "Backup restored and Wardy services restarted."
