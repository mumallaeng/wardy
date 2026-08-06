import test from "node:test";
import assert from "node:assert/strict";

import { TrainingSampleClient, subjectReferenceUrl, trainingSampleUrl } from "../../apps/js/training.ts";

test("Jetson training sample endpoint를 만든다", () => {
  assert.equal(
    trainingSampleUrl("http://jetson.local:8787/"),
    "http://jetson.local:8787/api/training/items/sample",
  );
});

test("등록 물품 정보를 보내고 저장된 sample 수를 반환한다", async () => {
  const calls = [];
  const client = new TrainingSampleClient(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      sample_id: "sample-001", image_path: "items/item-1/images/sample-001.jpg", sample_count: 3,
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  });
  const result = await client.capture(
    { id: "item-1", label: "주방 칼", policy: "included" },
    "http://jetson.local:8787",
    "test-access-token",
  );
  assert.equal(calls[0].url, "http://jetson.local:8787/api/training/items/sample");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Wardy-Item-Label"], encodeURIComponent("주방 칼"));
  assert.equal(calls[0].options.headers["X-Wardy-Access-Token"], "test-access-token");
  assert.deepEqual(result, {
    sampleId: "sample-001", imagePath: "items/item-1/images/sample-001.jpg", sampleCount: 3,
  });
});

test("돌봄 인물 기준 사진을 Jetson 로컬 endpoint에 저장한다", async () => {
  assert.equal(subjectReferenceUrl("http://jetson.local:8787/"),
    "http://jetson.local:8787/api/training/subjects/reference");
  const calls = [];
  const client = new TrainingSampleClient(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      sample_id: "subject-sample-001",
      image_path: "subjects/subject-1/reference/subject-sample-001.jpg",
      sample_count: 4,
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  });
  const result = await client.captureSubject({
    id: "subject-1", name: "조정민", role: "돌봄 대상", createdAt: "2026-08-06T00:00:00Z",
  }, "http://jetson.local:8787", "test-access-token");
  assert.equal(calls[0].options.headers["X-Wardy-Subject-Name"], encodeURIComponent("조정민"));
  assert.equal(result.sampleCount, 4);
});
