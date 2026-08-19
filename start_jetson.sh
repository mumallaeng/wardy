#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${repo_dir}"
step="시작 준비"

help_on_failure() {
  local status=$?
  echo >&2
  echo "[실패] ${step}" >&2
  echo "다음 명령으로 상태를 확인하세요:" >&2
  echo "  systemctl --no-pager --full status wardy-pose-fall.service wardy-edge.service" >&2
  echo "  journalctl -u wardy-pose-fall.service -u wardy-edge.service --since '10 minutes ago' --no-pager" >&2
  echo "  ls -l /dev/video0 && v4l2-ctl --list-devices" >&2
  echo "  ./edge/scripts/check_jetson_dependencies.sh" >&2
  echo "복구 후 다시 실행: ./start_jetson.sh" >&2
  exit "${status}"
}
trap help_on_failure ERR

detect_ip() {
  local detected
  detected="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  if [[ -z "${detected}" ]]; then
    detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  [[ -n "${detected}" ]] || return 1
  printf '%s\n' "${detected}"
}

run_with_heartbeat() {
  local message="$1"
  shift
  "$@" &
  local task_pid=$!
  local elapsed=0
  while kill -0 "${task_pid}" 2>/dev/null; do
    sleep 20
    elapsed=$((elapsed + 20))
    if kill -0 "${task_pid}" 2>/dev/null; then
      echo "${message} Elapsed: ${elapsed}s"
    fi
  done
  wait "${task_pid}"
}

jetson_host="${1:-${WARDY_JETSON_HOST:-$(detect_ip)}}"
ui_origin="${WARDY_UI_ORIGIN:-http://localhost:8000}"
env_file="edge/config/jetson.env"

if [[ ! -f "${env_file}" || ! -x edge/build/wardy_edge_service || ! -f /etc/systemd/system/wardy-edge.service ]]; then
  step="Jetson 최초 setup"
  echo "Starting Wardy initial setup. This runs only on the first installation."
  echo "Model download and TensorRT engine generation can take several minutes."
  run_with_heartbeat \
    "Initial setup is still running. Model preparation can take several minutes." \
    ./edge/scripts/setup_jetson.sh "${jetson_host}" "${ui_origin}"
else
  configured_host="$(sed -n 's/^WARDY_JETSON_HOST=//p' "${env_file}" | head -n 1)"
  if [[ -n "${configured_host}" ]]; then jetson_host="${configured_host}"; fi
  step="Edge 빌드"
  echo "Building the Wardy edge service. The first build can take a few minutes."
  cmake -S edge -B edge/build
  cmake --build edge/build -j"$(nproc)"
  step="Wardy 서비스 시작"
  sudo systemctl restart wardy-pose-fall.service wardy-edge.service
fi

step="서비스 활성 상태 확인"
systemctl is-active --quiet wardy-pose-fall.service
systemctl is-active --quiet wardy-edge.service

step="Jetson health 확인"
for _ in {1..30}; do
  if curl --silent --show-error --fail --max-time 3 \
      --cacert /etc/wardy/tls/wardy-ca.crt \
      "https://${jetson_host}:8443/api/health" >/tmp/wardy-health.json; then
    break
  fi
  sleep 1
done
grep -q '"camera":"connected"' /tmp/wardy-health.json

trap - ERR
echo
echo "Wardy Jetson 준비 완료"
echo "  Jetson 주소: https://${jetson_host}:8443"
echo "  카메라: 연결됨"
echo "  UI Origin: ${ui_origin}"
echo "  로그: journalctl -u wardy-pose-fall.service -u wardy-edge.service -f"
