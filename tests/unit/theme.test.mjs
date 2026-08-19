import assert from "node:assert/strict";
import test from "node:test";

import { nextColorTheme, parseColorTheme } from "../../apps/js/theme.ts";

test("저장된 화면 테마는 light와 dark만 허용한다", () => {
  assert.equal(parseColorTheme("dark"), "dark");
  assert.equal(parseColorTheme("light"), "light");
  assert.equal(parseColorTheme("unexpected"), "light");
  assert.equal(parseColorTheme(null), "light");
});

test("해와 달 버튼은 현재 화면 테마를 반대로 전환한다", () => {
  assert.equal(nextColorTheme("light"), "dark");
  assert.equal(nextColorTheme("dark"), "light");
});
