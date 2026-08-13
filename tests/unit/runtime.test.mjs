import assert from "node:assert/strict";
import test from "node:test";

import { WardyRuntimeClient } from "../../apps/js/runtime.ts";

const state = {
  care_state: "normal", camera_state: "connected", detection_state: "disconnected",
  event_state: "ready", reason: "ready", updated_at: "2026-08-10T00:00:00Z",
};
const inference = {
  source: "temporary", observed_at: "2026-08-12T00:00:00Z", operational: true,
  fault_reason: "", detections: [],
};

test("Jetson runtime snapshot과 등록 목록을 인증 API에서 읽는다", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/state")) return Response.json(state);
    if (String(url).endsWith("/api/events")) return Response.json({ events: [] });
    if (String(url).endsWith("/api/inference")) return Response.json(inference);
    if (String(url).endsWith("/api/subjects")) return Response.json({ subjects: [] });
    if (String(url).endsWith("/api/managed-items")) return Response.json({ managedItems: [] });
    if (String(url).endsWith("/api/zones")) return Response.json({ zones: [] });
    if (String(url).endsWith("/api/notification-settings")) {
      return Response.json({ notifications: { fall_suspected: "on" } });
    }
    return Response.json({ reviews: [] });
  };
  const client = new WardyRuntimeClient(fetchImpl);
  const snapshot = await client.loadSnapshot("https://10.10.20.40:8443", "token", "https://ui.local");
  const collections = await client.loadCollections("https://10.10.20.40:8443", "token", "https://ui.local");
  assert.equal(snapshot.state.camera_state, "connected");
  assert.equal(snapshot.inference.source, "temporary");
  assert.deepEqual(collections, {
    subjects: [], managedItems: [], zones: [],
    notifications: { fall_suspected: "on" },
    identityReviews: [],
  });
  assert.equal(calls.length, 8);
  assert.ok(calls.every((call) => call.init.headers["X-Wardy-Access-Token"] === "token"));
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
});

test("등록 목록 일부 요청이 실패해도 성공한 collection을 유지한다", async () => {
  const client = new WardyRuntimeClient(async (url) => {
    if (String(url).endsWith("/api/subjects")) {
      return new Response("unavailable", { status: 503 });
    }
    if (String(url).endsWith("/api/managed-items")) {
      return Response.json({ managedItems: [] });
    }
    if (String(url).endsWith("/api/zones")) return Response.json({ zones: [] });
    if (String(url).endsWith("/api/notification-settings")) {
      return Response.json({ notifications: { fall_suspected: "on" } });
    }
    return Response.json({ reviews: [] });
  });

  const collections = await client.loadCollections(
    "https://jetson.local:8443", "token", "https://ui.local",
  );
  assert.equal(collections.subjects, undefined);
  assert.deepEqual(collections.managedItems, []);
  assert.deepEqual(collections.zones, []);
  assert.deepEqual(collections.notifications, { fall_suspected: "on" });
  assert.deepEqual(collections.identityReviews, []);
});

test("inference endpoint 실패는 state와 event snapshot을 막지 않는다", async () => {
  const client = new WardyRuntimeClient(async (url) => {
    if (String(url).endsWith("/api/state")) return Response.json(state);
    if (String(url).endsWith("/api/events")) return Response.json({ events: [] });
    return new Response("unavailable", { status: 503 });
  });

  const snapshot = await client.loadSnapshot(
    "https://jetson.local:8443", "token", "https://ui.local",
  );
  assert.equal(snapshot.state.camera_state, "connected");
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.inference, undefined);
});

test("inference confidence는 유한한 0부터 1 사이 값이어야 한다", async () => {
  const client = new WardyRuntimeClient(async (url) => {
    if (String(url).endsWith("/api/state")) return Response.json(state);
    if (String(url).endsWith("/api/events")) return Response.json({ events: [] });
    return Response.json({
      ...inference,
      detections: [{
        id: "track-1", className: "사람", role: "", name: "", posture: "추적 중",
        color: "#62b88f", confidence: Number.NaN, box: [0.1, 0.1, 0.2, 0.2],
      }],
    });
  });

  await assert.rejects(
    client.loadSnapshot("https://jetson.local:8443", "token", "https://ui.local"),
    /inference output 형식/,
  );
});

test("M-03 관절점은 비어 있거나 COCO-17 전체여야 한다", async () => {
  const client = new WardyRuntimeClient(async (url) => {
    if (String(url).endsWith("/api/state")) return Response.json(state);
    if (String(url).endsWith("/api/events")) return Response.json({ events: [] });
    return Response.json({
      ...inference,
      detections: [{
        id: "track-1", className: "사람", role: "", name: "", posture: "서 있음",
        color: "#62b88f", confidence: 0.9, box: [0.1, 0.1, 0.2, 0.6],
        fallDiagnostics: {
          trackId: 1, detectorConfidence: 0.9, poseQuality: 0.8,
          historyFrames: 1, windowFrames: 20, fallConfidence: null,
          fallThreshold: 0.5, keypoints: [[0.2, 0.2, 0.9]],
        },
      }],
    });
  });

  await assert.rejects(
    client.loadSnapshot("https://jetson.local:8443", "token", "https://ui.local"),
    /inference output 형식/,
  );
});

test("식별 검토 장면과 답변은 인증된 Jetson API를 사용한다", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/media")) {
      return new Response(new Blob(["image"], { type: "image/jpeg" }));
    }
    return Response.json({ reviews: [{
      id: "review-1", imagePath: "identity/review-1.jpg",
      mediaResource: "/api/identity-reviews/review-1/media",
      capturedAt: "2026-08-11T00:00:00Z", predictedName: null,
      confidence: null, decision: "unknown", subjectId: null,
    }] });
  };
  const client = new WardyRuntimeClient(fetchImpl);
  const controller = new AbortController();
  const blob = await client.loadIdentityReviewMedia(
    "https://jetson.local:8443", "token", "", "review-1", controller.signal,
  );
  const reviews = await client.resolveIdentityReview(
    "https://jetson.local:8443", "token", "", "review-1", "unknown",
  );
  assert.equal(blob.type, "image/jpeg");
  assert.equal(calls[0].init.signal.aborted, false);
  assert.equal(reviews[0].decision, "unknown");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["X-Wardy-Review-Decision"], "unknown");
  await assert.rejects(
    client.resolveIdentityReview(
      "https://jetson.local:8443", "token", "", "review-1", "subject",
    ),
    /인물 식별자가 필요합니다/,
  );
  assert.equal(calls.length, 2);
});

test("주의 구역과 알림 설정은 Jetson 운영 설정 API에 저장한다", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === "DELETE") return Response.json({ zones: [] });
    if (String(url).endsWith("/api/zones")) return Response.json({ zones: [{
      id: "zone-1", name: "현관", x: 0.1, y: 0.2, width: 0.3, height: 0.4,
    }] });
    return Response.json({ notifications: { fall_suspected: "off" } });
  };
  const client = new WardyRuntimeClient(fetchImpl);
  const zones = await client.createZone("https://jetson.local:8443", "token", "", {
    name: "현관", x: 0.1, y: 0.2, width: 0.3, height: 0.4,
  });
  await client.deleteZone("https://jetson.local:8443", "token", "", zones[0].id);
  const notifications = await client.setNotificationSetting(
    "https://jetson.local:8443", "token", "", "fall_suspected", "off",
  );
  assert.equal(notifications.fall_suspected, "off");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(decodeURIComponent(calls[0].init.headers["X-Wardy-Zone-Name"]), "현관");
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[2].init.headers["X-Wardy-Notification"], "off");
});

test("Jetson runtime WebSocket은 payload를 선별하고 지수 backoff로 한 번만 재연결한다", () => {
  const opened = [];
  const scheduled = [];
  const cancelled = [];
  const snapshots = [];
  const inferences = [];
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
  client.connect("https://10.10.20.40:8443", "https://ui.local",
    (snapshot) => snapshots.push(snapshot), (snapshot) => inferences.push(snapshot));
  assert.equal(opened[0].url, "wss://10.10.20.40:8443/api/ws");
  assert.deepEqual(opened[0].protocols, ["wardy-events"]);

  opened[0].socket.dispatchEvent(new Event("open"));
  assert.equal(client.isConnected(), true);
  opened[0].socket.dispatchEvent(new MessageEvent("message", { data: "not-json" }));
  opened[0].socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "other" }) }));
  opened[0].socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "snapshot", state, events: [] }),
  }));
  assert.deepEqual(snapshots, [{ state, events: [] }]);
  opened[0].socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "inference", inference }),
  }));
  assert.deepEqual(inferences, [inference]);
  opened[0].socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "inference", inference: { ...inference, detections: [{}] } }),
  }));
  assert.deepEqual(inferences, [inference]);

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
      filtered: false,
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
