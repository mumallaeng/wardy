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

write_provenance() {
  local destination="$1"
  local content="$2"
  local temporary="${destination}.tmp"
  printf '%s\n' "${content}" > "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

export_onnx() {
  local model_dir="$1"
  local model_pt="${model_dir}/model.pt"
  local model_onnx="${model_dir}/model.onnx"
  local provenance_path="${model_onnx}.provenance"
  local provenance
  provenance="$(printf '%s\n' \
    "model_sha256=$(sha256sum "${model_pt}" | awk '{print $1}')" \
    "exporter_image=${ultralytics_image}" \
    "export_format=onnx" \
    "imgsz=640" \
    "dynamic=false" \
    "simplify=true" \
    "opset=12")"
  if [[ -s "${model_onnx}" && "${model_onnx}" -nt "${model_pt}" &&
        -f "${provenance_path}" &&
        "$(<"${provenance_path}")" == "${provenance}" ]]; then
    printf '%s\n' "${model_onnx}"
    return
  fi
  rm -f -- "${model_onnx}" "${provenance_path}"
  docker run --rm --pull=missing --runtime=nvidia --ipc=host \
    --user "$(id -u):$(id -g)" \
    -e YOLO_CONFIG_DIR=/tmp/ultralytics \
    -e MPLCONFIGDIR=/tmp/matplotlib \
    -e XDG_CACHE_HOME=/tmp/cache \
    -v "${model_dir}:/models" \
    "${ultralytics_image}" \
    python -c 'from ultralytics import YOLO; YOLO("/models/model.pt").export(format="onnx", imgsz=640, dynamic=False, simplify=True, opset=12)'
  if [[ ! -s "${model_onnx}" ]]; then
    echo "Ultralytics did not create the expected ONNX file: ${model_onnx}" >&2
    exit 1
  fi
  write_provenance "${provenance_path}" "${provenance}"
  printf '%s\n' "${model_onnx}"
}

m01_dir="$(install_model m01_person)"
m05_dir="$(install_model m05_hazard)"
m01_onnx="$(export_onnx "${m01_dir}" | tail -n 1)"
m05_onnx="$(export_onnx "${m05_dir}" | tail -n 1)"
m01_engine="${m01_dir}/model.engine"
m01_engine_provenance="${m01_engine}.provenance"
tensorrt_version="$(dpkg-query -W -f='${Version}' libnvinfer10 2>/dev/null || printf unknown)"
jetpack_version="$(dpkg-query -W -f='${Version}' nvidia-l4t-core 2>/dev/null || printf unknown)"
engine_provenance="$(printf '%s\n' \
  "onnx_sha256=$(sha256sum "${m01_onnx}" | awk '{print $1}')" \
  "tensorrt_version=${tensorrt_version}" \
  "jetpack_l4t_version=${jetpack_version}" \
  "build_precision=fp16" \
  "build_script_sha256=$(sha256sum "${script_dir}/build_person_detector_engine.sh" | awk '{print $1}')")"

if [[ ! -s "${m01_engine}" || "${m01_engine}" -ot "${m01_onnx}" ||
      ! -f "${m01_engine_provenance}" ||
      "$(<"${m01_engine_provenance}")" != "${engine_provenance}" ]]; then
  rm -f -- "${m01_engine_provenance}"
  "${script_dir}/build_person_detector_engine.sh" \
    "${m01_onnx}" "${m01_engine}" --force
  write_provenance "${m01_engine_provenance}" "${engine_provenance}"
fi

printf 'Wardy M-01 TensorRT engine: %s\n' "${m01_engine}"
printf 'Wardy M-05 ONNX model: %s\n' "${m05_onnx}"
