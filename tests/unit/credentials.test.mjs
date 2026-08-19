import test from "node:test";
import assert from "node:assert/strict";

import { JetsonCredentialStore } from "../../apps/js/credentials.ts";
import { MemoryStorage } from "../../apps/js/store.ts";

test("Jetson token은 탭 session 저장소에서 새로고침 연결에 사용한다", () => {
  const sessionStorage = new MemoryStorage();
  const credentials = new JetsonCredentialStore(sessionStorage, "test-credentials");
  credentials.set("access-token", "viewer-token");

  const restored = new JetsonCredentialStore(sessionStorage, "test-credentials").get();
  assert.deepEqual(restored, { accessToken: "access-token", viewerToken: "viewer-token" });
});

test("Jetson token session을 명시적으로 폐기한다", () => {
  const sessionStorage = new MemoryStorage();
  const credentials = new JetsonCredentialStore(sessionStorage, "test-credentials");
  credentials.set("access-token", "viewer-token");
  credentials.clear();

  assert.deepEqual(credentials.get(), { accessToken: "", viewerToken: "" });
  assert.equal(sessionStorage.getItem("test-credentials"), null);
});
