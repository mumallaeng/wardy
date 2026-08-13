import { CARE_STATUS, EVENT_TYPES, userFacingCareReason, userFacingEventReason } from "./constants.ts";
import { JetsonCameraController } from "./camera.ts";
import { filterEvents, formatDateTime, kstDateKey, renderEventRows, summarizeEvents } from "./events.ts";
import {
  JetsonConnection,
  jetsonBrowserBootstrapUrl,
  normalizeJetsonBaseUrl,
} from "./jetson.ts";
import {
  datasetManifest,
  identityFeedbackManifest,
  renderDatasetSamples,
  renderIdentityReviews,
} from "./data-workspace.ts";
import { OverlayController } from "./overlay.ts";
import { newNotifiableEvents } from "./notifications.ts";
import { registerWardyServiceWorker } from "./pwa.ts";
import { renderManagedItems, renderNotifications, renderOverlaySettings, renderSubjects, renderZones } from "./settings.ts";
import { WardyStore } from "./store.ts";
import { TrainingSampleClient } from "./training.ts";
import { ColorThemeController } from "./theme.ts";
import { WardyRuntimeClient } from "./runtime.ts";
import type { CameraStatus, DataCollectionSettings, DatasetReviewStatus, DatasetSampleMetadata, EventFilters, EventType, IdentityReview, IdentityReviewDecision, InferenceSnapshot, JetsonStatus, JetsonStatusDetail, ManagedItemPolicy, NotificationSetting, OverlaySettingKey, OverlaySettings, SystemState, WardyEvent, WardyState, ZoneRect } from "./types.ts";

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
const colorTheme = new ColorThemeController(window.localStorage, document);
const trainingSamples = new TrainingSampleClient();
const runtime = new WardyRuntimeClient();
let jetsonStatus: JetsonStatus = "idle";
let cameraStatus: CameraStatus = "idle";
let reconnectTimer: number | null = null;
let runtimeState: SystemState | null = null;
let inferenceState: InferenceSnapshot | null = null;
let dataCollectionSettings: DataCollectionSettings | null = null;
let inferenceExpiryTimer: number | null = null;
let datasetPreviewUrl: string | null = null;
let datasetPreviewGeneration = 0;
let knownEventIds: Set<string> | null = null;
const identityReviewUrls = new Map<string, string>();
const identityReviewLoads = new Map<string, {
  promise: Promise<string>;
  controller: AbortController;
}>();
let activeIdentityReviewIds = new Set<string>();
const IDENTITY_PREVIEW_LIMIT = 8;

type SystemGuidanceTone = "setup" | "checking" | "limited" | "fault" | "ok";
const EDGE_GATEWAY_CREDENTIAL = "caddy-managed";
const DEFAULT_JETSON_BASE_URL = String(import.meta.env.VITE_WARDY_JETSON_URL ?? "").trim();
const JETSON_TLS_BOOTSTRAP_PREFIX = "wardy-jetson-tls-bootstrap:";

function jetsonTlsBootstrapKey(baseUrl: string): string {
  return `${JETSON_TLS_BOOTSTRAP_PREFIX}${baseUrl}`;
}

function applyLaunchConfiguration(): boolean {
  const url = new URL(window.location.href);
  const requestedJetson = url.searchParams.get("jetson");
  const bootstrapCompleted = url.searchParams.get("jetson_tls") === "ready";
  const currentJetson = store.getState().settings.jetson.baseUrl;
  const selectedJetson = requestedJetson || currentJetson || DEFAULT_JETSON_BASE_URL;
  if (!selectedJetson) return false;

  const baseUrl = normalizeJetsonBaseUrl(selectedJetson);
  store.setJetsonBaseUrl(baseUrl);
  if (bootstrapCompleted) {
    window.localStorage.setItem(jetsonTlsBootstrapKey(baseUrl), "ready");
  }
  url.searchParams.delete("jetson");
  url.searchParams.delete("jetson_tls");
  window.history.replaceState({}, "", url);

  if (!bootstrapCompleted && window.localStorage.getItem(jetsonTlsBootstrapKey(baseUrl)) !== "ready") {
    window.location.assign(jetsonBrowserBootstrapUrl(baseUrl));
    return true;
  }
  return false;
}

const jetsonTlsRedirecting = applyLaunchConfiguration();

interface SystemGuidance {
  tone: SystemGuidanceTone;
  label: string;
  title: string;
  message: string;
  actionLabel?: string;
}

function runtimeConnection(): { baseUrl: string; accessToken: string; origin: string } {
  return {
    baseUrl: store.getState().settings.jetson.baseUrl,
    accessToken: EDGE_GATEWAY_CREDENTIAL,
    origin: window.location.origin,
  };
}

function applyInferenceSnapshot(snapshot: InferenceSnapshot): void {
  inferenceState = snapshot;
  overlay.setDetections(snapshot.operational ? snapshot.detections : []);
  if (inferenceExpiryTimer !== null) window.clearTimeout(inferenceExpiryTimer);
  inferenceExpiryTimer = window.setTimeout(() => {
    inferenceExpiryTimer = null;
    renderSystemState();
  }, INFERENCE_STALE_MS);
  renderSystemState();
}

function applyRuntimeSnapshot(snapshot: { state: SystemState; events: WardyEvent[]; inference?: InferenceSnapshot }): void {
  runtimeState = snapshot.state;
  store.applyRuntimeSnapshot(snapshot.state, snapshot.events);
  notifyNewEvents(snapshot.events);
  if (snapshot.inference) applyInferenceSnapshot(snapshot.inference);
  renderSystemState();
}

function notifyNewEvents(events: readonly WardyEvent[]): void {
  const currentIds = new Set(events.map((event) => event.event_id));
  if (knownEventIds === null) {
    knownEventIds = currentIds;
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") {
    const settings = store.getState().settings.notifications;
    const eligibleEvents = newNotifiableEvents(events, knownEventIds, settings);
    const displayedEvents = eligibleEvents.length > 3 ? eligibleEvents.slice(0, 1) : eligibleEvents;
    displayedEvents.forEach((event) => {
      const isSummary = eligibleEvents.length > 3;
      const notification = new Notification(isSummary
        ? "Wardy · 새 이벤트"
        : `Wardy · ${EVENT_TYPES[event.event_type]}`, {
        body: isSummary
          ? `새 이벤트 ${eligibleEvents.length}건을 확인해 주세요.`
          : `${event.subject_location ?? "위치 확인 필요"} · ${event.reason}`,
        icon: "/icons/wardy-icon-192.png",
        tag: isSummary ? "wardy-event-summary" : event.event_id,
      });
      notification.addEventListener("click", () => {
        window.focus();
        openView("events");
        notification.close();
      });
    });
  }
  knownEventIds = currentIds;
}

function renderNotificationPermission(): void {
  const supported = "Notification" in window;
  const permission = supported ? Notification.permission : "unsupported";
  const labels: Record<string, string> = {
    default: "브라우저 권한을 허용하면 새 이벤트를 화면 밖에서도 알립니다.",
    granted: "브라우저 알림이 허용되었습니다. ON인 새 이벤트만 알립니다.",
    denied: "브라우저에서 알림이 차단되었습니다. 브라우저 사이트 설정에서 변경할 수 있습니다.",
    unsupported: "이 브라우저는 시스템 알림을 지원하지 않습니다.",
  };
  $("#notification-permission").textContent = labels[permission]
    ?? "브라우저 권한을 허용하면 새 이벤트를 화면 밖에서도 알립니다.";
  const button = $<HTMLButtonElement>("#enable-browser-notifications");
  button.disabled = !supported || permission === "granted";
  button.textContent = permission === "granted" ? "브라우저 알림 허용됨" : "브라우저 알림 허용";
}

const INFERENCE_STALE_MS = 5_000;

function inferenceIsStale(): boolean {
  if (!inferenceState) return false;
  const observed = Date.parse(inferenceState.observed_at);
  return !Number.isFinite(observed) || Date.now() - observed > INFERENCE_STALE_MS;
}

function renderSystemState(): void {
  if (inferenceIsStale()) {
    inferenceState = null;
    overlay.setDetections([]);
  }
  const detectionLabels = { disconnected: "안전 감지 미연결", ready: "준비됨", running: "실행 중", fault: "오류" } as const;
  const eventLabels = { ready: "준비됨", processing: "처리 중", fault: "오류" } as const;
  const detectionState = runtimeState?.detection_state ?? "disconnected";
  const detectionLabel = inferenceState?.source === "temporary" && detectionState === "running"
    ? "임시 출력" : detectionLabels[detectionState];
  $("#detection-status").textContent = detectionLabel;
  $("#detection-dot").className = `status-dot${["ready", "running"].includes(detectionState) ? " is-ok" : detectionState === "fault" ? " is-fault" : " is-muted"}`;
  const inferenceBadge = $("#inference-source-badge");
  inferenceBadge.toggleAttribute("hidden", inferenceState?.source !== "temporary");
  $("#event-runtime-status").textContent = runtimeState ? eventLabels[runtimeState.event_state] : "연결 대기";
  $("#event-runtime-dot").className = `status-dot${runtimeState?.event_state === "ready" ? " is-ok" : runtimeState?.event_state === "fault" ? " is-fault" : ""}`;
  renderFallDetectionStatus();
  renderSystemGuidance();
}

function renderFallDetectionStatus(): void {
  const status = $("#m04-fall-status");
  const detail = $("#m04-fall-detail");
  if (!inferenceState || !inferenceState.operational || inferenceIsStale()) {
    status.textContent = "확인 대기";
    detail.textContent = "M-04 추론 결과를 받지 못했습니다.";
    return;
  }
  const diagnostics = inferenceState.detections
    .map((detection) => detection.fallDiagnostics)
    .filter((diagnostic): diagnostic is NonNullable<typeof diagnostic> => Boolean(diagnostic));
  if (diagnostics.length === 0) {
    status.textContent = "분석 대상 없음";
    detail.textContent = "현재 추적 중인 사람의 자세를 분석하지 않고 있습니다.";
    return;
  }
  const suspected = diagnostics.filter((diagnostic) =>
    diagnostic.fallConfidence !== null && diagnostic.fallConfidence >= diagnostic.fallThreshold);
  const scored = diagnostics.filter((diagnostic) => diagnostic.fallConfidence !== null);
  if (suspected.length === 0 && scored.length < diagnostics.length) {
    status.textContent = "분석 중";
    detail.textContent = "M-04가 자세 시퀀스를 모으고 있습니다.";
    return;
  }
  status.textContent = suspected.length > 0 ? "낙상 의심 감지" : "낙상 의심 없음";
  detail.textContent = suspected.length > 0
    ? `${suspected.length}명에서 낙상 의심 신호를 확인했습니다.`
    : `${diagnostics.length}명의 자세 시퀀스를 분석 중입니다.`;
}

function currentSystemGuidance(): SystemGuidance {
  const hasBaseUrl = Boolean(store.getState().settings.jetson.baseUrl);
  if (!hasBaseUrl) {
    return {
      tone: "setup", label: "연결 준비", title: "Jetson 연결을 설정해 주세요",
      message: "서비스 주소를 최초 1회 저장하면 이후 접속부터 자동으로 다시 연결합니다.",
      actionLabel: "연결 설정 열기",
    };
  }
  if (jetsonStatus === "connecting" || cameraStatus === "connecting") {
    return {
      tone: "checking", label: "자동 연결 중", title: "Jetson 상태를 확인하고 있습니다",
      message: "연결이 끊겨도 Wardy가 자동으로 다시 시도합니다. 잠시 후에도 계속되면 Jetson 서비스를 확인해 주세요.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (jetsonStatus === "fault") {
    return {
      tone: "fault", label: "서비스 이상", title: "Jetson 서비스에 연결할 수 없습니다",
      message: "Jetson 전원과 Wardy 서비스, 같은 network 연결 및 TLS 인증서 신뢰 상태를 확인해 주세요. 연결 전에는 안전 확인이 중단됩니다.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (jetsonStatus === "connected" && !runtimeState) {
    return {
      tone: "limited", label: "동기화 확인 필요", title: "이벤트·상태 정보를 아직 받지 못했습니다",
      message: "Jetson 서비스는 연결됐지만 runtime 상태가 확인되지 않았습니다. 자동 재연결 뒤에도 계속되면 Jetson gateway와 서비스를 확인해 주세요.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (runtimeState?.event_state === "fault") {
    return {
      tone: "fault", label: "이벤트 처리 이상", title: "이벤트 기록 처리가 중단되었습니다",
      message: "현재 판단 결과가 저장되거나 갱신되지 않을 수 있습니다. Jetson 서비스를 다시 확인해 주세요.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (runtimeState?.detection_state === "fault") {
    return {
      tone: "fault", label: "안전 감지 이상", title: "안전 감지 기능이 중단되었습니다",
      message: "카메라 영상이 보여도 의심 상황을 판단하지 못합니다. 감지 기능을 복구한 뒤 상태가 '실행 중'인지 확인해 주세요.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (cameraStatus === "fault") {
    return {
      tone: "fault", label: "카메라 이상", title: "Jetson 카메라 연결이 끊겼습니다",
      message: "Wardy가 5초 간격으로 자동 재연결합니다. 계속 실패하면 camera 연결과 Jetson 서비스를 확인해 주세요.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (runtimeState?.detection_state === "disconnected") {
    return {
      tone: "limited", label: "안전 감지 미연결", title: "현재는 카메라와 이벤트 UI만 사용할 수 있습니다",
      message: "안전 감지가 연결되기 전에는 의심 상황을 판단하지 않습니다. 연결 후에도 감지 결과에는 오탐·미탐 가능성이 있습니다.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (inferenceState?.source === "temporary") {
    return {
      tone: "limited", label: "임시 출력", title: "후속 기능 연결을 검증 중입니다",
      message: "현재 탐지 표시와 이벤트는 실제 모델 대신 구조화된 임시 값으로 생성됩니다. 실제 모델은 같은 출력 계약에 연결됩니다.",
      actionLabel: "연결 상태 보기",
    };
  }
  if (cameraStatus === "idle") {
    return {
      tone: "limited", label: "카메라 중지", title: "카메라 미리보기가 중지되어 있습니다",
      message: "카메라를 다시 연결해야 현재 영상과 안전 확인 상태를 볼 수 있습니다.",
      actionLabel: "연결 상태 보기",
    };
  }
  return {
    tone: "ok", label: "시스템 정상", title: "카메라와 안전 확인 기능이 작동 중입니다",
    message: "감지 결과는 확인을 돕는 정보이며 오탐·미탐 가능성이 있습니다. 긴급 상황은 사용자가 직접 확인해 주세요.",
  };
}

function renderSystemGuidance(): void {
  const guidance = currentSystemGuidance();
  const container = $("#system-guidance");
  container.className = `system-guidance is-${guidance.tone}`;
  $("#system-guidance-label").textContent = guidance.label;
  $("#system-guidance-title").textContent = guidance.title;
  $("#system-guidance-message").textContent = guidance.message;
  const action = $<HTMLButtonElement>("#system-guidance-action");
  action.hidden = !guidance.actionLabel;
  action.textContent = guidance.actionLabel ?? "";
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
  void saveZone(zone);
});

async function saveZone(zone: ZoneRect): Promise<void> {
  try {
    const connection = runtimeConnection();
    const zones = await runtime.createZone(connection.baseUrl, connection.accessToken,
      connection.origin, zone);
    store.replaceZones(zones);
    toast(`'${zone.name}' 구역을 Jetson에 저장했습니다.`);
  } catch (error) { toast(errorMessage(error)); }
}

async function deleteZone(zoneId: string): Promise<void> {
  try {
    const connection = runtimeConnection();
    const zones = await runtime.deleteZone(connection.baseUrl, connection.accessToken,
      connection.origin, zoneId);
    store.replaceZones(zones);
    toast("주의 구역을 Jetson에서 삭제했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

async function saveNotificationSetting(eventType: EventType,
                                       value: NotificationSetting): Promise<void> {
  try {
    const connection = runtimeConnection();
    const settings = await runtime.setNotificationSetting(
      connection.baseUrl, connection.accessToken, connection.origin, eventType, value);
    store.replaceNotificationSettings(settings);
    toast(`${EVENT_TYPES[eventType]} 알림을 ${value.toUpperCase()}로 저장했습니다.`);
  } catch (error) {
    render();
    toast(errorMessage(error));
  }
}

async function resolveIdentityReview(reviewId: string,
                                     decision: Exclude<IdentityReviewDecision, "pending">,
                                     subjectId: string | null = null): Promise<void> {
  try {
    const connection = runtimeConnection();
    const reviews = await runtime.resolveIdentityReview(
      connection.baseUrl, connection.accessToken, connection.origin,
      reviewId, decision, subjectId);
    store.replaceIdentityReviews(reviews);
    toast("식별 검토 답변을 Jetson에 저장했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

async function hydrateIdentityReviewPreviews(reviews: readonly IdentityReview[],
                                             hasSubjects: boolean): Promise<void> {
  const currentIds = new Set(reviews.map((review) => review.id));
  const previewReviews = reviews.slice(0, IDENTITY_PREVIEW_LIMIT);
  const previewIds = new Set(previewReviews.map((review) => review.id));
  activeIdentityReviewIds = previewIds;
  identityReviewUrls.forEach((url, reviewId) => {
    if (!currentIds.has(reviewId)) {
      URL.revokeObjectURL(url);
      identityReviewUrls.delete(reviewId);
    }
  });
  identityReviewLoads.forEach((loading, reviewId) => {
    if (previewIds.has(reviewId)) return;
    loading.controller.abort();
    void loading.promise.then((url) => {
      if (!activeIdentityReviewIds.has(reviewId)
          && identityReviewUrls.get(reviewId) === url) {
        URL.revokeObjectURL(url);
        identityReviewUrls.delete(reviewId);
      }
    }).catch(() => undefined);
  });
  reviews.slice(IDENTITY_PREVIEW_LIMIT).forEach((review) => {
    const notice = document.querySelector<HTMLElement>(
      `[data-review-notice="${CSS.escape(review.id)}"]`,
    );
    if (notice) notice.textContent = `요청 과부하 방지를 위해 최근 ${IDENTITY_PREVIEW_LIMIT}건만 미리 불러옵니다.`;
  });
  for (const review of previewReviews) {
    const image = document.querySelector<HTMLImageElement>(
      `[data-review-image="${CSS.escape(review.id)}"]`,
    );
    if (!image) continue;
    document.querySelectorAll<HTMLButtonElement>(
      `[data-review-action="${CSS.escape(review.id)}"]`,
    ).forEach((button) => {
      button.disabled = button.dataset.reviewRequiresSubject === "true" && !hasSubjects;
    });
    const subject = document.querySelector<HTMLSelectElement>(
      `[data-review-subject="${CSS.escape(review.id)}"]`,
    );
    if (subject) subject.disabled = !hasSubjects;
    try {
      let url = identityReviewUrls.get(review.id);
      if (!url) {
        let load = identityReviewLoads.get(review.id);
        if (!load) {
          const controller = new AbortController();
          const loading = (async () => {
            const connection = runtimeConnection();
            const blob = await runtime.loadIdentityReviewMedia(
              connection.baseUrl, connection.accessToken, connection.origin, review.id,
              controller.signal);
            const createdUrl = URL.createObjectURL(blob);
            if (!activeIdentityReviewIds.has(review.id)) {
              URL.revokeObjectURL(createdUrl);
              throw new Error("식별 검토 항목이 더 이상 표시되지 않습니다.");
            }
            identityReviewUrls.set(review.id, createdUrl);
            return createdUrl;
          })();
          load = { promise: loading, controller };
          identityReviewLoads.set(review.id, load);
          void loading.finally(() => {
            if (identityReviewLoads.get(review.id)?.promise === loading) {
              identityReviewLoads.delete(review.id);
            }
          }).catch(() => undefined);
        }
        url = await load.promise;
      }
      image.src = url;
      const notice = document.querySelector<HTMLElement>(
        `[data-review-notice="${CSS.escape(review.id)}"]`,
      );
      if (notice) notice.textContent = hasSubjects
        ? "장면을 확인하고 답변을 선택해 주세요."
        : "등록 인물이 없어 미등록 또는 학습 제외로 답할 수 있습니다.";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") continue;
      const notice = document.querySelector<HTMLElement>(
        `[data-review-notice="${CSS.escape(review.id)}"]`,
      );
      if (notice) notice.textContent = errorMessage(error);
    }
  }
}

function renderFallIncident(events: readonly WardyEvent[]): void {
  const active = events.find((event) => event.event_type === "fall_suspected"
    && !["released", "false_detection"].includes(event.event_status));
  $("#fall-incident").classList.toggle("is-active", Boolean(active));
  $("#fall-incident-empty").toggleAttribute("hidden", Boolean(active));
  $("#fall-incident-active").toggleAttribute("hidden", !active);
  if (!active) return;
  $("#fall-incident-time").textContent = formatDateTime(active.occurred_at);
  $("#fall-incident-target").textContent = active.subject_name || active.subject_id || "대상 확인 필요";
  const confirmed = active.event_status === "confirmed";
  $("#fall-incident-reason").textContent = confirmed
    ? "긴급상황으로 기록했습니다. 안전을 확인한 뒤 사건을 해제해 주세요."
    : "판정할 때까지 긴급 상태가 유지됩니다. 선택 결과는 추후 모델 학습용 판정 자료로 저장됩니다.";
  $$<HTMLButtonElement>("[data-fall-action]").forEach((button) => {
    button.dataset.eventId = active.event_id;
    const action = button.dataset.fallAction;
    button.hidden = confirmed ? action !== "release" : action === "release";
  });
}

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
  if (status === "fault" && store.getState().settings.jetson.baseUrl && reconnectTimer === null) {
    reconnectTimer = window.setTimeout(() => { void connectConfiguredJetson(true).catch(() => undefined); }, 5000);
  }
  renderSystemGuidance();
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
  if (status === "fault" || status === "idle") {
    inferenceState = null;
    overlay.setDetections([]);
    if (inferenceExpiryTimer !== null) {
      window.clearTimeout(inferenceExpiryTimer);
      inferenceExpiryTimer = null;
    }
  }
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
  renderSystemGuidance();
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
  if (!configured.baseUrl) return;
  try {
    await jetson.check(configured.baseUrl, window.location.origin);
    const [snapshot, collections, datasetSamples, collectionSettings] = await Promise.all([
      runtime.loadSnapshot(configured.baseUrl, EDGE_GATEWAY_CREDENTIAL, window.location.origin),
      runtime.loadCollections(configured.baseUrl, EDGE_GATEWAY_CREDENTIAL, window.location.origin),
      trainingSamples.listDatasetSamples(
        configured.baseUrl, EDGE_GATEWAY_CREDENTIAL, window.location.origin,
      ),
      runtime.loadDataCollectionSettings(
        configured.baseUrl, EDGE_GATEWAY_CREDENTIAL, window.location.origin,
      ),
    ]);
    dataCollectionSettings = collectionSettings;
    applyRuntimeSnapshot(snapshot);
    if (collections.subjects) store.replaceSubjects(collections.subjects);
    if (collections.managedItems) store.replaceManagedItems(collections.managedItems);
    if (collections.zones) store.replaceZones(collections.zones);
    if (collections.notifications) store.replaceNotificationSettings(collections.notifications);
    if (collections.identityReviews) store.replaceIdentityReviews(collections.identityReviews);
    store.replaceDatasetSamples(datasetSamples);
    runtime.connect(configured.baseUrl, window.location.origin,
      applyRuntimeSnapshot, applyInferenceSnapshot);
    if (startCamera && cameraStatus !== "connected" && cameraStatus !== "connecting") {
      await camera.start(configured.baseUrl, window.location.origin);
    }
  } catch (error) {
    if (startCamera && reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        void connectConfiguredJetson(true).catch(() => undefined);
      }, 5000);
    }
    throw error;
  }
}

async function checkJetsonConnection(): Promise<void> {
  try {
    await connectConfiguredJetson(true);
    toast("Jetson Wardy 서비스와 카메라에 연결했습니다.");
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
  const status = state.careState.status ?? "normal";
  const care = CARE_STATUS[status];
  const activeFall = state.events.find((event) => event.event_type === "fall_suspected" &&
    !["released", "false_detection"].includes(event.event_status));
  $("#care-status-label").textContent = care.label;
  $("#care-status-code").textContent = status;
  $("#care-status-badge").textContent = care.label;
  $("#care-status-reason").textContent = activeFall
    ? userFacingEventReason("fall_suspected", activeFall.reason)
    : userFacingCareReason(status, state.careState.reason);
  $("#care-orb").className = `care-orb is-${status}`;
  $$("#care-state-controls button").forEach((button) => button.classList.toggle("is-active", button.dataset.careStatus === status));
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
    description.textContent = `${formatDateTime(latest.occurred_at)} · ${userFacingEventReason(latest.event_type, latest.reason)}`;
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
  const item = state.managedItems.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`등록된 물품을 찾을 수 없습니다: ${itemId}`);
  try {
    const result = await trainingSamples.capture(
      item, state.settings.jetson?.baseUrl ?? "", EDGE_GATEWAY_CREDENTIAL, window.location.origin,
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
  const subject = state.subjects.find((candidate) => candidate.id === subjectId);
  if (!subject) throw new Error(`등록된 인물을 찾을 수 없습니다: ${subjectId}`);
  try {
    const result = await trainingSamples.captureSubject(
      subject, state.settings.jetson?.baseUrl ?? "", EDGE_GATEWAY_CREDENTIAL, window.location.origin,
    );
    store.setSubjectReferenceSampleCount(subject.id, result.sampleCount);
    toast(`'${subject.name}' 식별 기준 사진을 Jetson에 저장했습니다. 총 ${result.sampleCount}장`);
  } catch (error) {
    toast(errorMessage(error));
  }
}

function datasetSampleMetadata(): DatasetSampleMetadata {
  const metadata = {
    modelId: $<HTMLSelectElement>("#dataset-model").value,
    requirementId: $<HTMLSelectElement>("#dataset-requirement").value,
    label: $<HTMLInputElement>("#dataset-label").value.trim(),
    captureSession: $<HTMLInputElement>("#dataset-session").value.trim(),
  };
  if (!metadata.label) throw new Error("sample label을 입력해 주세요.");
  if (!metadata.captureSession) throw new Error("촬영 session을 입력해 주세요.");
  return metadata;
}

async function captureDatasetSample(): Promise<void> {
  try {
    const connection = runtimeConnection();
    const samples = await trainingSamples.captureDatasetSample(
      datasetSampleMetadata(), connection.baseUrl, connection.accessToken, connection.origin,
    );
    store.replaceDatasetSamples(samples);
    toast("Jetson camera 원본 sample을 저장했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

async function uploadDatasetSamples(files: readonly File[]): Promise<void> {
  if (!files.length) return;
  try {
    const connection = runtimeConnection();
    const metadata = datasetSampleMetadata();
    let samples = store.getState().datasetSamples;
    for (const file of files) {
      samples = await trainingSamples.uploadDatasetSample(
        file, metadata, connection.baseUrl, connection.accessToken, connection.origin,
      );
      store.replaceDatasetSamples(samples);
    }
    toast(`로컬 이미지 ${files.length}개를 Jetson에 저장했습니다.`);
  } catch (error) { toast(errorMessage(error)); }
}

async function reviewDatasetSample(
  sampleId: string, label: string, reviewStatus: DatasetReviewStatus,
): Promise<void> {
  if (!label) { toast("검수 전에 label을 입력해 주세요."); return; }
  try {
    const connection = runtimeConnection();
    const samples = await trainingSamples.updateDatasetSample(
      sampleId, label, reviewStatus,
      connection.baseUrl, connection.accessToken, connection.origin,
    );
    store.replaceDatasetSamples(samples);
    toast("sample 검수 상태를 저장했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

function closeDatasetPreview(): void {
  datasetPreviewGeneration += 1;
  const dialog = $<HTMLDialogElement>("#dataset-preview-dialog");
  if (datasetPreviewUrl) URL.revokeObjectURL(datasetPreviewUrl);
  datasetPreviewUrl = null;
  $<HTMLImageElement>("#dataset-preview-image").removeAttribute("src");
  if (dialog.open) dialog.close();
}

async function previewDatasetSample(sampleId: string): Promise<void> {
  const generation = ++datasetPreviewGeneration;
  const state = store.getState();
  const sample = state.datasetSamples.find((candidate) => candidate.id === sampleId);
  if (!sample) { toast("sample 정보를 찾을 수 없습니다."); return; }
  try {
    const connection = runtimeConnection();
    const media = await trainingSamples.loadDatasetSampleMedia(
      sample, connection.baseUrl, connection.accessToken, connection.origin,
    );
    if (generation !== datasetPreviewGeneration) return;
    if (datasetPreviewUrl) URL.revokeObjectURL(datasetPreviewUrl);
    datasetPreviewUrl = URL.createObjectURL(media);
    $<HTMLImageElement>("#dataset-preview-image").src = datasetPreviewUrl;
    $("#dataset-preview-title").textContent = `${sample.modelId} · ${sample.label}`;
    $("#dataset-preview-meta").textContent =
      `${sample.requirementId} · ${sample.captureSession} · ${sample.width}×${sample.height}`;
    const dialog = $<HTMLDialogElement>("#dataset-preview-dialog");
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    if (generation === datasetPreviewGeneration) toast(errorMessage(error));
  }
}

async function deleteDatasetSample(sampleId: string): Promise<void> {
  if (!window.confirm("Jetson에 저장된 원본 sample과 metadata를 삭제할까요?")) return;
  try {
    const connection = runtimeConnection();
    const samples = await trainingSamples.deleteDatasetSample(
      sampleId, connection.baseUrl, connection.accessToken, connection.origin,
    );
    store.replaceDatasetSamples(samples);
    toast("원본 sample을 Jetson에서 삭제했습니다.");
  } catch (error) { toast(errorMessage(error)); }
}

function saveDataWorkspaceSettings(): void {
  try {
    store.setDataWorkspace(
      $<HTMLInputElement>("#dataset-session").value,
      $<HTMLInputElement>("#dataset-version").value,
    );
  } catch (error) {
    render();
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
    if (!runtime.isConnected()) {
      applyRuntimeSnapshot(await runtime.loadSnapshot(
        connection.baseUrl, connection.accessToken, connection.origin));
    }
    toast(`${eventId} 처리 상태를 저장했습니다.`);
  } catch (error) { toast(errorMessage(error)); }
}

async function generateDailySummary(): Promise<void> {
  const button = $<HTMLButtonElement>("#generate-ai-summary");
  const output = $("#ai-summary-output");
  const badge = $("#ai-summary-badge");
  button.disabled = true;
  output.setAttribute("aria-busy", "true");
  output.textContent = "Jetson에서 오늘의 이벤트를 요약하고 있습니다…";
  badge.textContent = "생성 중";
  badge.className = "badge";
  try {
    const connection = runtimeConnection();
    const result = await runtime.loadDailySummary(
      connection.baseUrl, connection.accessToken, connection.origin,
      kstDateKey(),
    );
    output.textContent = result.summary;
    badge.textContent = result.fallback ? "규칙 요약" :
      `${result.model.replace(":", " ")}${result.filtered ? " · 출력 필터" : ""}`;
    badge.className = `badge${result.fallback ? "" : " is-connected"}`;
  } catch (error) {
    output.textContent = "요약을 만들지 못했습니다. Jetson 연결과 로컬 LLM 상태를 확인해 주세요.";
    badge.textContent = "실패";
    badge.className = "badge is-fault";
    toast(errorMessage(error));
  } finally {
    button.disabled = false;
    output.removeAttribute("aria-busy");
  }
}

async function viewEventMedia(eventId: string): Promise<void> {
  try {
    const connection = runtimeConnection();
    const blob = await runtime.loadEventMedia(connection.baseUrl, connection.accessToken,
      connection.origin, eventId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { toast(errorMessage(error)); }
}

async function deleteEventMedia(eventId: string): Promise<void> {
  if (!window.confirm("Jetson에 저장된 이벤트 사진·영상을 삭제할까요?")) return;
  try {
    const connection = runtimeConnection();
    await runtime.deleteEventMedia(connection.baseUrl, connection.accessToken,
      connection.origin, eventId);
    if (!runtime.isConnected()) {
      applyRuntimeSnapshot(await runtime.loadSnapshot(
        connection.baseUrl, connection.accessToken, connection.origin));
    }
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
  renderFallIncident(state.events);
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
  renderNotifications($("#notification-settings"), state.settings.notifications,
    (eventType, value) => { void saveNotificationSetting(eventType, value); });
  if (dataCollectionSettings) {
    $<HTMLInputElement>("#collect-identity-review").checked = dataCollectionSettings.identityReviewEnabled;
    $<HTMLInputElement>("#collect-event-media").checked = dataCollectionSettings.eventMediaEnabled;
    $<HTMLInputElement>("#collect-model-improvement").checked = dataCollectionSettings.modelImprovementEnabled;
    $<HTMLInputElement>("#event-media-retention").value = String(dataCollectionSettings.eventMediaRetentionDays);
    $<HTMLInputElement>("#training-data-retention").value = String(dataCollectionSettings.trainingDataRetentionDays);
    $("#privacy-consent-status").textContent = dataCollectionSettings.consentedAt ? "설정됨" : "미동의";
  }
  renderSubjects($("#subject-list"), state.subjects, (id) => { void deleteSubject(id); }, captureSubjectReference);
  renderSubjects($("#data-subject-list"), state.subjects, (id) => { void deleteSubject(id); }, captureSubjectReference);
  renderIdentityReviews(
    $("#identity-review-gallery"), state.identityReviews, state.subjects,
    (reviewId, decision, subjectId) => {
      void resolveIdentityReview(reviewId, decision, subjectId ?? null);
    },
  );
  void hydrateIdentityReviewPreviews(state.identityReviews, state.subjects.length > 0);
  const pendingReviews = state.identityReviews.filter((review) => review.decision === "pending").length;
  $("#review-count").textContent = `${pendingReviews}건 대기`;
  renderDatasetSamples(
    $<HTMLTableSectionElement>("#dataset-sample-list"), state.datasetSamples,
    (sampleId, label, status) => { void reviewDatasetSample(sampleId, label, status); },
    (sampleId) => { void previewDatasetSample(sampleId); },
    (sampleId) => { void deleteDatasetSample(sampleId); },
  );
  $("#dataset-sample-empty").toggleAttribute("hidden", state.datasetSamples.length > 0);
  $("#dataset-sample-count").textContent = `${state.datasetSamples.length}건`;
  const approvedSamples = state.datasetSamples.filter((sample) => sample.reviewStatus === "approved").length;
  $("#dataset-approved-count").textContent = `승인 ${approvedSamples}건`;
  const sessionInput = $<HTMLInputElement>("#dataset-session");
  const versionInput = $<HTMLInputElement>("#dataset-version");
  if (document.activeElement !== sessionInput) sessionInput.value = state.settings.dataWorkspace.captureSession;
  if (document.activeElement !== versionInput) versionInput.value = state.settings.dataWorkspace.datasetVersion;
  renderManagedItems(
    $("#item-list"), state.managedItems,
    (id) => { void deleteManagedItem(id); }, captureManagedItemSample,
  );
  renderZones($("#zone-list"), state.zones, (id) => { void deleteZone(id); });
  const jetsonInput = $<HTMLInputElement>("#jetson-base-url");
  if (document.activeElement !== jetsonInput) jetsonInput.value = state.settings.jetson.baseUrl;
  const configured = state.settings.jetson.baseUrl || window.location.origin;
  $("#jetson-resolved-url").textContent = configured;
  renderSystemState();
  renderNotificationPermission();
}

store.subscribe(render);
colorTheme.applyCurrent();
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

$("#theme-toggle").addEventListener("click", () => colorTheme.toggle());

$("#start-camera").addEventListener("click", async () => {
  try {
    const baseUrl = store.getState().settings.jetson?.baseUrl ?? "";
    const endpoint = await camera.start(baseUrl, window.location.origin);
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
$$<HTMLInputElement>('[data-overlay-setting]').forEach((input) => input.addEventListener("change", () => {
  store.setOverlaySetting(input.dataset.overlaySetting as OverlaySettingKey, input.checked);
}));
$("#generate-ai-summary").addEventListener("click", () => { void generateDailySummary(); });
$$<HTMLButtonElement>("[data-fall-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const eventId = button.dataset.eventId;
    const action = button.dataset.fallAction as "confirm" | "release" | "false-detection";
    if (eventId) void runEventAction(eventId, action);
  });
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
$("#enable-browser-notifications").addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  renderNotificationPermission();
  toast(permission === "granted" ? "브라우저 알림을 허용했습니다." : "브라우저 알림이 허용되지 않았습니다.");
});
$<HTMLFormElement>("#data-collection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const connection = runtimeConnection();
    const requested: DataCollectionSettings = {
      identityReviewEnabled: $<HTMLInputElement>("#collect-identity-review").checked,
      eventMediaEnabled: $<HTMLInputElement>("#collect-event-media").checked,
      modelImprovementEnabled: $<HTMLInputElement>("#collect-model-improvement").checked,
      eventMediaRetentionDays: Number($<HTMLInputElement>("#event-media-retention").value),
      trainingDataRetentionDays: Number($<HTMLInputElement>("#training-data-retention").value),
      consentVersion: "wardy-privacy-v1",
      consentedAt: null,
      updatedAt: "",
    };
    dataCollectionSettings = await runtime.saveDataCollectionSettings(
      connection.baseUrl, connection.accessToken, connection.origin, requested,
    );
    render();
    toast("Jetson에 데이터 수집 동의 설정을 저장했습니다.");
  } catch (error) {
    toast(errorMessage(error));
  }
});

$("#export-events").addEventListener("click", () => {
  downloadJson(`wardy-events-${new Date().toISOString().slice(0, 10)}.json`, store.getState().events);
});
$("#export-identity-feedback").addEventListener("click", () => {
  const state = store.getState();
  downloadJson(
    `wardy-identity-feedback-${new Date().toISOString().slice(0, 10)}.json`,
    identityFeedbackManifest(state.identityReviews, state.subjects),
  );
  toast("현재 로컬 식별 feedback manifest를 내보냈습니다.");
});
$("#export-dataset-manifest").addEventListener("click", () => {
  const state = store.getState();
  const version = $<HTMLInputElement>("#dataset-version").value.trim();
  if (!version) { toast("dataset version을 입력해 주세요."); return; }
  const approvedCount = state.datasetSamples.filter((sample) => sample.reviewStatus === "approved").length;
  if (!approvedCount) { toast("승인된 sample이 없어 manifest를 만들 수 없습니다."); return; }
  store.setDataWorkspace($<HTMLInputElement>("#dataset-session").value, version);
  downloadJson(`${version.replace(/[^a-zA-Z0-9._-]+/g, "-")}-manifest.json`,
    datasetManifest(version, state.datasetSamples));
  toast(`승인된 sample ${approvedCount}건의 manifest를 내보냈습니다.`);
});
$<HTMLFormElement>("#dataset-sample-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void captureDatasetSample();
});
$("#choose-dataset-files").addEventListener("click", () => $<HTMLInputElement>("#dataset-file-input").click());
$("#close-dataset-preview").addEventListener("click", closeDatasetPreview);
$<HTMLDialogElement>("#dataset-preview-dialog").addEventListener("close", () => {
  if (datasetPreviewUrl) URL.revokeObjectURL(datasetPreviewUrl);
  datasetPreviewUrl = null;
  $<HTMLImageElement>("#dataset-preview-image").removeAttribute("src");
});
$<HTMLDialogElement>("#dataset-preview-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDatasetPreview();
});
$<HTMLInputElement>("#dataset-file-input").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  void uploadDatasetSamples(files);
});
$<HTMLInputElement>("#dataset-session").addEventListener("change", saveDataWorkspaceSettings);
$<HTMLInputElement>("#dataset-version").addEventListener("change", saveDataWorkspaceSettings);
$("#reset-local-data").addEventListener("click", () => { if (window.confirm("현재 브라우저의 Wardy 화면 설정과 연결 정보를 초기화할까요?")) { store.reset(); toast("브라우저 설정을 초기화했습니다."); } });

$<HTMLFormElement>("#jetson-form").addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const rawBaseUrl = $<HTMLInputElement>("#jetson-base-url").value;
  try {
    const baseUrl = rawBaseUrl.trim() ? normalizeJetsonBaseUrl(rawBaseUrl) : "";
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
$("#system-guidance-action").addEventListener("click", () => openView("jetson"));

window.addEventListener("beforeunload", () => {
  closeDatasetPreview();
  activeIdentityReviewIds.clear();
  identityReviewLoads.forEach((load) => load.controller.abort());
  identityReviewUrls.forEach((url) => URL.revokeObjectURL(url));
  camera.stop();
  runtime.stop();
});
window.addEventListener("online", () => { void connectConfiguredJetson(true).catch(() => undefined); });

setJetsonStatus(jetsonStatus);
void registerWardyServiceWorker();
if (!jetsonTlsRedirecting) void connectConfiguredJetson(true).catch(() => undefined);
