#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
edge_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${edge_dir}/.." && pwd)"
env_file="${WARDY_ENV_FILE:-${edge_dir}/config/jetson.env}"

if [[ -f "${env_file}" ]]; then
  chmod 0600 "${env_file}"
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
ui_origin="${WARDY_UI_ORIGIN:-}"
access_token="${WARDY_ACCESS_TOKEN:-}"
viewer_token="${WARDY_VIEWER_TOKEN:-}"
publish_token="${WARDY_PUBLISH_TOKEN:-}"
jetson_host="${WARDY_JETSON_HOST:-}"
tls_certificate="${WARDY_TLS_CERTIFICATE:-}"
tls_private_key="${WARDY_TLS_PRIVATE_KEY:-}"
bundled_mediamtx="${edge_dir}/tools/mediamtx"
if [[ -x "${bundled_mediamtx}" ]]; then
  default_mediamtx="${bundled_mediamtx}"
else
  default_mediamtx="mediamtx"
fi
mediamtx_bin="${WARDY_MEDIAMTX_BIN:-${default_mediamtx}}"
bundled_caddy="${edge_dir}/tools/caddy"
if [[ -x "${bundled_caddy}" ]]; then
  default_caddy="${bundled_caddy}"
else
  default_caddy="caddy"
fi
caddy_bin="${WARDY_CADDY_BIN:-${default_caddy}}"
edge_service="${WARDY_EDGE_SERVICE_BIN:-${edge_dir}/build/wardy_edge_service}"
database_path="${WARDY_DATABASE_PATH:-${edge_dir}/db/wardy.sqlite}"
training_data_path="${WARDY_TRAINING_DATA_PATH:-${edge_dir}/data/training}"
event_media_path="${WARDY_EVENT_MEDIA_PATH:-${edge_dir}/data/events}"

if [[ -z "${ui_origin}" || -z "${access_token}" || -z "${viewer_token}" ||
      -z "${publish_token}" || -z "${jetson_host}" || -z "${tls_certificate}" ||
      -z "${tls_private_key}" ]]; then
  echo "Wardy UI origin, three tokens, Jetson host, and TLS certificate paths are required" >&2
  exit 1
fi
if [[ ! "${access_token}" =~ ^[A-Za-z0-9._~-]+$ ||
      ! "${viewer_token}" =~ ^[A-Za-z0-9._~-]+$ ||
      ! "${publish_token}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "Wardy tokens may contain only URL-safe unreserved characters" >&2
  exit 1
fi
for tls_file in "${tls_certificate}" "${tls_private_key}"; do
  if [[ ! -r "${tls_file}" ]]; then
    echo "TLS file is not readable: ${tls_file}" >&2
    echo "create local TLS files with: ${edge_dir}/scripts/create_jetson_tls.sh ${jetson_host}" >&2
    exit 1
  fi
done
chmod 0600 "${tls_private_key}"

for command in "${mediamtx_bin}" "${caddy_bin}" gst-inspect-1.0; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 1
  fi
done

for plugin in v4l2src tee queue videoconvert nvvidconv x264enc h264parse rtspclientsink appsink; do
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
if [[ ! "${webrtc_bitrate}" =~ ^[0-9]+$ ]] ||
   (( webrtc_bitrate < 1000 || webrtc_bitrate % 1000 != 0 )); then
  echo "WARDY_WEBRTC_BITRATE must be an integer multiple of 1000 bits per second" >&2
  exit 1
fi
software_bitrate_kbps=$((webrtc_bitrate / 1000))
export WARDY_CAMERA_PIPELINE="${camera_source} ! tee name=wardy_camera \
wardy_camera. ! queue leaky=downstream max-size-buffers=1 ! videoconvert ! video/x-raw,format=BGR ! appsink drop=true max-buffers=1 sync=false \
wardy_camera. ! queue leaky=downstream max-size-buffers=2 ! nvvidconv ! video/x-raw,format=I420 ! x264enc tune=zerolatency speed-preset=ultrafast bitrate=${software_bitrate_kbps} key-int-max=${keyframe_interval} bframes=0 threads=2 sliced-threads=true sync-lookahead=0 rc-lookahead=0 byte-stream=true ! video/x-h264,profile=baseline,stream-format=byte-stream,alignment=au ! h264parse config-interval=-1 ! rtspclientsink location=rtsp://wardy-publisher:${publish_token}@127.0.0.1:8554/wardy protocols=tcp latency=0"

ensure_private_directory() {
  local directory="$1"
  if [[ -e "${directory}" && ! -d "${directory}" ]]; then
    echo "Wardy storage path is not a directory: ${directory}" >&2
    exit 1
  fi
  if [[ ! -e "${directory}" ]]; then
    mkdir -p "${directory}"
    chmod 0700 "${directory}"
  fi
  local owner mode
  owner="$(stat -c '%u' "${directory}")"
  mode="$(stat -c '%a' "${directory}")"
  if [[ "${owner}" != "$(id -u)" || ! "${mode}" =~ ^[0-7]+$ || $((8#${mode} & 077)) -ne 0 ]]; then
    echo "Wardy storage directory must be owned by the service user and deny group/other access: ${directory}" >&2
    exit 1
  fi
}

ensure_private_directory "$(dirname "${database_path}")"
ensure_private_directory "${training_data_path}"
ensure_private_directory "${event_media_path}"

export MTX_WEBRTCALLOWORIGINS="${ui_origin}"
export MTX_WEBRTCLOCALTCPADDRESS="${MTX_WEBRTCLOCALTCPADDRESS:-:8189}"
export MTX_AUTHINTERNALUSERS_0_PASS="${publish_token}"
export MTX_AUTHINTERNALUSERS_1_PASS="${viewer_token}"
export MTX_AUTHINTERNALUSERS_1_IPS="127.0.0.1,::1"
export WARDY_JETSON_HOST="${jetson_host}"
export WARDY_TLS_CERTIFICATE="${tls_certificate}"
export WARDY_TLS_PRIVATE_KEY="${tls_private_key}"

"${caddy_bin}" validate --config "${edge_dir}/config/Caddyfile" --adapter caddyfile

"${mediamtx_bin}" "${edge_dir}/config/mediamtx.yml" &
mediamtx_pid=$!
cleanup() {
  if [[ -n "${caddy_pid:-}" ]]; then kill "${caddy_pid}" 2>/dev/null || true; fi
  if [[ -n "${edge_pid:-}" ]]; then kill "${edge_pid}" 2>/dev/null || true; fi
  kill "${mediamtx_pid}" 2>/dev/null || true
  if [[ -n "${caddy_pid:-}" ]]; then wait "${caddy_pid}" 2>/dev/null || true; fi
  if [[ -n "${edge_pid:-}" ]]; then wait "${edge_pid}" 2>/dev/null || true; fi
  wait "${mediamtx_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rtsp_ready=false
for _ in {1..50}; do
  if (exec 3<>/dev/tcp/127.0.0.1/8554) 2>/dev/null; then
    exec 3>&-
    if kill -0 "${mediamtx_pid}" 2>/dev/null; then
      rtsp_ready=true
      break
    fi
  fi
  if ! kill -0 "${mediamtx_pid}" 2>/dev/null; then
    echo "MediaMTX stopped before opening the RTSP listener" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "${rtsp_ready}" != true ]]; then
  echo "MediaMTX did not open the RTSP listener within 5 seconds" >&2
  exit 1
fi

cd "${repo_dir}"
"${edge_service}" 8787 0 "${camera_width}" "${camera_height}" \
  "${database_path}" "${training_data_path}" "${event_media_path}" &
edge_pid=$!
"${caddy_bin}" run --config "${edge_dir}/config/Caddyfile" --adapter caddyfile &
caddy_pid=$!

wait -n "${edge_pid}" "${caddy_pid}" "${mediamtx_pid}"
