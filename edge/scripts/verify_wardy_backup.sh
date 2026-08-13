#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# != 1 )); then
  echo "usage: $0 <wardy-backup.tar.gz>" >&2
  exit 1
fi
archive="$(realpath "$1")"
checksum="${archive}.sha256"
[[ -f "${archive}" ]] || { echo "backup not found: ${archive}" >&2; exit 1; }
[[ -f "${checksum}" ]] || { echo "checksum not found: ${checksum}" >&2; exit 1; }

(cd "$(dirname "${archive}")" && sha256sum -c "$(basename "${checksum}")")
stage="$(mktemp -d)"
trap 'rm -rf -- "${stage}"' EXIT
tar -C "${stage}" -xzf "${archive}"
grep -qx 'format=wardy-backup-v1' "${stage}/manifest.env"
if [[ -f "${stage}/db/wardy.sqlite" ]]; then
  integrity="$(sqlite3 "${stage}/db/wardy.sqlite" 'PRAGMA integrity_check;')"
  [[ "${integrity}" == "ok" ]] || { echo "SQLite integrity check failed: ${integrity}" >&2; exit 1; }
fi
echo "Backup verified: ${archive}"
