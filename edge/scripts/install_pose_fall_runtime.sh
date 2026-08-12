#!/usr/bin/env bash
set -euo pipefail

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
model_root="$(absolute_from_repo "${WARDY_MODEL_ROOT:-edge/models}")"
python_bin="${venv_dir}/bin/python"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "Wardy pose/fall runtime installation requires Linux aarch64" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

python3 -m venv --system-site-packages "${venv_dir}"
"${python_bin}" -m pip install --upgrade pip
"${python_bin}" -m pip install -r "${repo_dir}/ml/requirements/runtime.txt"
"${python_bin}" - <<'PY'
import cv2
import numpy
import onnxruntime

print(
    "Wardy Python dependencies:",
    f"opencv={cv2.__version__}",
    f"numpy={numpy.__version__}",
    f"onnxruntime={onnxruntime.__version__}",
)
PY

install_args=(
  "${repo_dir}/ml/src/model_manager.py"
  --model-root "${model_root}"
  install m03_pose
)
if [[ -n "${WARDY_M03_MODEL_VERSION:-}" ]]; then
  install_args+=(--version "${WARDY_M03_MODEL_VERSION}")
fi
"${python_bin}" "${install_args[@]}"

install_args=(
  "${repo_dir}/ml/src/model_manager.py"
  --model-root "${model_root}"
  install m04_fall
)
if [[ -n "${WARDY_M04_MODEL_VERSION:-}" ]]; then
  install_args+=(--version "${WARDY_M04_MODEL_VERSION}")
fi
if [[ -n "${WARDY_M04_MODEL_SOURCE_DIR:-}" ]]; then
  install_args+=(--source-dir "$(absolute_from_repo "${WARDY_M04_MODEL_SOURCE_DIR}")")
fi
"${python_bin}" "${install_args[@]}"

WARDY_MODEL_ROOT="${model_root}" PYTHONPATH="${repo_dir}/ml/src" "${python_bin}" - <<'PY'
from pathlib import Path
import os
from pose_fall_worker import build_runtime

build_runtime(Path(os.environ["WARDY_MODEL_ROOT"]))
print("Wardy M-03/M-04 runtime is ready")
PY
