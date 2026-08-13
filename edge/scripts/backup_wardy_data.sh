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
backup_path="${1:-${WARDY_BACKUP_PATH:-/var/lib/wardy/backups}}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${backup_path}/wardy-backup-${timestamp}.tar.gz"
stage="$(mktemp -d)"
edge_was_active=0
pose_was_active=0
systemctl is-active --quiet wardy-edge.service && edge_was_active=1 || true
systemctl is-active --quiet wardy-pose-fall.service && pose_was_active=1 || true
resume_services() {
  local status=$?
  rm -rf -- "${stage}"
  (( edge_was_active )) && sudo systemctl start wardy-edge.service || true
  (( pose_was_active )) && sudo systemctl start wardy-pose-fall.service || true
  return "$status"
}
trap resume_services EXIT

sudo systemctl stop wardy-edge.service wardy-pose-fall.service 2>/dev/null || true

install -d -m 0700 "${backup_path}" "${stage}/db" "${stage}/training" "${stage}/events"
if [[ -f "${database_path}" ]]; then
  sqlite3 "${database_path}" ".backup '${stage}/db/wardy.sqlite'"
  integrity="$(sqlite3 "${stage}/db/wardy.sqlite" 'PRAGMA integrity_check;')"
  [[ "${integrity}" == "ok" ]] || { echo "SQLite backup integrity check failed: ${integrity}" >&2; exit 1; }
fi
[[ ! -d "${training_path}" ]] || cp -a "${training_path}/." "${stage}/training/"
[[ ! -d "${event_path}" ]] || cp -a "${event_path}/." "${stage}/events/"

{
  printf 'format=wardy-backup-v1\n'
  printf 'created_at=%s\n' "${timestamp}"
  printf 'database=%s\n' "${database_path}"
  printf 'training=%s\n' "${training_path}"
  printf 'events=%s\n' "${event_path}"
} > "${stage}/manifest.env"

tar -C "${stage}" -czf "${archive}" manifest.env db training events
sha256sum "${archive}" > "${archive}.sha256"
chmod 0600 "${archive}" "${archive}.sha256"
echo "Backup created: ${archive}"
echo "Verify with: ${script_dir}/verify_wardy_backup.sh ${archive}"
