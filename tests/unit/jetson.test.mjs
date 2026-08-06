import test from "node:test";
import assert from "node:assert/strict";

import { JetsonConnection, jetsonHealthUrl, normalizeJetsonBaseUrl } from "../../apps/js/jetson.ts";

test("Jetson 주소를 정규화하고 health endpoint를 만든다", () => {
  assert.equal(normalizeJetsonBaseUrl(" https://jetson.local:8443/ "), "https://jetson.local:8443");
  assert.equal(jetsonHealthUrl("", "https://127.0.0.1:8443"), "https://127.0.0.1:8443/api/health");
  assert.throws(() => normalizeJetsonBaseUrl("ws://jetson.local"), /HTTPS/);
  assert.throws(() => normalizeJetsonBaseUrl("http://jetson.local:8787"), /HTTPS/);
  assert.throws(() => normalizeJetsonBaseUrl("https://user:secret@jetson.local"), /계정 정보/);
});

test("Jetson health 응답을 연결 정보로 반환한다", async () => {
  const calls = [];
  const connection = new JetsonConnection({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ service: "wardy-edge", version: "0.1.0" }) };
    },
  });
  const result = await connection.check("https://jetson.local:8443");
  assert.equal(calls[0].url, "https://jetson.local:8443/api/health");
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(result, { endpoint: "https://jetson.local:8443/api/health", service: "wardy-edge", version: "0.1.0" });
});

test("Jetson의 비정상 health 응답을 연결 실패로 처리한다", async () => {
  const connection = new JetsonConnection({ fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => "" } }) });
  await assert.rejects(connection.check("https://jetson.local:8443"), /HTTP 503/);
});
