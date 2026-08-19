#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${edge_dir}/.." && pwd)"
env_file="${WARDY_ENV_FILE:-${edge_dir}/config/jetson.env}"

if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

absolute_from_repo() {
  if [[ "$1" == /* ]]; then
    printf '%s\n' "$1"
  else
    printf '%s/%s\n' "${repo_dir}" "$1"
  fi
}

venv_dir="$(absolute_from_repo "${WARDY_ML_VENV:-edge/.venv-ml}")"
python_bin="${venv_dir}/bin/python"
model_root="$(absolute_from_repo "${WARDY_MODEL_ROOT:-edge/models}")"
socket_path="$(absolute_from_repo "${WARDY_POSE_FALL_SOCKET:-edge/run/pose-fall.sock}")"
hazard_model="$(absolute_from_repo "${WARDY_HAZARD_MODEL:-edge/models/m05_hazard/hazard-objects-c270-finetune-v1/model.onnx}")"
hazard_confidence="${WARDY_HAZARD_CONFIDENCE:-0.5}"
database_path="$(absolute_from_repo "${WARDY_DATABASE_PATH:-edge/db/wardy.sqlite}")"
training_data_path="$(absolute_from_repo "${WARDY_TRAINING_DATA_PATH:-edge/data/training}")"
identity_match_threshold="${WARDY_IDENTITY_MATCH_THRESHOLD:-0.45}"
identity_review_threshold="${WARDY_IDENTITY_REVIEW_THRESHOLD:-0.30}"

if [[ ! -x "${python_bin}" ]]; then
  echo "Wardy ML Python environment not found: ${python_bin}" >&2
  echo "run ${script_dir}/install_pose_fall_runtime.sh first" >&2
  exit 1
fi

export PYTHONPATH="${repo_dir}/ml/src${PYTHONPATH:+:${PYTHONPATH}}"
exec "${python_bin}" "${repo_dir}/ml/src/pose_fall_worker.py" \
  --socket "${socket_path}" \
  --model-root "${model_root}" \
  --database "${database_path}" \
  --training-data "${training_data_path}" \
  --identity-match-threshold "${identity_match_threshold}" \
  --identity-review-threshold "${identity_review_threshold}" \
  --hazard-model "${hazard_model}" \
  --hazard-confidence "${hazard_confidence}"
