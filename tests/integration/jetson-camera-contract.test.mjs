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

test("Jetson WebRTC는 H264 hardware encode와 UDP ICE gateway를 사용한다", async () => {
  const launcher = await readFile(path.join(root, "edge/scripts/start_jetson_webrtc.sh"), "utf8");
  const gateway = await readFile(path.join(root, "edge/config/mediamtx.yml"), "utf8");
  assert.match(launcher, /nvv4l2h264enc/);
  assert.match(launcher, /video\/x-h264,profile=baseline/);
  assert.match(launcher, /rtsp:\/\/wardy-publisher:\$\{publish_token\}@127\.0\.0\.1:8554\/wardy/);
  assert.match(launcher, /appsink drop=true max-buffers=1 sync=false/);
  assert.match(gateway, /webrtcAddress: :8889/);
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
  assert.match(installer, /WARDY_MEDIAMTX_VERSION:-1\.18\.2/);
  assert.match(installer, /linux_arm64/);
  assert.match(installer, /checksums\.sha256/);
  assert.match(installer, /sha256sum --check --status/);
});

test("Windows 연결 점검은 Jetson health와 WebRTC endpoint를 확인한다", async () => {
  const checker = await readFile(path.join(root, "edge/scripts/test_windows_connection.ps1"), "utf8");
  assert.match(checker, /:8787\/api\/health/);
  assert.match(checker, /:8889\/wardy/);
  assert.match(checker, /UDP port 8189/);
  assert.doesNotMatch(checker, /SSH|macOS/);
});

test("Jetson camera 상태는 변화 시에만 SQLite에 기록한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /SqliteStore/);
  assert.match(source, /save_camera_state\(state, "connecting"/);
  assert.match(source, /save_camera_state\(state, "connected"/);
  assert.match(source, /save_camera_state\(state, "fault"/);
  const captureFunction = source.slice(source.indexOf("void capture_frames"));
  const frameLoop = captureFunction.slice(
    captureFunction.indexOf("while (state->running) {", captureFunction.indexOf("camera.open()")),
    captureFunction.indexOf("camera.close()"),
  );
  assert.doesNotMatch(frameLoop, /save_system_state|save_camera_state/);
});

test("관리 물품 sample은 요청 시에만 Jetson camera frame으로 저장한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /POST \/api\/training\/items\/sample/);
  assert.match(source, /sample_capture_requests/);
  assert.match(source, /add_training_sample/);
  assert.match(source, /std::filesystem::path\("items"\)/);
  assert.doesNotMatch(source, /TensorRT|onnx|train\(|fit\(/i);
  assert.match(source, /x-wardy-access-token/);
  assert.match(source, /origin_allowed/);
});

test("돌봄 대상자 식별 기준 사진은 Jetson 로컬에 저장한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /POST \/api\/training\/subjects\/reference/);
  assert.match(source, /add_subject_reference_sample/);
  assert.match(source, /std::filesystem::path\("subjects"\)/);
});
