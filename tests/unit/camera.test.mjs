import test from "node:test";
import assert from "node:assert/strict";

import { jetsonCameraStreamUrl } from "../../apps/js/camera.ts";

test("Jetson camera stream URL을 base URL에서 만든다", () => {
  assert.equal(jetsonCameraStreamUrl("http://jetson.local:8787/"), "http://jetson.local:8787/api/camera/stream");
  assert.equal(jetsonCameraStreamUrl("", "http://192.168.0.30:8787"), "http://192.168.0.30:8787/api/camera/stream");
});
