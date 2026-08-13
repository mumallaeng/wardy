import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

test("주요 운영 화면과 명시적인 안전 감지 연결 상태를 제공한다", async () => {
  const html = await readFile(path.join(root, "apps/index.html"), "utf8");
  for (const view of ["dashboard", "events", "data", "settings", "jetson"]) {
    assert.match(html, new RegExp(`data-view-panel=["']${view}["']`));
  }
  for (const id of ["start-camera", "event-table-body", "jetson-form", "check-jetson"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const id of ["generate-ai-summary", "ai-summary-output", "ai-summary-badge"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /ON-DEVICE LLM/);
  assert.match(html, /이름·식별자·사진·영상은 프롬프트에 포함하지 않으며/);
  assert.match(html, /안전 감지 미연결/);
  assert.match(html, /M-02가 로컬에서 식별 특징을 생성해 등록 인물과 비교합니다/);
  assert.match(html, /온디바이스 안전 감지 · 요청형 이벤트 요약/);
  assert.doesNotMatch(html, /데모 이벤트 추가|표시 예시 켜기|검토 UI 예시|UI 상태 미리보기/);
  assert.match(html, /카메라 표시 항목/);
  assert.match(html, /돌봄 인물 등록/);
  assert.match(html, /알림 설정/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /id="enable-browser-notifications"/);
  assert.match(html, /id="fall-incident"/);
  assert.match(html, /낙상 의심 확인/);
  assert.match(html, /data-fall-action="confirm">확인</);
  assert.match(html, /data-fall-action="false-detection">오탐</);
  assert.doesNotMatch(html, /상황별 알림/);
  assert.match(html, /카메라 촬영/);
  assert.match(html, /실제 모델 학습은 Notebook 단계/);
  assert.match(html, /데이터 작업실/);
  for (const id of ["dataset-sample-form", "dataset-file-input", "dataset-sample-list", "dataset-version", "export-dataset-manifest"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /id="dataset-preview-dialog"/);
  const dataWorkspace = await readFile(path.join(root, "apps/js/data-workspace.ts"), "utf8");
  assert.match(dataWorkspace, /sample\.reviewStatus === status && label\.value\.trim\(\) === sample\.label/);
  const appSource = await readFile(path.join(root, "apps/js/app.ts"), "utf8");
  assert.match(appSource, /searchParams\.get\("jetson"\)/);
  assert.match(appSource, /applyLaunchConfiguration/);
  assert.match(appSource, /IDENTITY_PREVIEW_LIMIT = 8/);
  assert.match(appSource, /renderFallIncident/);
  assert.match(appSource, /추후 모델 학습용 판정 자료로 저장됩니다/);
  assert.match(appSource, /loading\.controller\.abort\(\)/);
  assert.match(appSource, /controller\.signal/);
  assert.match(appSource, /generation !== datasetPreviewGeneration/);
  assert.match(appSource, /if \(!dialog\.open\) dialog\.showModal\(\)/);
  assert.match(html, /Jetson camera 촬영/);
  assert.match(html, /Dataset manifest 내보내기/);
  assert.match(html, /원본을 덮어쓰지 않고/);
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
  assert.match(html, /<code>\/dev\/video0<\/code>/);
  assert.match(html, /V4L2/);
});

test("기기별 원클릭 시작 스크립트와 실패 복구 안내를 제공한다", async () => {
  const jetson = await readFile(path.join(root, "start_jetson.sh"), "utf8");
  const macos = await readFile(path.join(root, "start_macos.sh"), "utf8");
  const windows = await readFile(path.join(root, "start_windows.ps1"), "utf8");
  assert.match(jetson, /setup_jetson\.sh/);
  assert.match(jetson, /Initial setup is still running/);
  assert.match(jetson, /systemctl restart wardy-pose-fall\.service wardy-edge\.service/);
  assert.match(macos, /npm run serve/);
  assert.match(macos, /search|\?jetson=/);
  assert.match(macos, /ssh -N/);
  assert.match(macos, /trap cleanup EXIT/);
  assert.match(windows, /npm run serve/);
  for (const source of [jetson, macos, windows]) {
    assert.match(source, /\[실패\]/);
    assert.match(source, /다음 명령/);
  }
});

test("설치형 웹앱 shell과 새 이벤트 브라우저 알림을 제공한다", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(root, "apps/public/manifest.webmanifest"), "utf8",
  ));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.id, "/");
  assert.deepEqual(new Set(manifest.icons.map((icon) => icon.sizes)),
    new Set(["192x192", "512x512"]));
  assert.ok(manifest.icons.every((icon) => icon.purpose === "any"));
  const serviceWorker = await readFile(path.join(root, "apps/js/service-worker.ts"), "utf8");
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /Wardy is offline/);
  assert.match(serviceWorker, /isApplicationShellPath\(url\.pathname\)/);
  assert.doesNotMatch(serviceWorker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /__WARDY_BUILD_ID__/);
  const pwa = await readFile(path.join(root, "apps/js/pwa.ts"), "utf8");
  assert.match(pwa, /register\("\/service-worker\.js"/);
  assert.match(pwa, /scope: "\/"/);
  const app = await readFile(path.join(root, "apps/js/app.ts"), "utf8");
  assert.match(app, /Notification\.requestPermission\(\)/);
});

test("카메라 연결 placeholder와 거울 모드는 실제 상태에 맞게 전환된다", async () => {
  const html = await readFile(path.join(root, "apps/index.html"), "utf8");
  const css = await readFile(path.join(root, "apps/css/app.css"), "utf8");
  const app = await readFile(path.join(root, "apps/js/app.ts"), "utf8");
  const overlay = await readFile(path.join(root, "apps/js/overlay.ts"), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.camera-stage\.is-mirrored video/);
  assert.match(app, /camera-empty.*hidden = status === "connected"/);
  assert.match(app, /setCameraMirrored/);
  assert.match(app, /connectConfiguredJetson/);
  assert.match(app, /status === "fault".*reconnectTimer/s);
  assert.doesNotMatch(app, /JetsonCredentialStore|sessionStorage/);
  assert.doesNotMatch(html, /데이터 API 토큰|카메라 읽기 토큰/);
  assert.match(html, /내부 인증 정보는 Jetson 밖으로 전달하지 않습니다/);
  assert.doesNotMatch(app, /window\.open/);
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

test("UI, event runtime, 승인된 AI inference 경계를 분리한다", async () => {
  const aiDirectories = {
    "edge/src/inference": [
      "person_detector.cpp",
      "person_detector.hpp",
      "person_detector_postprocess.cpp",
      "person_detector_postprocess.hpp",
      "person_inference_runtime.cpp",
      "person_inference_runtime.hpp",
      "inference_output.cpp",
      "inference_output.hpp",
      "pose_fall_client.cpp",
      "pose_fall_client.hpp",
      "pose_fall_probe.cpp",
    ],
    "edge/src/analysis": [".gitkeep"],
  };
  for (const [directory, allowedEntries] of Object.entries(aiDirectories)) {
    const entries = await readdir(path.join(root, directory));
    assert.deepEqual(entries.sort(), allowedEntries.sort(), directory);
  }
  const service = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  const app = await readFile(path.join(root, "apps/js/app.ts"), "utf8");
  assert.match(service, /PersonInferenceRuntime/);
  assert.match(service, /person_inference->submit/);
  assert.match(app, /INFERENCE_STALE_MS/);
  assert.match(app, /inferenceIsStale\(\)/);
  for (const file of ["apps/js/app.ts", "edge/src/rules/event_runtime.cpp"]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /ml\/src|src\/inference|src\/tracking|src\/analysis/, file);
  }
  const edgeService = await readFile(path.join(root, "edge/src/api/mjpeg_service.cpp"), "utf8");
  assert.match(edgeService, /inference\/inference_output\.hpp/);
  assert.match(edgeService, /pose_fall_client/);
  assert.doesNotMatch(edgeService, /ml\/src/);
});

test("식별 검토 화면은 Jetson에 저장된 장면과 답변 API를 사용한다", async () => {
  const workspace = await readFile(path.join(root, "apps/js/data-workspace.ts"), "utf8");

  assert.match(workspace, /dataset\.reviewImage/);
  assert.match(workspace, /dataset\.reviewRequiresSubject/);
  assert.match(workspace, /aria-live/);
  assert.doesNotMatch(workspace, /미리보기 연결 전/);
});
