import test from "node:test";
import assert from "node:assert/strict";

import { jetsonWebRtcStreamUrl, jetsonWhepUrl } from "../../apps/js/camera.ts";

test("Jetson WebRTC stream URL을 edge base URL에서 만든다", () => {
  assert.equal(
    jetsonWebRtcStreamUrl("http://jetson.local:8787/"),
    "http://jetson.local:8889/wardy?controls=false&muted=true&autoplay=true&playsInline=true&disablepictureinpicture=true",
  );
  assert.equal(
    jetsonWebRtcStreamUrl("", "http://192.168.0.30:8787"),
    "http://192.168.0.30:8889/wardy?controls=false&muted=true&autoplay=true&playsInline=true&disablepictureinpicture=true",
  );
});

test("Jetson WHEP endpoint를 만든다", () => {
  assert.equal(jetsonWhepUrl("http://jetson.local:8787/"), "http://jetson.local:8889/wardy/whep");
});
