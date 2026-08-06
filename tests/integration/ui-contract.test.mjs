import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

test("주요 비AI 화면과 명시적 AI 미연결 표시를 제공한다", async () => {
  const html = await readFile(path.join(root, "apps/index.html"), "utf8");
  for (const view of ["dashboard", "events", "settings", "jetson"]) {
    assert.match(html, new RegExp(`data-view-panel=["']${view}["']`));
  }
  for (const id of ["start-camera", "event-table-body", "jetson-form", "check-jetson"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /AI 미연결/);
  assert.match(html, /AI 결과 아님/);
  assert.doesNotMatch(html, /Arduino|ARDUINO|아두이노|Web Serial|buzzer|부저/);
  assert.match(html, /\/api\/health/);
  assert.match(html, /\/api\/camera\/stream/);
  assert.match(html, /<img id="camera"/);
  assert.doesNotMatch(html, /<video id="camera"/);
  assert.match(html, /event·state 동기화<\/dt><dd>후속 통합/);
  assert.match(html, /\/dev\/video0/);
  assert.match(html, /V4L2/);
});

test("카메라 화면은 브라우저 장치 대신 Jetson stream만 사용한다", async () => {
  const entries = await readdir(path.join(root, "apps/js"));
  const sources = await Promise.all(entries.filter((entry) => entry.endsWith(".ts")).map((entry) => readFile(path.join(root, "apps/js", entry), "utf8")));
  const joined = sources.join("\n");
  assert.match(joined, /\/api\/camera\/stream/);
  assert.doesNotMatch(joined, /getUserMedia|mediaDevices|MediaStream|srcObject/);
});

test("브라우저 application source는 TypeScript만 사용한다", async () => {
  const entries = await readdir(path.join(root, "apps/js"));
  assert.equal(entries.some((entry) => entry.endsWith(".js")), false);
  assert.ok(entries.includes("app.ts"));
  assert.ok(entries.includes("types.ts"));
  const html = await readFile(path.join(root, "apps/index.html"), "utf8");
  assert.match(html, /src=["']\.\/js\/app\.ts["']/);
});

test("이벤트 작업 버튼은 표 셀 내부 그룹으로 정렬한다", async () => {
  const source = await readFile(path.join(root, "apps/js/events.ts"), "utf8");
  const css = await readFile(path.join(root, "apps/css/app.css"), "utf8");
  assert.match(source, /className = "table-action-group"/);
  assert.doesNotMatch(css, /\.table-actions\s*\{[^}]*display:\s*flex/s);
});

test("화면 자산은 외부 네트워크 자원에 의존하지 않는다", async () => {
  const files = ["apps/index.html", "apps/css/app.css", "apps/js/app.ts"];
  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /(?:src|href)=["']https?:\/\//);
  }
});

test("공유 JSON 계약 파일이 모두 파싱된다", async () => {
  const directories = ["shared/constants", "shared/schemas"];
  for (const directory of directories) {
    const entries = await readdir(path.join(root, directory));
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const content = await readFile(path.join(root, directory, entry), "utf8");
      assert.doesNotThrow(() => JSON.parse(content), `${directory}/${entry}`);
    }
  }
});

test("AI 작업 영역은 빈 자리표시자만 유지한다", async () => {
  const aiDirectories = [
    "ml/config", "ml/notebook", "ml/result/figure", "ml/src/data", "ml/src/evaluation", "ml/src/export", "ml/src/models", "ml/test",
    "edge/src/inference", "edge/src/tracking", "edge/src/analysis", "edge/src/rules",
  ];
  for (const directory of aiDirectories) {
    const entries = await readdir(path.join(root, directory));
    assert.deepEqual(entries, [".gitkeep"], directory);
  }
});
