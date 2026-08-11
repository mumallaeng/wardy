import assert from "node:assert/strict";
import test from "node:test";
import { newNotifiableEvents } from "../../apps/js/notifications.ts";

const event = {
  event_id: "EVT-1",
  event_type: "fall_suspected",
  event_status: "new",
};

test("첫 runtime snapshot은 기존 이벤트 알림을 만들지 않는다", () => {
  assert.deepEqual(newNotifiableEvents([event], null, { fall_suspected: "on" }), []);
});

test("OFF인 이벤트 종류와 이미 확인한 이벤트는 알림 대상에서 제외한다", () => {
  assert.deepEqual(newNotifiableEvents([event], new Set(), { fall_suspected: "off" }), []);
  assert.deepEqual(newNotifiableEvents([event], new Set(["EVT-1"]), { fall_suspected: "on" }), []);
});

test("ON인 새 이벤트만 알림 대상으로 반환한다", () => {
  assert.deepEqual(
    newNotifiableEvents([event], new Set(), { fall_suspected: "on" }),
    [event],
  );
});
