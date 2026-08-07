import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage, WardyStore } from "../../apps/js/store.ts";

test("상태와 설정을 로컬 저장소에 보존한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "test-state");

  store.setCareState("warning", "수동 점검");
  store.setOverlaySetting("showName", false);
  store.setCameraMirrored(true);
  store.setJetsonBaseUrl("https://jetson.local:8443");

  const restored = new WardyStore(storage, "test-state").getState();
  assert.equal(restored.careState.status, "warning");
  assert.equal(restored.careState.reason, "수동 점검");
  assert.equal(restored.settings.overlay.showName, false);
  assert.equal(restored.settings.camera.mirrored, true);
  assert.deepEqual(restored.settings.jetson, { baseUrl: "https://jetson.local:8443" });
});

test("기존 Jetson 설정을 자동 연결 형식으로 이전하고 media port를 교정한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  initial.settings.camera = {};
  initial.settings.jetson = {
    baseUrl: "https://10.10.20.40:8189",
    accessToken: "legacy-access-token",
    viewerToken: "legacy-viewer-token",
  };
  storage.setItem("legacy-jetson", JSON.stringify(initial));

  const restored = new WardyStore(storage, "legacy-jetson").getState();
  assert.equal(restored.settings.camera.mirrored, false);
  assert.deepEqual(restored.settings.jetson, { baseUrl: "https://10.10.20.40:8443" });
  assert.doesNotMatch(storage.getItem("legacy-jetson"), /legacy-(?:access|viewer)-token/);
});

test("누락된 Jetson 설정은 기존 사용자 상태를 유지하며 보완한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  initial.careState.status = "warning";
  delete initial.settings.jetson;
  storage.setItem("missing-jetson", JSON.stringify(initial));

  const restored = new WardyStore(storage, "missing-jetson").getState();
  assert.equal(restored.careState.status, "warning");
  assert.deepEqual(restored.settings.jetson, { baseUrl: "" });
});

test("경로와 query가 있는 기존 WebRTC port 주소를 서비스 port로 이전한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  initial.settings.jetson.baseUrl = "https://jetson.local:8189/camera?source=saved";
  storage.setItem("legacy-jetson-path", JSON.stringify(initial));

  const restored = new WardyStore(storage, "legacy-jetson-path").getState();
  assert.equal(restored.settings.jetson.baseUrl, "https://jetson.local:8443/camera?source=saved");
});

test("불완전한 저장 상태는 초기 상태로 복구한다", () => {
  const storage = new MemoryStorage();
  storage.setItem("broken-state", JSON.stringify({
    version: 1,
    events: [],
    settings: { jetson: { accessToken: "stale-token", viewerToken: "stale-viewer-token" } },
  }));

  const restored = new WardyStore(storage, "broken-state").getState();
  assert.equal(restored.careState.status, "normal");
  assert.ok(restored.managedItems.length > 0);
  assert.ok(Array.isArray(restored.zones));
  assert.ok(Array.isArray(restored.subjects));
  assert.doesNotMatch(storage.getItem("broken-state"), /stale-(?:token|viewer-token)/);
});

test("상속된 enum key가 포함된 저장 상태를 거부한다", () => {
  const storage = new MemoryStorage();
  const modified = new WardyStore(storage, "source-state").getState();
  modified.careState.status = "warning";
  modified.events[0].care_status = "toString";
  storage.setItem("inherited-key-state", JSON.stringify(modified));

  const restored = new WardyStore(storage, "inherited-key-state").getState();
  assert.equal(restored.careState.status, "normal");
  assert.notEqual(restored.events[0].care_status, "toString");
});

test("잘못된 식별 검토 배열이 포함된 저장 상태를 거부한다", () => {
  const storage = new MemoryStorage();
  const modified = new WardyStore(null).getState();
  modified.careState.status = "warning";
  modified.identityReviews = "invalid";
  storage.setItem("invalid-review-state", JSON.stringify(modified));

  const restored = new WardyStore(storage, "invalid-review-state").getState();
  assert.equal(restored.careState.status, "normal");
  assert.deepEqual(restored.identityReviews, []);
});

test("이벤트 확인, 오탐, 미디어 삭제 상태를 갱신한다", () => {
  const store = new WardyStore(new MemoryStorage());
  const [first, second] = store.getState().events;

  store.confirmEvent(first.event_id, "2026-08-05T01:00:00.000Z");
  store.markFalseDetection(second.event_id, "2026-08-05T01:01:00.000Z");
  store.removeEventMedia(first.event_id);

  const state = store.getState();
  const confirmed = state.events.find((event) => event.event_id === first.event_id);
  const falseDetection = state.events.find((event) => event.event_id === second.event_id);
  assert.equal(confirmed.event_status, "confirmed");
  assert.equal(confirmed.confirmed_at, "2026-08-05T01:00:00.000Z");
  assert.equal(confirmed.media_type, "none");
  assert.equal(confirmed.media_path, null);
  assert.equal(falseDetection.event_status, "false_detection");
});

test("초기화하면 독립된 초기 상태로 돌아간다", () => {
  const store = new WardyStore(new MemoryStorage());
  const initialItemCount = store.getState().managedItems.length;
  store.setCareState("emergency");
  store.addManagedItem("테스트 물품", "excluded");

  const state = store.reset();
  assert.equal(state.careState.status, "normal");
  assert.equal(state.managedItems.length, initialItemCount);
  assert.equal(state.managedItems.some((item) => item.label === "테스트 물품"), false);
});

test("관리 물품의 Jetson 학습 사진 수를 보존한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "training-samples");
  store.addManagedItem("주방 칼", "included");
  const item = store.getState().managedItems.at(-1);
  store.setManagedItemSampleCount(item.id, 4);
  const restored = new WardyStore(storage, "training-samples").getState();
  assert.equal(restored.managedItems.find((candidate) => candidate.id === item.id).sampleCount, 4);
});

test("인물 기준 사진 수와 식별 검토 답변을 로컬에 저장한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "identity-feedback");
  const subject = store.getState().subjects[0];
  store.setSubjectReferenceSampleCount(subject.id, 4);
  store.addIdentityReview({
    imagePath: "identity/review-1.jpg",
    capturedAt: "2026-08-06T12:00:00Z",
    predictedName: "조정민",
    confidence: 0.55,
  });
  const review = store.getState().identityReviews[0];
  store.resolveIdentityReview(review.id, "subject", subject.id);
  const restored = new WardyStore(storage, "identity-feedback").getState();
  assert.equal(restored.subjects[0].referenceSampleCount, 4);
  assert.equal(restored.identityReviews[0].decision, "subject");
  assert.equal(restored.identityReviews[0].subjectId, subject.id);
});

test("상황별 알림은 ON과 OFF만 저장한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "notification-toggle");
  store.setNotificationSetting("fall_suspected", "off");
  assert.equal(store.getState().settings.notifications.fall_suspected, "off");
  store.setNotificationSetting("fall_suspected", "on");
  assert.equal(store.getState().settings.notifications.fall_suspected, "on");
});

test("기존 알림 강도 값은 ON으로 이전한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  initial.settings.notifications = { fall_suspected: "strong", inactivity: "normal", hazard_detected: "off" };
  storage.setItem("legacy-notifications", JSON.stringify(initial));
  const restored = new WardyStore(storage, "legacy-notifications").getState();
  assert.deepEqual(restored.settings.notifications, {
    fall_suspected: "on", inactivity: "on", hazard_detected: "off",
  });
});

test("제거된 관리 물품 이동 event를 제외하고 기존 상태를 복구한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  initial.careState.status = "warning";
  initial.events.push({ ...initial.events[0], event_id: "EVT-LEGACY", event_type: "managed_item_moved" });
  initial.settings.notifications.managed_item_moved = "on";
  storage.setItem("legacy-managed-item-event", JSON.stringify(initial));

  const restored = new WardyStore(storage, "legacy-managed-item-event").getState();
  assert.equal(restored.careState.status, "warning");
  assert.equal(restored.events.some((event) => event.event_id === "EVT-LEGACY"), false);
  assert.equal("managed_item_moved" in restored.settings.notifications, false);
});
