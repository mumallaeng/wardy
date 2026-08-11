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
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
});

test("Jetson runtime WebSocket은 payload를 선별하고 지수 backoff로 한 번만 재연결한다", () => {
  const opened = [];
  const scheduled = [];
  const cancelled = [];
  const snapshots = [];
  class FakeSocket extends EventTarget {
    close() { this.dispatchEvent(new Event("close")); }
  }
  const client = new WardyRuntimeClient(
    undefined,
    (url, protocols) => {
      const socket = new FakeSocket();
      opened.push({ url, protocols, socket });
      return socket;
    },
    (callback, delay) => {
      const handle = { callback, delay };
      scheduled.push(handle);
      return handle;
    },
    (handle) => cancelled.push(handle),
    () => 0.5,
  );
  client.connect("https://10.10.20.40:8443", "session-token", "https://ui.local", (snapshot) => snapshots.push(snapshot));
  assert.equal(opened[0].url, "wss://10.10.20.40:8443/api/ws");
  assert.deepEqual(opened[0].protocols, ["wardy-events", "session-token"]);

  opened[0].socket.dispatchEvent(new Event("open"));
  assert.equal(client.isConnected(), true);
  opened[0].socket.dispatchEvent(new MessageEvent("message", { data: "not-json" }));
  opened[0].socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "other" }) }));
  opened[0].socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "snapshot", state, events: [] }),
  }));
  assert.deepEqual(snapshots, [{ state, events: [] }]);

  opened[0].socket.dispatchEvent(new Event("close"));
  opened[0].socket.dispatchEvent(new Event("close"));
  assert.equal(client.isConnected(), false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 2_000);

  client.stop();
  assert.deepEqual(cancelled, [scheduled[0]]);
  assert.equal(client.isConnected(), false);
});

test("이벤트 자료 조회와 삭제는 인증된 Jetson API를 사용한다", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return init?.method === "DELETE" ? Response.json({ deleted: true })
      : new Response(new Blob(["media"], { type: "image/jpeg" }));
  };
  const client = new WardyRuntimeClient(fetchImpl);
  const blob = await client.loadEventMedia("https://jetson.local:8443", "token", "", "EVT-1");
  await client.deleteEventMedia("https://jetson.local:8443", "token", "", "EVT-1");
  assert.equal(blob.type, "image/jpeg");
  assert.equal(calls[0].url, "https://jetson.local:8443/api/events/EVT-1/media");
  assert.equal(calls[1].init.method, "DELETE");
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
});

test("오늘의 이벤트 요약은 인증된 Jetson LLM endpoint를 사용한다", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      summary: "오늘 기록된 안전 확인 이벤트가 없습니다.",
      model: "qwen3.5:4b",
      fallback: true,
      fallback_reason: "no_events",
      event_count: 0,
      unconfirmed_count: 0,
      duration_ms: 0,
    });
  };
  const client = new WardyRuntimeClient(fetchImpl);
  const result = await client.loadDailySummary(
    "https://jetson.local:8443", "token", "", "2026-08-11",
  );
  assert.equal(result.model, "qwen3.5:4b");
  assert.equal(calls[0].url, "https://jetson.local:8443/api/llm/daily-summary");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Wardy-Access-Token"], "token");
  assert.equal(calls[0].init.headers["X-Wardy-Summary-Date"], "2026-08-11");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});
