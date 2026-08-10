import assert from "node:assert/strict";
import test from "node:test";

import { WardyRuntimeClient } from "../../apps/js/runtime.ts";

const state = {
  care_state: "normal", camera_state: "connected", detection_state: "disconnected",
  event_state: "ready", reason: "ready", updated_at: "2026-08-10T00:00:00Z",
};

test("Jetson runtime snapshot과 등록 목록을 인증 API에서 읽는다", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/state")) return Response.json(state);
    if (String(url).endsWith("/api/events")) return Response.json({ events: [] });
    if (String(url).endsWith("/api/subjects")) return Response.json({ subjects: [] });
    return Response.json({ managedItems: [] });
  };
  const client = new WardyRuntimeClient(fetchImpl);
  const snapshot = await client.loadSnapshot("https://10.10.20.40:8443", "token", "https://ui.local");
  const collections = await client.loadCollections("https://10.10.20.40:8443", "token", "https://ui.local");
  assert.equal(snapshot.state.camera_state, "connected");
  assert.deepEqual(collections, { subjects: [], managedItems: [] });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.init.headers["X-Wardy-Access-Token"] === "token"));
});

test("Jetson runtime WebSocket은 전용 protocol과 탭 token으로 연결한다", () => {
  let opened;
  class FakeSocket extends EventTarget {
    close() { this.dispatchEvent(new Event("close")); }
  }
  const client = new WardyRuntimeClient(undefined, (url, protocols) => {
    opened = { url, protocols };
    return new FakeSocket();
  });
  client.connect("https://10.10.20.40:8443", "session-token", "https://ui.local", () => {});
  assert.equal(opened.url, "wss://10.10.20.40:8443/api/ws");
  assert.deepEqual(opened.protocols, ["wardy-events", "session-token"]);
  client.stop();
});
