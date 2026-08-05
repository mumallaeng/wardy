import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage, WardyStore } from "../../apps/js/store.js";

test("상태와 설정을 로컬 저장소에 보존한다", () => {
  const storage = new MemoryStorage();
  const store = new WardyStore(storage, "test-state");

  store.setCareState("warning", "수동 점검");
  store.setOverlaySetting("identifiedName", false);

  const restored = new WardyStore(storage, "test-state").getState();
  assert.equal(restored.careState.status, "warning");
  assert.equal(restored.careState.reason, "수동 점검");
  assert.equal(restored.settings.overlay.identifiedName, false);
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
