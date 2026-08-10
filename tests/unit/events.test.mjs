import test from "node:test";
import assert from "node:assert/strict";

import { filterEvents, sortEvents, summarizeEvents } from "../../apps/js/events.ts";

const events = [
  { event_id: "normal", care_status: "normal", event_status: "new", event_type: "EVT-001", occurred_at: "2026-08-05T10:00:00+09:00", reason: "일상", subject_name: "김연우" },
  { event_id: "emergency", care_status: "emergency", event_status: "confirmed", event_type: "EVT-004", occurred_at: "2026-08-05T09:00:00+09:00", reason: "낙상 의심", subject_name: "조정민" },
  { event_id: "warning", care_status: "warning", event_status: "new", event_type: "EVT-003", occurred_at: "2026-08-04T22:00:00+09:00", reason: "위험물 접근", object_class: "가위" },
  { event_id: "unavailable", care_status: null, event_status: "new", event_type: "camera_fault", occurred_at: "2026-08-05T11:00:00+09:00", reason: "카메라 오류" },
];

test("돌봄 상태 우선순위로 이벤트를 정렬한다", () => {
  assert.deepEqual(sortEvents(events).map((event) => event.event_id), ["unavailable", "emergency", "warning", "normal"]);
});

test("상태와 검색어로 이벤트를 필터링한다", () => {
  assert.deepEqual(filterEvents(events, { careStatus: "warning" }).map((event) => event.event_id), ["warning"]);
  assert.deepEqual(filterEvents(events, { query: "가위" }).map((event) => event.event_id), ["warning"]);
  assert.deepEqual(filterEvents(events, { eventStatus: "confirmed" }).map((event) => event.event_id), ["emergency"]);
});

test("오늘 발생한 이벤트만 상태별로 집계한다", () => {
  const summary = summarizeEvents(events, new Date("2026-08-05T15:00:00+09:00"));
  assert.deepEqual(summary, { total: 3, normal: 1, caution: 0, warning: 0, emergency: 1, unconfirmed: 2 });
});
