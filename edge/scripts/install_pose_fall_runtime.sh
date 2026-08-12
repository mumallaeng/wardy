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
hazard_model="$(absolute_from_repo "${WARDY_HAZARD_MODEL:-edge/models/m05_hazard/hazard-objects-v2-finetune-v3/model.onnx}")"
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
import scipy

print(
    "Wardy Python dependencies:",
    f"opencv={cv2.__version__}",
    f"numpy={numpy.__version__}",
    f"onnxruntime={onnxruntime.__version__}",
    f"scipy={scipy.__version__}",
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

WARDY_ML_VENV="${venv_dir}" WARDY_MODEL_ROOT="${model_root}" \
  "${script_dir}/prepare_yolo_models.sh"

for identity_model in m02_face_detector m02_face_recognizer; do
  "${python_bin}" "${repo_dir}/ml/src/model_manager.py" \
    --model-root "${model_root}" install "${identity_model}"
done

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

WARDY_MODEL_ROOT="${model_root}" WARDY_HAZARD_MODEL="${hazard_model}" \
PYTHONPATH="${repo_dir}/ml/src" "${python_bin}" - <<'PY'
from pathlib import Path
import os
from m05_hazard import HazardDetector
from model_manager import install_model

model_root = Path(os.environ["WARDY_MODEL_ROOT"])
for model_id in (
    "m01_person",
    "m02_face_detector",
    "m02_face_recognizer",
    "m03_pose",
    "m04_fall",
    "m05_hazard",
):
    install_model(model_id, model_root=model_root)
HazardDetector(Path(os.environ["WARDY_HAZARD_MODEL"]))
print("Wardy M-02 identity/M-03/M-04/M-05 runtime is ready")
PY
