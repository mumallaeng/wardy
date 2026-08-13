import assert from "node:assert/strict";
import test from "node:test";

import { userFacingCareReason } from "../../apps/js/constants.ts";

test("돌봄 상태에는 M-04 내부 진단 문구 대신 사용자용 설명을 표시한다", () => {
  assert.equal(
    userFacingCareReason("emergency", "M-04 temporal pose sequence exceeded the fall threshold"),
    "낙상 의심 신호가 일정 시간 누적되었습니다.",
  );
  assert.equal(
    userFacingCareReason("normal", "Event runtime is starting"),
    "활성화된 안전 이벤트가 없습니다.",
  );
});
