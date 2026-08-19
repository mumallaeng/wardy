#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${edge_dir}/.." && pwd)"

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
ultralytics_image="${WARDY_ULTRALYTICS_IMAGE:-ultralytics/ultralytics@sha256:ac003d6ea1b127ffcc09113abe288c07854c70bd6f092b31e3667e9ff60ee79b}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "Wardy YOLO deployment preparation requires Linux aarch64" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "required command not found: docker" >&2
  exit 1
fi
if [[ ! -x "${python_bin}" ]]; then
  echo "Wardy ML Python environment not found: ${python_bin}" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is unavailable to the current user" >&2
  exit 1
fi
if ! docker info --format '{{json .Runtimes}}' | grep -q '"nvidia"'; then
  echo "NVIDIA container runtime is required for the JetPack export image" >&2
  exit 1
fi

install_model() {
  "${python_bin}" "${repo_dir}/ml/src/model_manager.py" \
    --model-root "${model_root}" install "$1"
}

export_onnx() {
  local model_dir="$1"
  local model_pt="${model_dir}/model.pt"
  local model_onnx="${model_dir}/model.onnx"
  if [[ -s "${model_onnx}" && "${model_onnx}" -nt "${model_pt}" ]]; then
    printf '%s\n' "${model_onnx}"
    return
  fi
  docker run --rm --pull=missing --runtime=nvidia --ipc=host \
    --user "$(id -u):$(id -g)" \
    -e YOLO_CONFIG_DIR=/tmp/ultralytics \
    -v "${model_dir}:/models" \
    "${ultralytics_image}" \
    python -c 'from ultralytics import YOLO; YOLO("/models/model.pt").export(format="onnx", imgsz=640, dynamic=False, simplify=True, opset=12)'
  if [[ ! -s "${model_onnx}" ]]; then
    echo "Ultralytics did not create the expected ONNX file: ${model_onnx}" >&2
    exit 1
  fi
  printf '%s\n' "${model_onnx}"
}

m01_dir="$(install_model m01_person)"
m05_dir="$(install_model m05_hazard)"
m01_onnx="$(export_onnx "${m01_dir}" | tail -n 1)"
m05_onnx="$(export_onnx "${m05_dir}" | tail -n 1)"
m01_engine="${m01_dir}/model.engine"

if [[ ! -s "${m01_engine}" || "${m01_engine}" -ot "${m01_onnx}" ]]; then
  "${script_dir}/build_person_detector_engine.sh" \
    "${m01_onnx}" "${m01_engine}" --force
fi

printf 'Wardy M-01 TensorRT engine: %s\n' "${m01_engine}"
printf 'Wardy M-05 ONNX model: %s\n' "${m05_onnx}"
