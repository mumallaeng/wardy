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

test("Jetson camera 상태는 변화 시에만 SQLite에 기록한다", async () => {
  const source = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(source, /SqliteStore/);
  assert.match(source, /save_camera_state\(state, "connecting"/);
  assert.match(source, /save_camera_state\(state, "connected"/);
  assert.match(source, /save_camera_state\(state, "fault"/);
  const captureFunction = source.slice(source.indexOf("void capture_frames"));
  const captureLoop = captureFunction.slice(captureFunction.indexOf("while (state->running)"), captureFunction.indexOf("camera.close()"));
  assert.doesNotMatch(captureLoop, /save_system_state|save_camera_state/);
});
