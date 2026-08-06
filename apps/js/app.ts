import { CARE_STATUS, DEMO_DETECTIONS, EVENT_TYPES, createDemoEvent } from "./constants.ts";
import { JetsonCameraController } from "./camera.ts";
import { filterEvents, formatDateTime, renderEventRows, summarizeEvents } from "./events.ts";
import { JetsonConnection, normalizeJetsonBaseUrl } from "./jetson.ts";
import { OverlayController } from "./overlay.ts";
import { renderManagedItems, renderNotifications, renderOverlaySettings, renderSubjects, renderZones } from "./settings.ts";
import { WardyStore } from "./store.ts";
import type { CameraStatus, CareStatus, EventFilters, JetsonStatus, JetsonStatusDetail, ManagedItemPolicy, OverlaySettingKey, OverlaySettings, WardyEvent, WardyState } from "./types.ts";

type ViewName = "dashboard" | "events" | "settings" | "jetson";

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
let demoOverlayEnabled = false;
let jetsonStatus: JetsonStatus = "idle";

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
  const labels: Record<CameraStatus, string> = { idle: "대기", connecting: "연결 중", connected: "정상", fault: "연결 끊김" };
  $("#camera-status").textContent = labels[status] ?? status;
  $("#camera-dot").className = `status-dot${status === "connected" ? " is-ok" : status === "fault" ? " is-fault" : ""}`;
  $("#camera-empty").hidden = status === "connected";
  $<HTMLButtonElement>("#start-camera").disabled = status === "connected" || status === "connecting";
  $<HTMLButtonElement>("#stop-camera").disabled = status !== "connected";
}

const camera = new JetsonCameraController($<HTMLImageElement>("#camera"), setCameraStatus);

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
async function checkJetsonConnection() {
  const baseUrl = store.getState().settings.jetson?.baseUrl ?? "";
  try {
    await jetson.check(baseUrl, window.location.origin);
    toast("Jetson Wardy 서비스에 연결했습니다.");
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
  const care = CARE_STATUS[state.careState.status] ?? CARE_STATUS.normal;
  $("#care-status-label").textContent = care.label;
  $("#care-status-code").textContent = state.careState.status;
  $("#care-status-badge").textContent = care.label;
  $("#care-status-reason").textContent = state.careState.reason;
  $("#care-orb").className = `care-orb is-${state.careState.status}`;
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
  overlay.setZones(state.zones);
  renderOverlaySettings($("#overlay-settings"), state.settings.overlay, (key, value) => store.setOverlaySetting(key, value));
  renderNotifications($("#notification-settings"), state.settings.notifications, (eventType, value) => store.setNotificationSetting(eventType, value));
  renderSubjects($("#subject-list"), state.subjects, (id) => store.removeSubject(id));
  renderManagedItems($("#item-list"), state.managedItems, (id) => store.removeManagedItem(id));
  renderZones($("#zone-list"), state.zones, (id) => store.removeZone(id));
  const jetsonInput = $<HTMLInputElement>("#jetson-base-url");
  if (document.activeElement !== jetsonInput) jetsonInput.value = state.settings.jetson.baseUrl;
  const configured = state.settings.jetson.baseUrl || window.location.origin;
  $("#jetson-resolved-url").textContent = configured;
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
if (["dashboard", "events", "settings", "jetson"].includes(initialView)) openView(initialView as ViewName);

$("#start-camera").addEventListener("click", () => {
  try {
    const baseUrl = store.getState().settings.jetson?.baseUrl ?? "";
    const endpoint = camera.start(baseUrl, window.location.origin);
    toast(`Jetson 카메라 stream에 연결합니다: ${endpoint}`);
  } catch (error) {
    setCameraStatus("fault");
    toast(errorMessage(error));
  }
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

$("#demo-event").addEventListener("click", () => {
  const state = store.getState();
  store.addEvent(createDemoEvent(state.events.length + 1));
  toast("AI와 연결되지 않은 demo event를 추가했습니다.");
});

[$<HTMLInputElement>("#event-search"), $<HTMLSelectElement>("#event-status-filter"), $<HTMLSelectElement>("#care-status-filter")]
  .forEach((control) => control.addEventListener("input", () => renderEvents(store.getState().events)));
$<HTMLTableSectionElement>("#event-table-body").addEventListener("click", (event: Event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const { action, eventId } = button.dataset;
  if (!eventId) return;
  if (action === "confirm") { store.confirmEvent(eventId); toast(`${eventId}를 확인 상태로 변경했습니다.`); }
  if (action === "false") { store.markFalseDetection(eventId); toast(`${eventId}를 오탐으로 기록했습니다.`); }
  if (action === "delete-media" && window.confirm("이 event의 로컬 자료 경로 metadata를 삭제할까요?")) { store.removeEventMedia(eventId); toast("event 자료 정보를 삭제했습니다."); }
});

$<HTMLFormElement>("#subject-form").addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  if (!name) { toast("이름을 입력해 주세요."); return; }
  store.addSubject(name, String(data.get("role") ?? "").trim() || "돌봄 대상");
  form.reset();
});
$<HTMLFormElement>("#item-form").addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const policy = String(data.get("policy")) as ManagedItemPolicy;
  const label = String(data.get("label") ?? "").trim();
  if (!label) { toast("물품 이름을 입력해 주세요."); return; }
  store.addManagedItem(label, policy);
  form.reset();
});
$("#draw-zone").addEventListener("click", () => { openView("dashboard"); overlay.beginZoneDrawing(); toast("카메라 화면에서 주의 구역을 드래그하세요."); });

$("#export-events").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store.getState().events, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `wardy-events-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});
$("#reset-local-data").addEventListener("click", () => { if (window.confirm("현재 브라우저의 Wardy demo event와 설정을 초기화할까요?")) { store.reset(); toast("로컬 데모 데이터를 초기화했습니다."); } });

$<HTMLFormElement>("#jetson-form").addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const rawBaseUrl = $<HTMLInputElement>("#jetson-base-url").value;
  try {
    if (rawBaseUrl.trim()) normalizeJetsonBaseUrl(rawBaseUrl);
    store.setJetsonBaseUrl(rawBaseUrl);
    setJetsonStatus("idle");
    await checkJetsonConnection();
  } catch (error) {
    const message = errorMessage(error);
    setJetsonStatus("fault", { message });
    toast(message);
  }
});
$("#check-jetson").addEventListener("click", checkJetsonConnection);

window.addEventListener("beforeunload", () => camera.stop());

setJetsonStatus(jetsonStatus);
