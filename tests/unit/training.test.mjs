import test from "node:test";
import assert from "node:assert/strict";

import { TrainingSampleClient, datasetSampleMediaUrl, datasetSamplesUrl, subjectReferenceUrl, trainingSampleUrl } from "../../apps/js/training.ts";

const datasetSample = {
  id: "dataset-sample-001",
  modelId: "M-03-04",
  requirementId: "DS-002",
  label: "standing",
  reviewStatus: "pending",
  captureSession: "session-0811-pm",
  source: "jetson_camera",
  imagePath: "datasets/M-03_4/DS-002/dataset-sample-001.jpg",
  mediaResource: "/api/data-samples/dataset-sample-001/media",
  originalFilename: null,
  capturedAt: "2026-08-11T05:00:00Z",
  width: 640,
  height: 480,
};

test("Jetson training sample endpoint를 만든다", () => {
  assert.equal(
    trainingSampleUrl("https://jetson.local:8443/"),
    "https://jetson.local:8443/api/training/items/sample",
  );
  assert.throws(() => trainingSampleUrl("http://jetson.local:8787/"), /HTTPS/);
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
    "https://jetson.local:8443",
    "test-access-token",
  );
  assert.equal(calls[0].url, "https://jetson.local:8443/api/training/items/sample");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Wardy-Item-Label"], encodeURIComponent("주방 칼"));
  assert.equal(calls[0].options.headers["X-Wardy-Access-Token"], "test-access-token");
  assert.deepEqual(result, {
    sampleId: "sample-001", imagePath: "items/item-1/images/sample-001.jpg", sampleCount: 3,
  });
});

test("돌봄 인물 기준 사진을 Jetson 로컬 endpoint에 저장한다", async () => {
  assert.equal(subjectReferenceUrl("https://jetson.local:8443/"),
    "https://jetson.local:8443/api/training/subjects/reference");
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
  }, "https://jetson.local:8443", "test-access-token");
  assert.equal(calls[0].options.headers["X-Wardy-Subject-Name"], encodeURIComponent("조정민"));
  assert.equal(result.sampleCount, 4);
});

test("데이터 작업실 sample을 조회·촬영·검수한다", async () => {
  assert.equal(datasetSamplesUrl("https://jetson.local:8443"),
    "https://jetson.local:8443/api/data-samples");
  const calls = [];
  const client = new TrainingSampleClient(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ samples: [datasetSample] }), {
      status: String(url).endsWith("/camera") ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const metadata = {
    modelId: "M-03-04", requirementId: "DS-002", label: "standing", captureSession: "session-0811-pm",
  };
  assert.equal((await client.listDatasetSamples(
    "https://jetson.local:8443", "access-token"))[0].id, datasetSample.id);
  await client.captureDatasetSample(metadata, "https://jetson.local:8443", "access-token");
  await client.updateDatasetSample(datasetSample.id, "standing", "approved",
    "https://jetson.local:8443", "access-token");
  assert.equal(calls[1].options.headers["X-Wardy-Model-Id"], "M-03-04");
  assert.equal(calls[1].options.headers["X-Wardy-Capture-Session"], "session-0811-pm");
  assert.equal(calls[2].options.headers["X-Wardy-Review-Status"], "approved");
});

test("로컬 이미지는 허용 형식과 크기를 확인한 뒤 원본 이름과 함께 보낸다", async () => {
  const calls = [];
  const client = new TrainingSampleClient(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ samples: [{
      ...datasetSample, source: "local_file", originalFilename: "자세 예시.png",
    }] }), { status: 201, headers: { "Content-Type": "application/json" } });
  });
  const metadata = {
    modelId: "M-03-04", requirementId: "DS-002", label: "standing", captureSession: "session-0811-pm",
  };
  const file = new File([new Uint8Array([1, 2, 3])], "자세 예시.png", { type: "image/png" });
  const result = await client.uploadDatasetSample(
    file, metadata, "https://jetson.local:8443", "access-token",
  );
  assert.equal(calls[0].options.headers["X-Wardy-Original-Filename"], encodeURIComponent(file.name));
  assert.equal(calls[0].options.body, file);
  assert.equal(result[0].originalFilename, file.name);
  await assert.rejects(() => client.uploadDatasetSample(
    new File(["bad"], "bad.txt", { type: "text/plain" }), metadata,
    "https://jetson.local:8443", "access-token",
  ), /지원하지 않는/);
});

test("데이터 sample 원본은 인증된 media endpoint에서 읽는다", async () => {
  assert.equal(datasetSampleMediaUrl(datasetSample, "https://jetson.local:8443"),
    "https://jetson.local:8443/api/data-samples/dataset-sample-001/media");
  const calls = [];
  const client = new TrainingSampleClient(async (url, options) => {
    calls.push({ url, options });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { "Content-Type": "image/jpeg" },
    });
  });
  const media = await client.loadDatasetSampleMedia(
    datasetSample, "https://jetson.local:8443", "access-token",
  );
  assert.equal(calls[0].options.headers["X-Wardy-Access-Token"], "access-token");
  assert.equal(media.type, "image/jpeg");
  assert.equal(
    datasetSampleMediaUrl({
      ...datasetSample,
      mediaResource: "https://jetson.local:8443/api/data-samples/dataset-sample-001/media",
    }, "https://jetson.local:8443"),
    "https://jetson.local:8443/api/data-samples/dataset-sample-001/media",
  );
  assert.throws(() => datasetSampleMediaUrl({
    ...datasetSample,
    mediaResource: "https://outside.example/sample.jpg",
  }, "https://jetson.local:8443"), /일치하지 않습니다/);
});
