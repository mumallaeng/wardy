import { CARE_STATUS, DEMO_DETECTIONS, EVENT_TYPES } from "./constants.ts";
import { JetsonCameraController } from "./camera.ts";
import { JetsonCredentialStore } from "./credentials.ts";
import { filterEvents, formatDateTime, renderEventRows, summarizeEvents } from "./events.ts";
import { JetsonConnection, normalizeJetsonBaseUrl } from "./jetson.ts";
import { identityFeedbackManifest, renderIdentityReviews } from "./data-workspace.ts";
import { OverlayController } from "./overlay.ts";
import { renderManagedItems, renderNotifications, renderOverlaySettings, renderSubjects, renderZones } from "./settings.ts";
import { WardyStore } from "./store.ts";
import { TrainingSampleClient } from "./training.ts";
import { WardyRuntimeClient } from "./runtime.ts";
import type { CameraStatus, CareStatus, EventFilters, JetsonStatus, JetsonStatusDetail, ManagedItemPolicy, OverlaySettingKey, OverlaySettings, SystemState, WardyEvent, WardyState } from "./types.ts";

type ViewName = "dashboard" | "events" | "data" | "settings" | "jetson";

/**
 * Finds a required element within the specified root node.
 *
 * @param selector - The CSS selector for the required element
 * @param root - The node within which to search
 * @returns The matching element
 * @throws Error if no matching element is found
 */
function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`필수 UI 요소를 찾을 수 없습니다: ${selector}`);
  return element;
}

/**
 * Finds all elements matching a CSS selector within a parent node.
 *
 * @param selector - The CSS selector to match
 * @param root - The parent node to search
 * @returns An array of matching elements
 */
function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/**
 * Converts an unknown error value into a displayable message.
 *
 * @param error - The error value to convert
 * @returns The error message, or the string representation of the value
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const store = new WardyStore(window.localStorage);
const credentialStore = new JetsonCredentialStore(window.sessionStorage);
const trainingSamples = new TrainingSampleClient();
const runtime = new WardyRuntimeClient();
let demoOverlayEnabled = false;
let jetsonStatus: JetsonStatus = "idle";
let cameraStatus: CameraStatus = "idle";
let reconnectTimer: number | null = null;
let runtimeState: SystemState | null = null;

function runtimeConnection(): { baseUrl: string; accessToken: string; origin: string } {
  return {
    baseUrl: store.getState().settings.jetson.baseUrl,
    accessToken: credentialStore.get().accessToken,
    origin: window.location.origin,
  };
}

function applyRuntimeSnapshot(snapshot: { state: SystemState; events: WardyEvent[] }): void {
  runtimeState = snapshot.state;
  store.applyRuntimeSnapshot(snapshot.state, snapshot.events);
  renderSystemState();
}

function renderSystemState(): void {
  const detectionLabels = { disconnected: "AI 미연결", ready: "준비됨", running: "실행 중", fault: "오류" } as const;
  const eventLabels = { ready: "준비됨", processing: "처리 중", fault: "오류" } as const;
  $("#detection-status").textContent = runtimeState ? detectionLabels[runtimeState.detection_state] : "AI 미연결";
  $("#event-runtime-status").textContent = runtimeState ? eventLabels[runtimeState.event_state] : "연결 대기";
  $("#event-runtime-dot").className = `status-dot${runtimeState?.event_state === "ready" ? " is-ok" : runtimeState?.event_state === "fault" ? " is-fault" : ""}`;
}

/**
 * Displays a temporary notification message.
 *
 * @param message - The message to display
 */
function toast(message: string): void {
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  $("#toast-region").append(element);
  window.setTimeout(() => element.remove(), 3200);
}

/**
 * Activates the specified view and updates the URL hash.
 *
 * @param viewName - The view to display
 */
function openView(viewName: ViewName): void {
  $$<HTMLButtonElement>(".nav-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.viewPanel === viewName));
  history.replaceState(null, "", `#${viewName}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const overlay = new OverlayController($<HTMLCanvasElement>("#overlay"), $("#camera-stage"), $<HTMLVideoElement>("#camera"), (zone) => {
  store.addZone(zone);
  toast(`'${zone.name}' 구역을 로컬에 저장했습니다.`);
});

/**
 * Updates the camera status display and controls to reflect the current state.
 *
 * @param status - The camera connection state to display.
 */
function setCameraStatus(status: CameraStatus): void {
  cameraStatus = status;
  const labels: Record<CameraStatus, string> = { idle: "대기", connecting: "연결 중", connected: "정상", fault: "연결 끊김" };
  $("#camera-status").textContent = labels[status] ?? status;
  $("#camera-dot").className = `status-dot${status === "connected" ? " is-ok" : status === "fault" ? " is-fault" : ""}`;
  $("#camera-empty").hidden = status === "connected";
  $<HTMLButtonElement>("#start-camera").disabled = status === "connected" || status === "connecting";
  $<HTMLButtonElement>("#stop-camera").disabled = status !== "connected";
  if (status === "fault" && credentialStore.get().viewerToken && reconnectTimer === null) {
    reconnectTimer = window.setTimeout(() => { void connectConfiguredJetson(true).catch(() => undefined); }, 5000);
  }
}

const camera = new JetsonCameraController($<HTMLVideoElement>("#camera"), setCameraStatus);

/**
 * Updates the Jetson connection status and related interface elements.
 *
 * @param status - The current Jetson connection state
 * @param detail - Optional service, version, endpoint, or status message details
 */
function setJetsonStatus(status: JetsonStatus, detail: JetsonStatusDetail = {}): void {
  jetsonStatus = status;
  const labels: Record<JetsonStatus, string> = { idle: "확인 전", connecting: "연결 확인 중", connected: "연결됨", fault: "연결 실패" };
  const connected = status === "connected";
  $("#jetson-status").textContent = labels[status] ?? status;
  $("#jetson-dot").className = `status-dot${connected ? " is-ok" : status === "fault" ? " is-fault" : ""}`;
  $("#jetson-badge").textContent = labels[status] ?? status;
  $("#jetson-badge").className = `badge${connected ? " is-connected" : status === "fault" ? " is-fault" : ""}`;
  $<HTMLButtonElement>("#check-jetson").disabled = status === "connecting";
  $("#jetson-result").textContent = connected
    ? `${detail.service ?? "wardy-edge"}${detail.version ? ` ${detail.version}` : ""} · ${detail.endpoint ?? ""}`
    : detail.message ?? (status === "connecting" ? `${detail.endpoint ?? "Jetson endpoint"} 확인 중` : "연결 확인을 실행해 주세요.");
}

const jetson = new JetsonConnection({ onStatus: setJetsonStatus });

/**
 * Checks the configured Jetson Wardy service connection and reports the result to the user.
 */
async function connectConfiguredJetson(startCamera = true): Promise<void> {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const configured = store.getState().settings.jetson;
  const credentials = credentialStore.get();
  if (!configured.baseUrl) return;
  try {
    await jetson.check(configured.baseUrl, window.location.origin);
    if (credentials.accessToken) {
      const [snapshot, collections] = await Promise.all([
        runtime.loadSnapshot(configured.baseUrl, credentials.accessToken, window.location.origin),
        runtime.loadCollections(configured.baseUrl, credentials.accessToken, window.location.origin),
      ]);
      applyRuntimeSnapshot(snapshot);
      store.replaceSubjects(collections.subjects);
      store.replaceManagedItems(collections.managedItems);
      runtime.connect(configured.baseUrl, credentials.accessToken, window.location.origin, applyRuntimeSnapshot);
    } else {
      runtime.stop();
    }
    if (startCamera && credentials.viewerToken && cameraStatus !== "connected" && cameraStatus !== "connecting") {
      await camera.start(configured.baseUrl, credentials.viewerToken, window.location.origin);
    }
  } catch (error) {
    if (startCamera && reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => { void connectConfiguredJetson(true); }, 5000);
    }
    throw error;
  }
}

async function checkJetsonConnection(): Promise<void> {
  try {
    const cameraConfigured = Boolean(credentialStore.get().viewerToken);
    await connectConfiguredJetson(true);
    toast(cameraConfigured
      ? "Jetson Wardy 서비스와 카메라에 연결했습니다."
      : "Jetson Wardy 서비스에 연결했습니다. 카메라 연결에는 읽기 토큰이 필요합니다.");
  } catch (error) {
    toast(errorMessage(error));
  }
}

/**
 * Renders the current care status and highlights its corresponding control.
 *
 * @param state - The current Wardy application state
 */
function renderCareState(state: WardyState): void {
  const care = state.careState.status ? CARE_STATUS[state.careState.status] :
    { label: "확인 불가", reason: "안전 상태를 판단할 수 없습니다.", rank: -1 };
  $("#care-status-label").textContent = care.label;
  $("#care-status-code").textContent = state.careState.status ?? "unavailable";
  $("#care-status-badge").textContent = care.label;
  $("#care-status-reason").textContent = state.careState.reason;
  $("#care-orb").className = `care-orb is-${state.careState.status ?? "unavailable"}`;
  $$("#care-state-controls button").forEach((button) => button.classList.toggle("is-active", button.dataset.careStatus === state.careState.status));
}

/**
 * Renders event summary counts and the most recent event in the dashboard.
 *
 * @param events - Events to summarize and display.
 */
function renderSummary(events: readonly WardyEvent[]): void {
  const summary = summarizeEvents(events);
  const tiles: Array<[string, number]> = [
    ["전체", summary.total], ["주의", summary.caution], ["경고", summary.warning], ["긴급", summary.emergency], ["미확인", summary.unconfirmed],
  ];
  const grid = $("#summary-grid");
  grid.replaceChildren(...tiles.map(([label, value]) => {
    const tile = document.createElement("div");
    tile.className = "summary-tile";
    const name = document.createElement("small");
    name.textContent = label;
    const count = document.createElement("strong");
    count.textContent = String(value);
    tile.append(name, count);
    return tile;
  }));
  const latest = [...events].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0];
  const container = $("#latest-event");
  container.replaceChildren();
  if (latest) {
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = EVENT_TYPES[latest.event_type] ?? latest.event_type;
    const description = document.createElement("small");
    description.textContent = `${formatDateTime(latest.occurred_at)} · ${latest.reason}`;
    copy.append(title, description);
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.textContent = "기록에서 확인";
    button.addEventListener("click", () => openView("events"));
    container.append(copy, button);
  }
}

/**
 * Reads the current event list filter settings from the interface.
 *
 * @returns The active search query, event status filter, and care status filter
 */
function currentFilters(): EventFilters {
  return {
    query: $<HTMLInputElement>("#event-search").value,
    eventStatus: $<HTMLSelectElement>("#event-status-filter").value as NonNullable<EventFilters["eventStatus"]>,
    careStatus: $<HTMLSelectElement>("#care-status-filter").value as NonNullable<EventFilters["careStatus"]>,
  };
}

/**
 * Renders events matching the current filters in the events table.
 *
 * @param events - The events to filter and display
 */
function renderEvents(events: readonly WardyEvent[]): void {
  const filtered = filterEvents(events, currentFilters());
  renderEventRows($<HTMLTableSectionElement>("#event-table-body"), filtered);
  $("#event-empty").hidden = filtered.length > 0;
}

/**
 * Renders the current overlay settings in the dashboard controls.
 *
 * @param settings - The overlay settings to display.
 */
function renderDashboardOverlayControls(settings: OverlaySettings): void {
  $$<HTMLInputElement>('[data-overlay-setting]').forEach((input) => {
    const key = input.dataset.overlaySetting as OverlaySettingKey;
    input.checked = settings[key];
  });
}

/**
 * Captures a training sample for a registered managed item through the Jetson service.
 *
 * @param itemId - The registered managed item ID to capture.
 */
async function captureManagedItemSample(itemId: string): Promise<void> {
  const state = store.getState();
  const credentials = credentialStore.get();
  const item = state.managedItems.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`등록된 물품을 찾을 수 없습니다: ${itemId}`);
  try {
    const result = await trainingSamples.capture(
      item, state.settings.jetson?.baseUrl ?? "", credentials.accessToken, window.location.origin,
    );
    store.setManagedItemSampleCount(item.id, result.sampleCount);
    toast(`'${item.label}' 학습 사진을 Jetson에 저장했습니다. 총 ${result.sampleCount}장`);
  } catch (error) {
    toast(errorMessage(error));
  }
}

/**
 * Captures identity reference data for a registered subject through the Jetson service.
 *
 * @param subjectId - The registered subject ID to capture.
 */
async function captureSubjectReference(subjectId: string): Promise<void> {
  const state = store.getState();
  const credentials = credentialStore.get();
  const subject = state.subjects.find((candidate) => candidate.id === subjectId);
  if (!subject) throw new Error(`등록된 인물을 찾을 수 없습니다: ${subjectId}`);
  try {
    const result = await trainingSamples.captureSubject(
      subject, state.settings.jetson?.baseUrl ?? "", credentials.accessToken, window.location.origin,
    );
    store.setSubjectReferenceSampleCount(subject.id, result.sampleCount);
    toast(`'${subject.name}' 식별 기준 사진을 Jetson에 저장했습니다. 총 ${result.sampleCount}장`);
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function deleteSubject(subjectId: string): Promise<void> {
  if (!window.confirm("등록 인물과 Jetson에 저장된 기준 사진을 삭제할까요?")) return;
  try {
    const connection = runtimeConnection();
    const subjects = await runtime.deleteSubject(
      connection.baseUrl, connection.accessToken, connection.origin, subjectId,
    );
    store.replaceSubjects(subjects);
    toast("등록 인물과 기준 사진을 삭제했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

async function deleteManagedItem(itemId: string): Promise<void> {
  if (!window.confirm("등록 물품과 Jetson에 저장된 학습 사진을 삭제할까요?")) return;
  try {
    const connection = runtimeConnection();
    const items = await runtime.deleteManagedItem(
      connection.baseUrl, connection.accessToken, connection.origin, itemId,
    );
    store.replaceManagedItems(items);
    toast("등록 물품과 학습 사진을 삭제했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

async function runEventAction(eventId: string,
                              action: "confirm" | "release" | "false-detection"): Promise<void> {
  try {
    const connection = runtimeConnection();
    await runtime.eventAction(connection.baseUrl, connection.accessToken,
      connection.origin, eventId, action);
    applyRuntimeSnapshot(await runtime.loadSnapshot(
      connection.baseUrl, connection.accessToken, connection.origin));
    toast(`${eventId} 처리 상태를 저장했습니다.`);
  } catch (error) { toast(errorMessage(error)); }
}

async function viewEventMedia(eventId: string): Promise<void> {
  try {
    const connection = runtimeConnection();
    const blob = await runtime.loadEventMedia(connection.baseUrl, connection.accessToken,
      connection.origin, eventId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { toast(errorMessage(error)); }
}

async function deleteEventMedia(eventId: string): Promise<void> {
  if (!window.confirm("Jetson에 저장된 이벤트 사진·영상을 삭제할까요?")) return;
  try {
    const connection = runtimeConnection();
    await runtime.deleteEventMedia(connection.baseUrl, connection.accessToken,
      connection.origin, eventId);
    applyRuntimeSnapshot(await runtime.loadSnapshot(
      connection.baseUrl, connection.accessToken, connection.origin));
    toast("이벤트 자료를 Jetson에서 삭제했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

/**
 * Downloads a JSON-serializable value as a local file.
 *
 * @param filename - The download filename.
 * @param value - The value to serialize.
 */
function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Renders the current application state across the Wardy interface.
 *
 * @param state - The application state to display; defaults to the store's current state.
 */
function render(state: WardyState = store.getState()): void {
  renderCareState(state);
  renderSummary(state.events);
  renderEvents(state.events);
  renderDashboardOverlayControls(state.settings.overlay);
  overlay.setSettings(state.settings.overlay);
  overlay.setMirrored(state.settings.camera.mirrored);
  $("#camera-stage").classList.toggle("is-mirrored", state.settings.camera.mirrored);
  const mirrorButton = $<HTMLButtonElement>("#mirror-camera");
  mirrorButton.setAttribute("aria-pressed", String(state.settings.camera.mirrored));
  mirrorButton.textContent = state.settings.camera.mirrored ? "거울 모드 끄기" : "거울 모드 켜기";
  overlay.setZones(state.zones);
  renderOverlaySettings($("#overlay-settings"), state.settings.overlay, (key, value) => store.setOverlaySetting(key, value));
  renderNotifications($("#notification-settings"), state.settings.notifications, (eventType, value) => store.setNotificationSetting(eventType, value));
  renderSubjects($("#subject-list"), state.subjects, (id) => { void deleteSubject(id); }, captureSubjectReference);
  renderSubjects($("#data-subject-list"), state.subjects, (id) => { void deleteSubject(id); }, captureSubjectReference);
  renderIdentityReviews(
    $("#identity-review-gallery"), state.identityReviews, state.subjects,
    (reviewId, decision, subjectId) => store.resolveIdentityReview(reviewId, decision, subjectId),
  );
  const pendingReviews = state.identityReviews.filter((review) => review.decision === "pending").length;
  $("#review-count").textContent = `${pendingReviews}건 대기`;
  renderManagedItems(
    $("#item-list"), state.managedItems,
    (id) => { void deleteManagedItem(id); }, captureManagedItemSample,
  );
  renderZones($("#zone-list"), state.zones, (id) => store.removeZone(id));
  const jetsonInput = $<HTMLInputElement>("#jetson-base-url");
  if (document.activeElement !== jetsonInput) jetsonInput.value = state.settings.jetson.baseUrl;
  const accessTokenInput = $<HTMLInputElement>("#jetson-access-token");
  const viewerTokenInput = $<HTMLInputElement>("#jetson-viewer-token");
  const credentials = credentialStore.get();
  if (document.activeElement !== accessTokenInput) accessTokenInput.value = credentials.accessToken;
  if (document.activeElement !== viewerTokenInput) viewerTokenInput.value = credentials.viewerToken;
  const configured = state.settings.jetson.baseUrl || window.location.origin;
  $("#jetson-resolved-url").textContent = configured;
  $$("#care-state-controls button").forEach((button) => {
    (button as HTMLButtonElement).disabled = state.careState.source === "jetson_runtime";
  });
  renderSystemState();
}

store.subscribe(render);
render();
setCameraStatus("idle");

$$<HTMLButtonElement>('.nav-tab').forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.view as ViewName | undefined;
  if (view) openView(view);
}));
$$<HTMLButtonElement>('[data-open-view]').forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.openView as ViewName | undefined;
  if (view) openView(view);
}));
const initialView = location.hash.slice(1);
if (["dashboard", "events", "data", "settings", "jetson"].includes(initialView)) openView(initialView as ViewName);

$("#start-camera").addEventListener("click", async () => {
  try {
    const baseUrl = store.getState().settings.jetson?.baseUrl ?? "";
    const viewerToken = credentialStore.get().viewerToken;
    const endpoint = await camera.start(baseUrl, viewerToken, window.location.origin);
    toast(`Jetson WebRTC 카메라 stream에 연결합니다: ${endpoint}`);
  } catch (error) {
    setCameraStatus("fault");
    toast(errorMessage(error));
  }
});
$("#mirror-camera").addEventListener("click", () => {
  const mirrored = !store.getState().settings.camera.mirrored;
  store.setCameraMirrored(mirrored);
  toast(mirrored ? "카메라 거울 모드를 켰습니다." : "카메라 거울 모드를 껐습니다.");
});
$("#stop-camera").addEventListener("click", () => { camera.stop(); toast("Jetson 카메라 stream 연결을 중지했습니다."); });
$("#toggle-demo-overlay").addEventListener("click", (event: Event) => {
  demoOverlayEnabled = !demoOverlayEnabled;
  overlay.setDetections(demoOverlayEnabled ? DEMO_DETECTIONS : []);
  $("#demo-watermark").hidden = !demoOverlayEnabled;
  (event.currentTarget as HTMLButtonElement).textContent = demoOverlayEnabled ? "표시 예시 끄기" : "표시 예시 켜기";
});
$$<HTMLInputElement>('[data-overlay-setting]').forEach((input) => input.addEventListener("change", () => {
  store.setOverlaySetting(input.dataset.overlaySetting as OverlaySettingKey, input.checked);
}));
$$<HTMLButtonElement>('#care-state-controls button').forEach((button) => button.addEventListener("click", () => {
  const status = button.dataset.careStatus as CareStatus;
  store.setCareState(status);
}));

$("#demo-event").addEventListener("click", async () => {
  try {
    const connection = runtimeConnection();
    await runtime.createDebugEvent(connection.baseUrl, connection.accessToken, connection.origin);
    applyRuntimeSnapshot(await runtime.loadSnapshot(
      connection.baseUrl, connection.accessToken, connection.origin));
    toast("AI와 연결되지 않은 runtime 검증 event를 Jetson에 저장했습니다.");
  } catch (error) { toast(errorMessage(error)); }
});

[$<HTMLInputElement>("#event-search"), $<HTMLSelectElement>("#event-status-filter"), $<HTMLSelectElement>("#care-status-filter")]
  .forEach((control) => control.addEventListener("input", () => renderEvents(store.getState().events)));
$<HTMLTableSectionElement>("#event-table-body").addEventListener("click", (event: Event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const { action, eventId } = button.dataset;
  if (!eventId) return;
  if (action === "confirm") void runEventAction(eventId, "confirm");
  if (action === "false") void runEventAction(eventId, "false-detection");
  if (action === "release") void runEventAction(eventId, "release");
  if (action === "view-media") void viewEventMedia(eventId);
  if (action === "delete-media") void deleteEventMedia(eventId);
});

$<HTMLFormElement>("#subject-form").addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  if (!name) { toast("이름을 입력해 주세요."); return; }
  try {
    const connection = runtimeConnection();
    const subjects = await runtime.createSubject(connection.baseUrl, connection.accessToken,
      connection.origin, name, String(data.get("role") ?? "").trim() || "돌봄 대상");
    store.replaceSubjects(subjects);
    form.reset();
    toast("등록 인물을 Jetson에 저장했습니다.");
  } catch (error) { toast(errorMessage(error)); }
});
$<HTMLFormElement>("#item-form").addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const policy = String(data.get("policy")) as ManagedItemPolicy;
  const label = String(data.get("label") ?? "").trim();
  if (!label) { toast("물품 이름을 입력해 주세요."); return; }
  try {
    const connection = runtimeConnection();
    const items = await runtime.createManagedItem(connection.baseUrl, connection.accessToken,
      connection.origin, label, policy);
    store.replaceManagedItems(items);
    form.reset();
    toast("등록 물품을 Jetson에 저장했습니다.");
  } catch (error) { toast(errorMessage(error)); }
});
$("#draw-zone").addEventListener("click", () => { openView("dashboard"); overlay.beginZoneDrawing(); toast("카메라 화면에서 주의 구역을 드래그하세요."); });

$("#export-events").addEventListener("click", () => {
  downloadJson(`wardy-events-${new Date().toISOString().slice(0, 10)}.json`, store.getState().events);
});
$("#add-review-demo").addEventListener("click", () => {
  const sequence = store.getState().identityReviews.length + 1;
  store.addIdentityReview({
    imagePath: `demo/identity/review-${String(sequence).padStart(3, "0")}.jpg`,
    capturedAt: new Date().toISOString(),
    predictedName: sequence % 2 ? "조정민" : null,
    confidence: sequence % 2 ? 0.54 : 0.31,
  });
  toast("AI 결과가 아닌 식별 검토 UI 예시를 추가했습니다.");
});
$("#export-identity-feedback").addEventListener("click", () => {
  const state = store.getState();
  downloadJson(
    `wardy-identity-feedback-${new Date().toISOString().slice(0, 10)}.json`,
    identityFeedbackManifest(state.identityReviews, state.subjects),
  );
  toast("현재 로컬 식별 feedback manifest를 내보냈습니다.");
});
$("#reset-local-data").addEventListener("click", () => { if (window.confirm("현재 브라우저의 Wardy demo event와 설정을 초기화할까요?")) { credentialStore.clear(); store.reset(); toast("로컬 데모 데이터를 초기화했습니다."); } });

$<HTMLFormElement>("#jetson-form").addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const rawBaseUrl = $<HTMLInputElement>("#jetson-base-url").value;
  const accessToken = $<HTMLInputElement>("#jetson-access-token").value;
  const viewerToken = $<HTMLInputElement>("#jetson-viewer-token").value;
  try {
    const baseUrl = rawBaseUrl.trim() ? normalizeJetsonBaseUrl(rawBaseUrl) : "";
    credentialStore.set(accessToken, viewerToken);
    store.setJetsonBaseUrl(baseUrl);
    setJetsonStatus("idle");
    await checkJetsonConnection();
  } catch (error) {
    const message = errorMessage(error);
    setJetsonStatus("fault", { message });
    toast(message);
  }
});
$("#check-jetson").addEventListener("click", checkJetsonConnection);

window.addEventListener("beforeunload", () => { camera.stop(); runtime.stop(); });
window.addEventListener("online", () => { void connectConfiguredJetson(true).catch(() => undefined); });

setJetsonStatus(jetsonStatus);
void connectConfiguredJetson(true).catch(() => undefined);
