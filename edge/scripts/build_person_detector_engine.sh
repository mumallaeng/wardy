#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <person_detector.onnx> [output.engine] [--force]" >&2
}

if (( $# < 1 || $# > 3 )); then
  usage
  exit 1
fi

onnx_path="$1"
engine_path="${2:-${onnx_path%.*}.engine}"
force=false

if [[ "${2:-}" == "--force" ]]; then
  if (( $# != 2 )); then
    usage
    exit 1
  fi
  engine_path="${onnx_path%.*}.engine"
  force=true
elif [[ "${3:-}" == "--force" ]]; then
  force=true
elif (( $# == 3 )); then
  usage
  exit 1
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "TensorRT engine must be built on the target Jetson (Linux aarch64)" >&2
  exit 1
fi
if [[ ! -f "${onnx_path}" ]]; then
  echo "ONNX model not found: ${onnx_path}" >&2
  exit 1
fi
if [[ "${onnx_path##*.}" != "onnx" ]]; then
  echo "input model must have the .onnx extension: ${onnx_path}" >&2
  exit 1
fi
if [[ -e "${engine_path}" && "${force}" != true ]]; then
  echo "engine already exists: ${engine_path}" >&2
  echo "pass --force to replace it" >&2
  exit 1
fi

if command -v trtexec >/dev/null 2>&1; then
  trtexec_bin="$(command -v trtexec)"
elif [[ -x /usr/src/tensorrt/bin/trtexec ]]; then
  trtexec_bin=/usr/src/tensorrt/bin/trtexec
else
  echo "trtexec was not found; install TensorRT from the JetPack repository" >&2
  exit 1
fi

mkdir -p "$(dirname "${engine_path}")"
if [[ -e "${engine_path}" ]]; then
  rm -f -- "${engine_path}"
fi

echo "Building FP16 TensorRT engine on $(uname -m)"
echo "ONNX:   ${onnx_path}"
echo "Engine: ${engine_path}"

cleanup_partial_engine() {
  local status=$?
  if (( status != 0 )); then
    rm -f -- "${engine_path}"
  fi
  exit "${status}"
}
trap cleanup_partial_engine EXIT

"${trtexec_bin}" --onnx="${onnx_path}" --saveEngine="${engine_path}" --fp16

if [[ ! -s "${engine_path}" ]]; then
  echo "TensorRT engine was not created: ${engine_path}" >&2
  exit 1
fi
trap - EXIT

echo "Validating the generated engine"
"${trtexec_bin}" --loadEngine="${engine_path}" --warmUp=500 --duration=5

echo "TensorRT engine ready: ${engine_path}"
