import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

test("주요 비AI 화면과 명시적 AI 미연결 표시를 제공한다", async () => {
  const html = await readFile(path.join(root, "apps/index.html"), "utf8");
  for (const view of ["dashboard", "events", "data", "settings", "jetson"]) {
    assert.match(html, new RegExp(`data-view-panel=["']${view}["']`));
  }
  for (const id of ["start-camera", "event-table-body", "jetson-form", "check-jetson"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /AI 미연결/);
  assert.match(html, /AI 결과 아님/);
  assert.match(html, /카메라 표시 항목/);
  assert.match(html, /돌봄 인물 등록/);
  assert.match(html, /알림 설정/);
  assert.doesNotMatch(html, /상황별 알림/);
  assert.match(html, /카메라 촬영/);
  assert.match(html, /실제 모델 학습은 Notebook 단계/);
  assert.match(html, /데이터 작업실/);
  assert.match(html, /식별 검토 갤러리/);
  assert.match(html, /기준 사진 촬영/);
  assert.match(html, /현재 실행 중인 모델은 바뀌지 않습니다/);
  assert.match(html, /위험물·제외 물건/);
  assert.doesNotMatch(html, /관리 물품 이동|의료기기 탐지/);
  assert.doesNotMatch(html, /사람 위 표시 항목|돌봄 대상자 등록 UI/);
  assert.doesNotMatch(html, /Arduino|ARDUINO|아두이노|Web Serial|buzzer|부저/);
  assert.match(html, /\/api\/health/);
  assert.match(html, /:8443\/wardy\/whep/);
  assert.match(html, /<video id="camera"/);
  assert.match(html, /id="mirror-camera"/);
  assert.match(html, /id="start-camera"[^>]*>Jetson 카메라 연결<\/button><button[^>]*id="stop-camera"[^>]*>카메라 연결 중지<\/button>/);
  assert.match(html, /WebRTC\/UDP/);
  assert.match(html, /event·state 동기화<\/dt><dd>인증 WebSocket · 자동 재연결/);
  assert.match(html, /\/dev\/video0/);
  assert.match(html, /V4L2/);
});

test("카메라 연결 placeholder와 거울 모드는 실제 상태에 맞게 전환된다", async () => {
  const css = await readFile(path.join(root, "apps/css/app.css"), "utf8");
  const app = await readFile(path.join(root, "apps/js/app.ts"), "utf8");
  const overlay = await readFile(path.join(root, "apps/js/overlay.ts"), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.camera-stage\.is-mirrored video/);
  assert.match(app, /camera-empty.*hidden = status === "connected"/);
  assert.match(app, /setCameraMirrored/);
  assert.match(app, /connectConfiguredJetson/);
  assert.match(app, /status === "fault".*reconnectTimer/s);
  assert.match(app, /JetsonCredentialStore\(window\.sessionStorage\)/);
  assert.match(overlay, /setMirrored/);
  assert.match(overlay, /1 - zone\.x - zone\.width/);
});

test("카메라 화면은 브라우저 장치 대신 Jetson WebRTC stream만 사용한다", async () => {
  const entries = await readdir(path.join(root, "apps/js"));
  const sources = await Promise.all(entries.filter((entry) => entry.endsWith(".ts")).map((entry) => readFile(path.join(root, "apps/js", entry), "utf8")));
  const joined = sources.join("\n");
  assert.match(joined, /url\.protocol !== "https:"/);
  assert.match(joined, /\/wardy\/whep/);
  assert.match(joined, /RTCPeerConnection/);
  assert.match(joined, /X-Wardy-Access-Token/);
  assert.doesNotMatch(joined, /getUserMedia|navigator\.mediaDevices/);
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

test("비AI runtime은 AI 구현 파일을 import하지 않는다", async () => {
  const aiDirectories = [
    "edge/src/inference", "edge/src/tracking", "edge/src/analysis",
  ];
  for (const directory of aiDirectories) {
    const entries = await readdir(path.join(root, directory));
    assert.deepEqual(entries, [".gitkeep"], directory);
  }
  for (const file of ["apps/js/app.ts", "edge/src/api/mjpeg_service.cpp", "edge/src/rules/event_runtime.cpp"]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /ml\/src|src\/inference|src\/tracking|src\/analysis/, file);
  }
});
