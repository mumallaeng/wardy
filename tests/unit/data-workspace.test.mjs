import test from "node:test";
import assert from "node:assert/strict";

import { datasetManifest } from "../../apps/js/data-workspace.ts";

test("Notebook manifest에는 승인된 원본 sample만 포함한다", () => {
  const base = {
    modelId: "M-05", requirementId: "DS-004", label: "knife",
    captureSession: "session-0811-pm", source: "local_file",
    originalFilename: "knife.png", capturedAt: "2026-08-11T06:00:00Z",
    width: 1280, height: 720,
  };
  const manifest = datasetManifest(" wardy-0811-v2 ", [
    { ...base, id: "approved", reviewStatus: "approved", imagePath: "datasets/approved.png" },
    { ...base, id: "pending", reviewStatus: "pending", imagePath: "datasets/pending.png" },
    { ...base, id: "rejected", reviewStatus: "rejected", imagePath: "datasets/rejected.png" },
  ]);
  assert.equal(manifest.schema, "wardy.dataset-manifest.v1");
  assert.equal(manifest.datasetVersion, "wardy-0811-v2");
  assert.equal(manifest.sampleCount, 1);
  assert.equal(manifest.activeModelChanged, false);
  assert.deepEqual(manifest.samples.map((sample) => sample.sampleId), ["approved"]);
  assert.equal(manifest.samples[0].imagePath, "datasets/approved.png");
});
