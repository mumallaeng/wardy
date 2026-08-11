import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage, WardyStore } from "../../apps/js/store.ts";

const eventFixture = (id = "EVT-TEST-001") => ({
  event_id: id, event_type: "fall_suspected", occurred_at: "2026-08-11T00:00:00Z",
  first_seen_at: "2026-08-11T00:00:00Z", last_seen_at: "2026-08-11T00:00:01Z",
  subject_id: "subject-test", subject_name: "돌봄 대상", subject_location: "거실",
  object_id: null, object_class: null, zone_id: null, care_status: "emergency",
  event_status: "new", confirmed_at: null, released_at: null, false_detection_at: null,
  reason: "확인이 필요한 의심 상황", source_results: [], media_type: "video",
  media_path: `${id}.mp4`, media_started_at: "2026-08-10T23:59:55Z",
  media_ended_at: "2026-08-11T00:00:05Z",
});

const subjectFixture = () => ({
  id: "subject-test", name: "돌봄 대상", role: "돌봄 대상",
  createdAt: "2026-08-11T00:00:00Z", referenceSampleCount: 0,
});

const managedItemFixture = () => ({
  id: "item-test", label: "가위", policy: "included", sampleCount: 0,
});

test("상태와 설정을 로컬 저장소에 보존한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "test-state");

  store.setCareState("warning", "수동 점검");
  store.setOverlaySetting("showName", false);
  store.setCameraMirrored(true);
  store.setJetsonBaseUrl("https://jetson.local:8443");
  store.setDataWorkspace("session-0811-pm", "wardy-0811-v2");

  const restored = new WardyStore(storage, "test-state").getState();
  assert.equal(restored.careState.status, "warning");
  assert.equal(restored.careState.reason, "수동 점검");
  assert.equal(restored.settings.overlay.showName, false);
  assert.equal(restored.settings.camera.mirrored, true);
  assert.deepEqual(restored.settings.jetson, { baseUrl: "https://jetson.local:8443" });
  assert.deepEqual(restored.settings.dataWorkspace, {
    captureSession: "session-0811-pm", datasetVersion: "wardy-0811-v2",
  });
});

test("Jetson 데이터 sample 목록은 계약에 맞는 항목만 보존한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "dataset-samples");
  store.replaceDatasetSamples([{
    id: "sample-1", modelId: "M-01", requirementId: "DS-001", label: "person",
    reviewStatus: "approved", captureSession: "session-0811-am", source: "local_file",
    imagePath: "datasets/M-01/DS-001/sample-1.jpg",
    mediaResource: "/api/data-samples/sample-1/media", originalFilename: "person.jpg",
    capturedAt: "2026-08-11T01:00:00Z", width: 640, height: 480,
  }, { id: "invalid" }]);
  const restored = new WardyStore(storage, "dataset-samples").getState();
  assert.deepEqual(restored.datasetSamples.map((sample) => sample.id), ["sample-1"]);
});

test("legacy dataset sample은 edge route에서 사용할 수 있는 ID만 이전한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  const sample = {
    id: "legacy_id-1", modelId: "M-01", requirementId: "DS-001", label: "person",
    reviewStatus: "pending", captureSession: "session-0811-am", source: "local_file",
    imagePath: "datasets/M-01/legacy.jpg", originalFilename: "legacy.jpg",
    capturedAt: "2026-08-11T01:00:00Z", width: 640, height: 480,
  };
  initial.datasetSamples = [
    sample,
    ...["legacy/id", "legacy id", "legacy.id"].map((id) => ({ ...sample, id })),
  ];
  storage.setItem("legacy-dataset-ids", JSON.stringify(initial));

  const restored = new WardyStore(storage, "legacy-dataset-ids").getState();
  assert.deepEqual(restored.datasetSamples.map((candidate) => candidate.id), ["legacy_id-1"]);
  assert.equal(restored.datasetSamples[0].mediaResource,
    "/api/data-samples/legacy_id-1/media");
});

test("빈 data workspace 설정은 저장하지 않고 기존 빈 값은 기본값으로 이전한다", () => {
  const storage = new MemoryStorage();
  const initial = new WardyStore(null).getState();
  initial.settings.dataWorkspace = { captureSession: "   ", datasetVersion: "" };
  storage.setItem("blank-data-workspace", JSON.stringify(initial));

  const store = new WardyStore(storage, "blank-data-workspace");
  const restored = store.getState();
  assert.match(restored.settings.dataWorkspace.captureSession, /^session-\d{8}$/);
  assert.match(restored.settings.dataWorkspace.datasetVersion, /^wardy-\d{8}-v1$/);
  assert.throws(() => store.setDataWorkspace(" ", "wardy-v2"), /모두 입력/);
  assert.deepEqual(store.getState().settings.dataWorkspace, restored.settings.dataWorkspace);
});

test("Jetson system fault에서는 돌봄 상태를 확인 불가로 보존한다", () => {
  const store = new WardyStore(new MemoryStorage(), "runtime-fault");
  store.applyRuntimeSnapshot({
    care_state: null,
    camera_state: "fault",
    detection_state: "disconnected",
    event_state: "ready",
    reason: "camera disconnected",
    updated_at: "2026-08-10T00:00:00Z",
  }, []);
  const restored = store.getState();
  assert.equal(restored.careState.status, null);
  assert.equal(restored.careState.source, "jetson_runtime");
  assert.equal(restored.careState.reason, "camera disconnected");
});

test("잘못된 Jetson runtime 상태는 기존 화면 상태를 변경하지 않는다", () => {
  const store = new WardyStore(new MemoryStorage(), "invalid-runtime-state");
  const before = store.getState();
  assert.throws(() => store.applyRuntimeSnapshot({
    care_state: "unknown",
    camera_state: "connected",
    detection_state: "ready",
    event_state: "ready",
    reason: "invalid",
    updated_at: "2026-08-10T00:00:00Z",
  }, []), /응답 형식/);
  assert.deepEqual(store.getState(), before);
});

test("Jetson runtime 목록에서 계약을 위반한 항목을 제외한다", () => {
  const store = new WardyStore(new MemoryStorage(), "invalid-runtime-collections");
  const initial = store.getState();
  store.applyRuntimeSnapshot({
    care_state: "normal",
    camera_state: "connected",
    detection_state: "ready",
    event_state: "ready",
    reason: "ready",
    updated_at: "2026-08-10T00:00:00Z",
  }, [eventFixture(), { event_id: "broken" }]);
  store.replaceSubjects([subjectFixture(), { id: "broken" }]);
  store.replaceManagedItems([managedItemFixture(), { id: "broken" }]);
  const restored = store.getState();
  assert.deepEqual(restored.events.map((event) => event.event_id), ["EVT-TEST-001"]);
  assert.deepEqual(restored.subjects.map((subject) => subject.id), ["subject-test"]);
  assert.deepEqual(restored.managedItems.map((item) => item.id), ["item-test"]);
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
  assert.equal(restored.careState.status, null);
  assert.deepEqual(restored.managedItems, []);
  assert.ok(Array.isArray(restored.zones));
  assert.ok(Array.isArray(restored.subjects));
  assert.doesNotMatch(storage.getItem("broken-state"), /stale-(?:token|viewer-token)/);
});

test("상속된 enum key가 포함된 저장 상태를 거부한다", () => {
  const storage = new MemoryStorage();
  const modified = new WardyStore(storage, "source-state").getState();
  modified.careState.status = "warning";
  modified.events = [{ ...eventFixture(), care_status: "toString" }];
  storage.setItem("inherited-key-state", JSON.stringify(modified));

  const restored = new WardyStore(storage, "inherited-key-state").getState();
  assert.equal(restored.careState.status, null);
  assert.deepEqual(restored.events, []);
});

test("잘못된 식별 검토 배열이 포함된 저장 상태를 거부한다", () => {
  const storage = new MemoryStorage();
  const modified = new WardyStore(null).getState();
  modified.careState.status = "warning";
  modified.identityReviews = "invalid";
  storage.setItem("invalid-review-state", JSON.stringify(modified));

  const restored = new WardyStore(storage, "invalid-review-state").getState();
  assert.equal(restored.careState.status, null);
  assert.deepEqual(restored.identityReviews, []);
});

test("이벤트 확인, 오탐, 미디어 삭제 상태를 갱신한다", () => {
  const store = new WardyStore(new MemoryStorage());
  const first = eventFixture("EVT-TEST-001");
  const second = eventFixture("EVT-TEST-002");
  store.addEvent(second);
  store.addEvent(first);

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
  assert.equal(state.careState.status, null);
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
  store.addSubject("돌봄 대상", "돌봄 대상");
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
  initial.events.push({ ...eventFixture("EVT-LEGACY"), event_type: "managed_item_moved" });
  initial.settings.notifications.managed_item_moved = "on";
  storage.setItem("legacy-managed-item-event", JSON.stringify(initial));

  const restored = new WardyStore(storage, "legacy-managed-item-event").getState();
  assert.equal(restored.careState.status, "warning");
  assert.equal(restored.events.some((event) => event.event_id === "EVT-LEGACY"), false);
  assert.equal("managed_item_moved" in restored.settings.notifications, false);
});
