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

camera_device="${WARDY_CAMERA_DEVICE:-/dev/video0}"
camera_width="${WARDY_CAMERA_WIDTH:-640}"
camera_height="${WARDY_CAMERA_HEIGHT:-480}"
camera_fps="${WARDY_CAMERA_FPS:-30}"
webrtc_bitrate="${WARDY_WEBRTC_BITRATE:-2000000}"
keyframe_interval="${WARDY_WEBRTC_KEYFRAME_INTERVAL:-15}"
mediamtx_bin="${WARDY_MEDIAMTX_BIN:-mediamtx}"
edge_service="${WARDY_EDGE_SERVICE_BIN:-${edge_dir}/build/wardy_edge_service}"

for command in "${mediamtx_bin}" gst-inspect-1.0; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 1
  fi
done

for plugin in v4l2src tee queue videoconvert nvvidconv nvv4l2h264enc h264parse rtspclientsink appsink; do
  if ! gst-inspect-1.0 "${plugin}" >/dev/null 2>&1; then
    echo "required GStreamer plugin not found: ${plugin}" >&2
    exit 1
  fi
done

if [[ ! -x "${edge_service}" ]]; then
  echo "Wardy edge service not found: ${edge_service}" >&2
  echo "build it first with: cmake -S edge -B edge/build && cmake --build edge/build" >&2
  exit 1
fi

camera_source="${WARDY_CAMERA_SOURCE:-v4l2src device=${camera_device} ! video/x-raw,width=${camera_width},height=${camera_height},framerate=${camera_fps}/1}"
export WARDY_CAMERA_PIPELINE="${camera_source} ! tee name=wardy_camera \
wardy_camera. ! queue leaky=downstream max-size-buffers=1 ! videoconvert ! video/x-raw,format=BGR ! appsink drop=true max-buffers=1 sync=false \
wardy_camera. ! queue leaky=downstream max-size-buffers=2 ! videoconvert ! nvvidconv ! video/x-raw(memory:NVMM),format=NV12 ! nvv4l2h264enc control-rate=1 bitrate=${webrtc_bitrate} iframeinterval=${keyframe_interval} insert-sps-pps=1 preset-level=1 ! video/x-h264,profile=baseline,stream-format=byte-stream,alignment=au ! h264parse config-interval=-1 ! rtspclientsink location=rtsp://127.0.0.1:8554/wardy protocols=tcp latency=0"

mkdir -p "${edge_dir}/db" "${edge_dir}/data/training"

"${mediamtx_bin}" "${edge_dir}/config/mediamtx.yml" &
mediamtx_pid=$!
cleanup() {
  kill "${mediamtx_pid}" 2>/dev/null || true
  wait "${mediamtx_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in {1..50}; do
  if (exec 3<>/dev/tcp/127.0.0.1/8554) 2>/dev/null; then
    exec 3>&-
    break
  fi
  if ! kill -0 "${mediamtx_pid}" 2>/dev/null; then
    echo "MediaMTX stopped before opening the RTSP listener" >&2
    exit 1
  fi
  sleep 0.1
done

cd "${repo_dir}"
"${edge_service}" 8787 0 "${camera_width}" "${camera_height}" \
  "${edge_dir}/db/wardy.sqlite" "${edge_dir}/data/training"
