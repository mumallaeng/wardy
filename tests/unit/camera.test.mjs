import test from "node:test";
import assert from "node:assert/strict";

import { jetsonWebRtcStreamUrl, jetsonWhepUrl } from "../../apps/js/camera.ts";

test("Jetson WebRTC stream URL을 edge base URL에서 만든다", () => {
  assert.equal(
    jetsonWebRtcStreamUrl("https://jetson.local:8443/"),
    "https://jetson.local:8443/wardy?controls=false&muted=true&autoplay=true&playsInline=true&disablepictureinpicture=true",
  );
  assert.equal(
    jetsonWebRtcStreamUrl("", "https://192.168.0.30:8443"),
    "https://192.168.0.30:8443/wardy?controls=false&muted=true&autoplay=true&playsInline=true&disablepictureinpicture=true",
  );
  assert.equal(
    jetsonWebRtcStreamUrl("http://172.16.1.252:8088"),
    "http://172.16.1.252:8088/wardy?controls=false&muted=true&autoplay=true&playsInline=true&disablepictureinpicture=true",
  );
});

test("Jetson WHEP endpoint를 만든다", () => {
  assert.equal(jetsonWhepUrl("https://jetson.local:8443/"), "https://jetson.local:8443/wardy/whep");
  assert.equal(jetsonWhepUrl("http://172.16.1.252:8088/"), "http://172.16.1.252:8088/wardy/whep");
});
