import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

test("Jetson 카메라는 수업과 같은 USB webcam V4L2 계약을 사용한다", async () => {
  const config = await readFile(path.join(root, "edge/src/input/camera_config.hpp"), "utf8");
  const capture = await readFile(path.join(root, "edge/src/input/camera_capture.cpp"), "utf8");

  assert.match(config, /device_index = 0/);
  assert.match(config, /buffer_size = 1/);
  assert.match(capture, /open\(impl_->config\.device_index, cv::CAP_V4L2\)/);
  assert.match(capture, /cv::CAP_PROP_FRAME_WIDTH/);
  assert.match(capture, /cv::CAP_PROP_FRAME_HEIGHT/);
  assert.match(capture, /cv::CAP_PROP_BUFFERSIZE/);
});

test("카메라 입력 모듈은 AI 추론 구현을 포함하지 않는다", async () => {
  const files = ["camera_config.hpp", "camera_capture.hpp", "camera_capture.cpp", "camera_probe.cpp"];
  for (const file of files) {
    const source = await readFile(path.join(root, "edge/src/input", file), "utf8");
    assert.doesNotMatch(source, /TensorRT|onnx|inference|detect|model/i, file);
  }
});

test("Jetson preview JPEG 인코딩은 stream client가 있을 때만 수행한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /stream_clients == 0/);
  assert.match(source, /milliseconds\(100\)/);
  assert.match(source, /cv::imencode/);
  assert.ok(source.indexOf("stream_clients == 0") < source.indexOf("cv::imencode"));
});

test("M-01 person 탐지는 capture와 분리된 최신-frame TensorRT worker를 사용한다", async () => {
  const api = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  const runtime = await readFile(path.join(root, "edge/src/inference/person_inference_runtime.cpp"), "utf8");
  const detector = await readFile(path.join(root, "edge/src/inference/person_detector.cpp"), "utf8");
  const example = await readFile(path.join(root, "edge/config/jetson.env.example"), "utf8");

  assert.match(api, /person_inference->submit/);
  assert.match(api, /pose_fall_client->infer_frame/);
  assert.match(api, /apply_tracking_results/);
  assert.match(runtime, /frame_bgr\.clone\(\)/);
  assert.match(runtime, /pending_ = PendingFrame/);
  assert.match(detector, /deserializeCudaEngine/);
  assert.match(detector, /enqueueV3/);
  assert.match(detector, /\[1,3,640,640\]/);
  assert.match(example, /WARDY_PERSON_ENGINE/);
});

test("Orin Nano WebRTC는 저지연 H264 software encode와 UDP ICE gateway를 사용한다", async () => {
  const launcher = await readFile(path.join(root, "edge/scripts/start_jetson_webrtc.sh"), "utf8");
  const gateway = await readFile(path.join(root, "edge/config/mediamtx.yml"), "utf8");
  assert.match(launcher, /x264enc tune=zerolatency speed-preset=ultrafast/);
  assert.match(launcher, /threads=2 sliced-threads=true sync-lookahead=0 rc-lookahead=0/);
  assert.match(launcher, /software_bitrate_kbps/);
  assert.match(launcher, /webrtc_bitrate % 1000 != 0/);
  assert.doesNotMatch(launcher, /nvv4l2h264enc/);
  assert.match(launcher, /video\/x-h264,profile=baseline/);
  assert.match(launcher, /rtsp:\/\/wardy-publisher:\$\{publish_token\}@127\.0\.0\.1:8554\/wardy/);
  assert.match(launcher, /appsink drop=true max-buffers=1 sync=false/);
  assert.match(gateway, /webrtcAddress: 127\.0\.0\.1:8889/);
  assert.match(gateway, /webrtcLocalUDPAddress: :8189/);
  assert.match(gateway, /webrtcLocalTCPAddress: ""/);
  assert.doesNotMatch(gateway, /webrtcAllowOrigins: \["\*"\]/);
  assert.match(gateway, /user: wardy-publisher/);
  assert.match(gateway, /user: wardy-viewer/);
});

test("Jetson 카메라는 GStreamer 단일 capture pipeline을 선택할 수 있다", async () => {
  const capture = await readFile(path.join(root, "edge/src/input/camera_capture.cpp"), "utf8");
  const service = await readFile(path.join(root, "edge/src/api/wardy_edge_service.cpp"), "utf8");
  assert.match(capture, /CAP_GSTREAMER/);
  assert.match(service, /WARDY_CAMERA_PIPELINE/);
});

test("Jetson MediaMTX 설치는 고정 ARM64 release checksum을 검증한다", async () => {
  const installer = await readFile(path.join(root, "edge/scripts/install_mediamtx.sh"), "utf8");
  const versions = await readFile(path.join(root, "edge/config/jetson-tool-versions.env"), "utf8");
  assert.match(installer, /WARDY_MEDIAMTX_VERSION/);
  assert.match(installer, /linux_arm64/);
  assert.match(versions, /^WARDY_MEDIAMTX_SHA256=[a-f0-9]{64}$/m);
  assert.match(installer, /sha256sum --check --status/);
  assert.doesNotMatch(installer, /checksums\.sha256/);
});

test("Jetson runtime 의존성은 재현 가능한 manifest와 검증 스크립트를 제공한다", async () => {
  const packages = await readFile(path.join(root, "edge/config/jetson-apt-packages.txt"), "utf8");
  const versions = await readFile(path.join(root, "edge/config/jetson-tool-versions.env"), "utf8");
  const installer = await readFile(path.join(root, "edge/scripts/install_jetson_dependencies.sh"), "utf8");
  const setup = await readFile(path.join(root, "edge/scripts/setup_jetson.sh"), "utf8");
  const launcher = await readFile(path.join(root, "edge/scripts/start_jetson_webrtc.sh"), "utf8");
  const checker = await readFile(path.join(root, "edge/scripts/check_jetson_dependencies.sh"), "utf8");
  const caddyInstaller = await readFile(path.join(root, "edge/scripts/install_caddy.sh"), "utf8");
  const tlsCreator = await readFile(path.join(root, "edge/scripts/create_jetson_tls.sh"), "utf8");

  for (const packageName of [
    "build-essential",
    "cmake",
    "libopencv-dev",
    "libsqlite3-dev",
    "gstreamer1.0-plugins-bad",
    "gstreamer1.0-tools",
    "gstreamer1.0-plugins-ugly",
    "gstreamer1.0-rtsp",
    "jq",
    "v4l-utils",
  ]) {
    assert.match(packages, new RegExp(`^${packageName.replaceAll(".", "\\.")}$`, "m"));
  }
  assert.match(versions, /^WARDY_CADDY_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(versions, /^WARDY_CADDY_SHA512=[a-f0-9]{128}$/m);
  assert.match(versions, /^WARDY_MEDIAMTX_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(versions, /^WARDY_MEDIAMTX_SHA256=[a-f0-9]{64}$/m);
  assert.match(installer, /apt-get install/);
  assert.match(installer, /nvidia-l4t-core/);
  assert.match(installer, /nvidia-l4t-gstreamer=\$\{l4t_core_version\}/);
  assert.match(installer, /l4t_gstreamer_version.*!=.*l4t_core_version/s);
  assert.match(
    installer,
    /apt-get install -y --allow-downgrades[\s\S]{0,160}"nvidia-l4t-gstreamer=\$\{l4t_core_version\}"/,
  );
  assert.doesNotMatch(packages, /^nvidia-l4t-gstreamer$/m);
  assert.match(installer, /install_caddy\.sh/);
  assert.match(installer, /install_mediamtx\.sh/);
  assert.match(installer, /check_jetson_dependencies\.sh/);
  assert.match(caddyInstaller, /linux_arm64/);
  assert.match(caddyInstaller, /sha512sum --check --status/);
  assert.doesNotMatch(caddyInstaller, /checksums\.txt/);
  assert.match(checker, /nvvidconv/);
  assert.match(checker, /x264enc/);
  assert.doesNotMatch(checker, /nvv4l2h264enc/);
  assert.match(tlsCreator, /subjectAltName=/);
  assert.match(tlsCreator, /WARDY_TLS_DIR:-\/etc\/wardy\/tls/);
  assert.match(tlsCreator, /flock -n 9/);
  assert.match(tlsCreator, /installed_artifacts/);
  assert.match(tlsCreator, /wardy-ca\.key/);
  assert.doesNotMatch(tlsCreator, /WARDY_(ACCESS|VIEWER|PUBLISH)_TOKEN=/);
  assert.match(setup, /install_jetson_dependencies\.sh/);
  assert.match(setup, /create_jetson_tls\.sh/);
  assert.match(setup, /openssl rand -hex 32/);
  assert.match(setup, /certificate_public_key_digest/);
  assert.match(setup, /private_key_public_digest/);
  assert.match(setup, /certificate_digest=.*certificate_public_key_digest/);
  assert.match(setup, /private_key_digest=.*private_key_public_digest/);
  assert.match(setup, /wardy-ca\.crt.*wardy-ca\.key/s);
  assert.match(setup, /jetson\.crt.*jetson\.key/s);
  assert.match(setup, /replace-with-\*/);
  assert.match(setup, /chmod 0600/);
  assert.match(setup, /cmake --build/);
  assert.match(setup, /check_jetson_dependencies\.sh/);
  assert.match(setup, /--no-start/);
  assert.match(setup, /install_jetson_service\.sh/);
  const serviceInstaller = await readFile(path.join(root, "edge/scripts/install_jetson_service.sh"), "utf8");
  assert.match(serviceInstaller, /wardy-edge\.service/);
  assert.match(serviceInstaller, /systemctl enable/);
  assert.match(serviceInstaller, /systemctl restart/);
  assert.match(serviceInstaller, /Restart=on-failure/);
  assert.match(serviceInstaller, /MTX_WEBRTCLOCALTCPADDRESS=:8189/);
  assert.match(launcher, /MTX_WEBRTCLOCALTCPADDRESS.*:8189/);
});

test("Jetson 일일 요약은 고정한 로컬 Qwen 모델과 안전 fallback을 사용한다", async () => {
  const source = await readFile(path.join(root, "edge/src/llm/daily_summary.cpp"), "utf8");
  const header = await readFile(path.join(root, "edge/src/llm/daily_summary.hpp"), "utf8");
  const versions = await readFile(path.join(root, "edge/config/jetson-tool-versions.env"), "utf8");
  const installer = await readFile(path.join(root, "edge/scripts/install_ollama.sh"), "utf8");
  const serviceInstaller = await readFile(path.join(root, "edge/scripts/install_jetson_service.sh"), "utf8");
  const api = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");

  assert.match(header, /model = "qwen3\.5:4b"/);
  assert.match(versions, /^WARDY_OLLAMA_VERSION=0\.32\.5$/m);
  assert.match(versions, /^WARDY_OLLAMA_INSTALL_SHA256=[a-f0-9]{64}$/m);
  assert.match(versions, /^WARDY_LLM_MODEL=qwen3\.5:4b$/m);
  assert.match(versions, /^WARDY_LLM_MODEL_DIGEST=[a-f0-9]{64}$/m);
  assert.match(installer, /sha256sum --check --status/);
  assert.match(installer, /api\/tags/);
  assert.match(installer, /jq --raw-output --arg model/);
  assert.match(installer, /--connect-timeout 5 --max-time 30/);
  assert.doesNotMatch(installer, /sed 's\/\},\{\//);
  assert.match(installer, /ollama pull "\$\{WARDY_LLM_MODEL\}"/);
  assert.match(installer, /ollama stop "\$\{WARDY_LLM_MODEL\}"/);
  assert.match(serviceInstaller, /Wants=network-online\.target ollama\.service/);
  assert.match(serviceInstaller, /After=network-online\.target ollama\.service/);
  assert.match(source, /htonl\(INADDR_LOOPBACK\)/);
  assert.match(source, /\\"keep_alive\\":\\"0s\\"/);
  assert.match(source, /\\"num_ctx\\":2048/);
  assert.match(source, /\\"num_predict\\":100,\\"temperature\\":0,\\"seed\\":7/);
  assert.match(source, /deterministic_summary/);
  assert.match(source, /invalid_output/);
  assert.doesNotMatch(source, /event\.(?:subject_name|subject_id|media_path|source_results_json|reason)/);
  assert.match(api, /path == "\/api\/llm\/daily-summary"/);
  assert.match(api, /daily_summary_mutex/);
  assert.match(api, /std::try_to_lock/);
  assert.match(api, /429, "Too Many Requests"/);
  assert.doesNotMatch(api, /list_events\(1000\)/);
});

test("Windows 연결 점검은 HTTPS Jetson health와 WHEP endpoint를 확인한다", async () => {
  const checker = await readFile(path.join(root, "edge/scripts/test_windows_connection.ps1"), "utf8");
  assert.match(checker, /:8443/);
  assert.match(checker, /\/api\/health/);
  assert.match(checker, /\/wardy\/whep/);
  assert.match(checker, /SecureString/);
  assert.match(checker, /SecureString\]\$AccessToken/);
  assert.match(checker, /\/api\/identity-reviews/);
  assert.match(checker, /Origin/);
  assert.match(checker, /catch/);
  assert.match(checker, /UDP media on port 8189/);
  assert.doesNotMatch(checker, /SSH|macOS/);
});

test("Jetson 비AI runtime 점검은 운영 데이터를 변경하지 않고 인증 API를 확인한다", async () => {
  const script = await readFile(path.join(root, "edge/scripts/test_jetson_runtime.sh"), "utf8");
  assert.match(script, /X-Wardy-Access-Token/);
  assert.match(script, /notification-settings/);
  assert.match(script, /identity-reviews/);
  assert.doesNotMatch(script,
    /--request(?:\s+|=)(?:POST|PUT|PATCH|DELETE)\b/i);
  assert.doesNotMatch(script,
    /(?:^|\s)-X\s*(?:POST|PUT|PATCH|DELETE)\b/im);
  assert.doesNotMatch(script,
    /--(?:data(?:-[a-z]+)?|form|upload-file)\b|(?:^|\s)-(?:d|F|T)(?:\s|$)/m);
});

test("Jetson 실행은 격리된 검증용 저장 경로를 허용한다", async () => {
  const script = await readFile(path.join(root, "edge/scripts/start_jetson_webrtc.sh"), "utf8");
  assert.match(script, /WARDY_DATABASE_PATH/);
  assert.match(script, /WARDY_TRAINING_DATA_PATH/);
  assert.match(script, /WARDY_EVENT_MEDIA_PATH/);
});

test("Jetson 외부 credential 경로는 Caddy TLS 하나로 통합한다", async () => {
  const caddy = await readFile(path.join(root, "edge/config/Caddyfile"), "utf8");
  const launcher = await readFile(path.join(root, "edge/scripts/start_jetson_webrtc.sh"), "utf8");
  const example = await readFile(path.join(root, "edge/config/jetson.env.example"), "utf8");
  assert.match(caddy, /auto_https disable_redirects/);
  assert.match(caddy, /default_sni \{\$WARDY_JETSON_HOST\}/);
  assert.match(caddy, /https:\/\/\{\$WARDY_JETSON_HOST\}:8443/);
  assert.match(caddy, /tls \{\$WARDY_TLS_CERTIFICATE\} \{\$WARDY_TLS_PRIVATE_KEY\}/);
  assert.match(caddy, /127\.0\.0\.1:8787/);
  assert.match(caddy, /127\.0\.0\.1:8889/);
  assert.match(launcher, /chmod 0600/);
  assert.match(example, /WARDY_ACCESS_TOKEN=/);
  assert.match(example, /WARDY_VIEWER_TOKEN=/);
  assert.match(example, /WARDY_PUBLISH_TOKEN=/);
  assert.match(example, /^WARDY_UI_ORIGIN=http:\/\/localhost:8000$/m);
  assert.doesNotMatch(example, /WINDOWS_PC_LAN_IP/);
});

test("Jetson camera 상태는 변화 시에만 SQLite에 기록한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /SqliteStore/);
  assert.match(source, /save_camera_state\(state, "connecting"/);
  assert.match(source, /save_camera_state\(state, "connected"/);
  assert.match(source, /save_camera_state\(state, "fault"/);
  assert.match(source, /connected_reported/);
  assert.match(source, /if \(!connected_reported\)/);
  assert.match(source, /retry_delay = std::chrono::seconds\(1\)/);
  assert.match(source, /std::min\(retry_delay \* 2, maximum_retry_delay\)/);
});

test("관리 물품 sample은 요청 시에만 Jetson camera frame으로 저장한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  const security = await readFile(path.join(root, "edge/src/api/request_security.hpp"), "utf8");
  assert.match(source, /method == "POST" && path == "\/api\/training\/items\/sample"/);
  assert.match(source, /sample_capture_requests/);
  assert.match(source, /add_training_sample/);
  assert.match(source, /std::filesystem::path\("items"\)/);
  assert.doesNotMatch(source, /train\(|fit\(/i);
  assert.match(security, /x-wardy-access-token/);
  assert.match(source, /origin_allowed/);
});

test("돌봄 대상자 식별 기준 사진은 Jetson 로컬에 저장한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /method == "POST" && path == "\/api\/training\/subjects\/reference"/);
  assert.match(source, /add_subject_reference_sample/);
  assert.match(source, /std::filesystem::path\("subjects"\)/);
});

test("데이터 작업실은 camera와 로컬 파일 원본을 Jetson SQLite에 연결한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  const storage = await readFile(path.join(root, "edge/src/storage/sqlite_store.cpp"), "utf8");
  assert.match(source, /path == "\/api\/data-samples\/camera"/);
  assert.match(source, /path == "\/api\/data-samples\/upload"/);
  assert.match(source, /dataset_sample_media_path/);
  assert.match(source, /get_dataset_sample/);
  const datasetFileRemoval = source.indexOf("std::filesystem::remove(stored_dataset_file");
  const datasetRecordRemoval = source.indexOf(
    "database->delete_dataset_sample", datasetFileRemoval,
  );
  assert.ok(datasetFileRemoval >= 0);
  assert.ok(datasetRecordRemoval > datasetFileRemoval);
  assert.match(source, /cv::imdecode/);
  assert.match(source, /maximum_body_size = 8 \* 1024 \* 1024/);
  assert.match(source, /std::filesystem::path\("datasets"\)/);
  assert.match(storage, /CREATE TABLE IF NOT EXISTS dataset_samples/);
  assert.match(storage, /review_status IN \('pending','approved','rejected'\)/);
  assert.doesNotMatch(source, /train\(|fit\(/i);
});

test("이벤트 상태별 자료는 Jetson 로컬에 제한적으로 저장한다", async () => {
  const media = await readFile(path.join(root, "edge/src/media/event_media.cpp"), "utf8");
  const mediaHeader = await readFile(path.join(root, "edge/src/media/event_media.hpp"), "utf8");
  const api = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  const launcher = await readFile(path.join(root, "edge/scripts/start_jetson_webrtc.sh"), "utf8");
  assert.match(media, /event\.media_type == "image"/);
  assert.match(media, /event\.media_type == "video"/);
  assert.match(mediaHeader, /before_event\{5000\}/);
  assert.match(mediaHeader, /after_event\{5000\}/);
  assert.match(media, /ring_\.size\(\) > ring_capacity_/);
  assert.match(mediaHeader, /max_workers = 2/);
  assert.match(mediaHeader, /max_pending_events = 16/);
  assert.match(media, /void EventMediaRecorder::worker_loop\(\)/);
  assert.match(media, /update_event_media/);
  assert.match(api, /const auto media_event_id = event_media_path\(path\)/);
  assert.match(api, /method == "GET" && media_event_id/);
  assert.match(api, /method == "DELETE" && media_event_id/);
  assert.match(launcher, /data\/events/);
  assert.doesNotMatch(media, /TensorRT|onnx|inference|tracking/i);
});
