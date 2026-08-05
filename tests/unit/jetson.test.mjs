import test from "node:test";
import assert from "node:assert/strict";

import { JetsonConnection, jetsonHealthUrl, normalizeJetsonBaseUrl } from "../../apps/js/jetson.js";

test("Jetson 주소를 정규화하고 health endpoint를 만든다", () => {
  assert.equal(normalizeJetsonBaseUrl(" http://jetson.local:8787/ "), "http://jetson.local:8787");
  assert.equal(jetsonHealthUrl("", "http://127.0.0.1:8000"), "http://127.0.0.1:8000/api/health");
  assert.throws(() => normalizeJetsonBaseUrl("ws://jetson.local"), /http 또는 https/);
  assert.throws(() => normalizeJetsonBaseUrl("http://user:secret@jetson.local"), /계정 정보/);
});

test("Jetson health 응답을 연결 정보로 반환한다", async () => {
  const calls = [];
  const connection = new JetsonConnection({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ service: "wardy-edge", version: "0.1.0" }) };
    },
  });
  const result = await connection.check("http://jetson.local:8787");
  assert.equal(calls[0].url, "http://jetson.local:8787/api/health");
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(result, { endpoint: "http://jetson.local:8787/api/health", service: "wardy-edge", version: "0.1.0" });
});

test("Jetson의 비정상 health 응답을 연결 실패로 처리한다", async () => {
  const connection = new JetsonConnection({ fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => "" } }) });
  await assert.rejects(connection.check("http://jetson.local:8787"), /HTTP 503/);
});
