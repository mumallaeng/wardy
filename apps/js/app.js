import { CARE_STATUS, DEMO_DETECTIONS, EVENT_TYPES, createDemoEvent } from "./constants.js";
import { CameraController } from "./camera.js";
import { filterEvents, formatDateTime, renderEventRows, sortEvents, summarizeEvents } from "./events.js";
import { JetsonConnection, normalizeJetsonBaseUrl } from "./jetson.js";
import { OverlayController } from "./overlay.js";
import { renderManagedItems, renderNotifications, renderOverlaySettings, renderSubjects, renderZones } from "./settings.js";
import { WardyStore } from "./store.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const store = new WardyStore(window.localStorage);
let demoOverlayEnabled = false;
let jetsonStatus = "idle";

function toast(message) {
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  $("#toast-region").append(element);
  window.setTimeout(() => element.remove(), 3200);
}

function openView(viewName) {
  $$(".nav-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.viewPanel === viewName));
  history.replaceState(null, "", `#${viewName}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const overlay = new OverlayController($("#overlay"), $("#camera-stage"), (zone) => {
  store.addZone(zone);
  toast(`'${zone.name}' 구역을 로컬에 저장했습니다.`);
});

function setCameraStatus(status) {
  const labels = { idle: "대기", connecting: "연결 중", connected: "정상", fault: "연결 끊김" };
  $("#camera-status").textContent = labels[status] ?? status;
  $("#camera-dot").className = `status-dot${status === "connected" ? " is-ok" : status === "fault" ? " is-fault" : ""}`;
  $("#camera-empty").hidden = status === "connected";
  $("#start-camera").disabled = status === "connected" || status === "connecting";
  $("#stop-camera").disabled = status !== "connected";
}

const camera = new CameraController($("#camera"), setCameraStatus);

function setJetsonStatus(status, detail = {}) {
  jetsonStatus = status;
  const labels = { idle: "확인 전", connecting: "연결 확인 중", connected: "연결됨", fault: "연결 실패" };
  const connected = status === "connected";
  $("#jetson-status").textContent = labels[status] ?? status;
  $("#jetson-dot").className = `status-dot${connected ? " is-ok" : status === "fault" ? " is-fault" : ""}`;
  $("#jetson-badge").textContent = labels[status] ?? status;
  $("#jetson-badge").className = `badge${connected ? " is-connected" : status === "fault" ? " is-fault" : ""}`;
  $("#check-jetson").disabled = status === "connecting";
  $("#jetson-result").textContent = connected
    ? `${detail.service}${detail.version ? ` ${detail.version}` : ""} · ${detail.endpoint}`
    : detail.message ?? (status === "connecting" ? `${detail.endpoint} 확인 중` : "연결 확인을 실행해 주세요.");
}

const jetson = new JetsonConnection({ onStatus: setJetsonStatus });

async function checkJetsonConnection() {
  const baseUrl = store.getState().settings.jetson?.baseUrl ?? "";
  try {
    await jetson.check(baseUrl, window.location.origin);
    toast("Jetson Wardy 서비스에 연결했습니다.");
  } catch (error) {
    toast(error.message);
  }
}

function renderCareState(state) {
  const care = CARE_STATUS[state.careState.status] ?? CARE_STATUS.normal;
  $("#care-status-label").textContent = care.label;
  $("#care-status-code").textContent = state.careState.status;
  $("#care-status-badge").textContent = care.label;
  $("#care-status-reason").textContent = state.careState.reason;
  $("#care-orb").className = `care-orb is-${state.careState.status}`;
  $$("#care-state-controls button").forEach((button) => button.classList.toggle("is-active", button.dataset.careStatus === state.careState.status));
}

function renderSummary(events) {
  const summary = summarizeEvents(events);
  const tiles = [
    ["전체", summary.total], ["주의", summary.caution], ["경고", summary.warning], ["긴급", summary.emergency], ["미확인", summary.unconfirmed],
  ];
  const grid = $("#summary-grid");
  grid.replaceChildren(...tiles.map(([label, value]) => {
    const tile = document.createElement("div");
    tile.className = "summary-tile";
    const name = document.createElement("small");
    name.textContent = label;
    const count = document.createElement("strong");
    count.textContent = value;
    tile.append(name, count);
    return tile;
  }));
  const latest = [...events].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))[0];
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

function currentFilters() {
  return { query: $("#event-search").value, eventStatus: $("#event-status-filter").value, careStatus: $("#care-status-filter").value };
}

function renderEvents(events) {
  const filtered = filterEvents(events, currentFilters());
  renderEventRows($("#event-table-body"), filtered);
  $("#event-empty").hidden = filtered.length > 0;
}

function renderDashboardOverlayControls(settings) {
  $$('[data-overlay-setting]').forEach((input) => { input.checked = Boolean(settings[input.dataset.overlaySetting]); });
}

function render(state = store.getState()) {
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
  if (document.activeElement !== $("#jetson-base-url")) $("#jetson-base-url").value = state.settings.jetson?.baseUrl ?? "";
  const configured = state.settings.jetson?.baseUrl || window.location.origin;
  $("#jetson-resolved-url").textContent = configured;
}

store.subscribe(render);
render();
setCameraStatus("idle");

$$('.nav-tab').forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
$$('[data-open-view]').forEach((button) => button.addEventListener("click", () => openView(button.dataset.openView)));
const initialView = location.hash.slice(1);
if (["dashboard", "events", "settings", "jetson"].includes(initialView)) openView(initialView);

$("#start-camera").addEventListener("click", async () => {
  try { await camera.start(); toast("카메라 영상을 로컬 화면에 표시합니다."); }
  catch (error) { toast(error.name === "NotAllowedError" ? "카메라 권한이 허용되지 않았습니다." : error.message); }
});
$("#stop-camera").addEventListener("click", () => { camera.stop(); toast("카메라를 중지했습니다."); });
$("#toggle-demo-overlay").addEventListener("click", (event) => {
  demoOverlayEnabled = !demoOverlayEnabled;
  overlay.setDetections(demoOverlayEnabled ? DEMO_DETECTIONS : []);
  $("#demo-watermark").hidden = !demoOverlayEnabled;
  event.currentTarget.textContent = demoOverlayEnabled ? "표시 예시 끄기" : "표시 예시 켜기";
});
$$('[data-overlay-setting]').forEach((input) => input.addEventListener("change", () => store.setOverlaySetting(input.dataset.overlaySetting, input.checked)));
$$('#care-state-controls button').forEach((button) => button.addEventListener("click", () => store.setCareState(button.dataset.careStatus)));

$("#demo-event").addEventListener("click", () => {
  const state = store.getState();
  store.addEvent(createDemoEvent(state.events.length + 1));
  toast("AI와 연결되지 않은 demo event를 추가했습니다.");
});

[$("#event-search"), $("#event-status-filter"), $("#care-status-filter")].forEach((control) => control.addEventListener("input", () => renderEvents(store.getState().events)));
$("#event-table-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, eventId } = button.dataset;
  if (action === "confirm") { store.confirmEvent(eventId); toast(`${eventId}를 확인 상태로 변경했습니다.`); }
  if (action === "false") { store.markFalseDetection(eventId); toast(`${eventId}를 오탐으로 기록했습니다.`); }
  if (action === "delete-media" && window.confirm("이 event의 로컬 자료 경로 metadata를 삭제할까요?")) { store.removeEventMedia(eventId); toast("event 자료 정보를 삭제했습니다."); }
});

$("#subject-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  store.addSubject(String(data.get("name")).trim(), String(data.get("role")).trim() || "돌봄 대상");
  event.currentTarget.reset();
});
$("#item-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  store.addManagedItem(String(data.get("label")).trim(), String(data.get("policy")));
  event.currentTarget.reset();
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

$("#jetson-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const rawBaseUrl = $("#jetson-base-url").value;
  try {
    if (rawBaseUrl.trim()) normalizeJetsonBaseUrl(rawBaseUrl);
    store.setJetsonBaseUrl(rawBaseUrl);
    setJetsonStatus("idle");
    await checkJetsonConnection();
  } catch (error) {
    setJetsonStatus("fault", { message: error.message });
    toast(error.message);
  }
});
$("#check-jetson").addEventListener("click", checkJetsonConnection);

window.addEventListener("beforeunload", () => camera.stop());

setJetsonStatus(jetsonStatus);
