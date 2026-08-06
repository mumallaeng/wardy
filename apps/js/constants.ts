import type { CareStatus, Detection, EventStatus, EventType, OverlaySettingKey, WardyEvent, WardyState } from "./types.ts";

export const CARE_STATUS: Readonly<Record<CareStatus, { label: string; reason: string; rank: number }>> = Object.freeze({
  normal: { label: "기본", reason: "활성화된 안전 이벤트가 없습니다.", rank: 0 },
  caution: { label: "주의", reason: "사용자가 상황을 확인할 필요가 있습니다.", rank: 1 },
  warning: { label: "경고", reason: "빠른 확인이 필요한 상태입니다.", rank: 2 },
  emergency: { label: "긴급", reason: "즉시 확인이 필요한 의심 상황입니다.", rank: 3 },
});

export const EVENT_STATUS: Readonly<Record<EventStatus, string>> = Object.freeze({
  new: "신규",
  confirmed: "확인",
  released: "해제",
  false_detection: "오탐",
});

export const EVENT_TYPES: Readonly<Record<EventType, string>> = Object.freeze({
  fall_suspected: "낙상 의심",
  inactivity: "장시간 정지",
  hazard_detected: "위험물 탐지",
  hazard_proximity: "위험물 근접",
  managed_item_moved: "관리 물품 이동",
  zone_entry: "주의 구역 진입",
  zone_dwell: "주의 구역 장시간 체류",
  camera_fault: "카메라 입력 이상",
  detection_fault: "안전 감지 기능 이상",
});

export const OVERLAY_FIELDS: ReadonlyArray<{ key: OverlaySettingKey; label: string; description: string }> = Object.freeze([
  { key: "showClass", label: "탐지 class", description: "사람·물건 class 표시" },
  { key: "showRole", label: "돌봄 역할", description: "돌봄 대상·일반 인물 역할 표시" },
  { key: "showName", label: "식별 이름", description: "등록 대상의 이름 표시" },
  { key: "showPosture", label: "자세·행동", description: "서 있음·앉음 등 상태 표시" },
]);

export const DEMO_DETECTIONS: ReadonlyArray<Detection> = Object.freeze([
  { id: "person-demo-01", box: [0.18, 0.16, 0.27, 0.64], className: "사람", role: "돌봄 대상", name: "조정민", posture: "서 있음", color: "#f4c85b" },
  { id: "object-demo-01", box: [0.66, 0.57, 0.16, 0.18], className: "가위", role: "관리 위험물", name: "", posture: "", color: "#ef6b61" },
]);

/**
 * Creates an ISO 8601 timestamp for a specified number of minutes before the current time.
 *
 * @param minutes - The number of minutes to subtract from the current time
 * @returns The resulting ISO 8601 timestamp
 */
function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Creates the predefined demo events used to populate the application.
 *
 * @returns An array of sample hazardous-proximity, hazard-detected, and inactivity events
 */
export function createDemoEvents(): WardyEvent[] {
  return [
    {
      event_id: "EVT-DEMO-003",
      event_type: "hazard_proximity",
      occurred_at: isoMinutesAgo(8),
      first_seen_at: isoMinutesAgo(8),
      last_seen_at: isoMinutesAgo(7),
      subject_id: "subject-demo-01",
      subject_name: "조정민",
      subject_location: "거실",
      object_id: "object-demo-01",
      object_class: "가위",
      zone_id: null,
      care_status: "warning",
      event_status: "new",
      confirmed_at: null,
      released_at: null,
      false_detection_at: null,
      reason: "위험물과 돌봄 대상자가 가까운 UI 예시입니다.",
      source_results: [{ source: "ui_demo_fixture", note: "AI 결과가 아님" }],
      media_type: "video",
      media_path: "demo/media/EVT-DEMO-003.mp4",
      media_started_at: isoMinutesAgo(8.08),
      media_ended_at: isoMinutesAgo(7.92),
    },
    {
      event_id: "EVT-DEMO-002",
      event_type: "hazard_detected",
      occurred_at: isoMinutesAgo(28),
      first_seen_at: isoMinutesAgo(28),
      last_seen_at: isoMinutesAgo(27),
      subject_id: "subject-demo-01",
      subject_name: "조정민",
      subject_location: "주방 입구",
      object_id: "object-demo-01",
      object_class: "가위",
      zone_id: null,
      care_status: "caution",
      event_status: "confirmed",
      confirmed_at: isoMinutesAgo(25),
      released_at: null,
      false_detection_at: null,
      reason: "관리 대상 위험물이 표시된 UI 예시입니다.",
      source_results: [{ source: "ui_demo_fixture", note: "AI 결과가 아님" }],
      media_type: "image",
      media_path: "demo/media/EVT-DEMO-002.jpg",
      media_started_at: null,
      media_ended_at: null,
    },
    {
      event_id: "EVT-DEMO-001",
      event_type: "inactivity",
      occurred_at: isoMinutesAgo(74),
      first_seen_at: isoMinutesAgo(74),
      last_seen_at: isoMinutesAgo(69),
      subject_id: "subject-demo-01",
      subject_name: "조정민",
      subject_location: "소파 주변",
      object_id: null,
      object_class: null,
      zone_id: null,
      care_status: "warning",
      event_status: "released",
      confirmed_at: isoMinutesAgo(72),
      released_at: isoMinutesAgo(69),
      false_detection_at: null,
      reason: "장시간 정지 이벤트 처리 흐름의 UI 예시입니다.",
      source_results: [{ source: "ui_demo_fixture", note: "AI 결과가 아님" }],
      media_type: "video",
      media_path: "demo/media/EVT-DEMO-001.mp4",
      media_started_at: isoMinutesAgo(74.08),
      media_ended_at: isoMinutesAgo(73.92),
    },
  ];
}

/**
 * Creates the initial application state with default settings, managed items, demo events, and a demo care subject.
 *
 * @returns The initial application state
 */
export function createInitialState(): WardyState {
  return {
    version: 1,
    careState: { status: "normal", reason: CARE_STATUS.normal.reason, updatedAt: new Date().toISOString(), source: "manual_ui" },
    events: createDemoEvents(),
    settings: {
      overlay: { showClass: true, showRole: true, showName: true, showPosture: true },
      notifications: { fall_suspected: "on", inactivity: "on", hazard_detected: "on", hazard_proximity: "on" },
      jetson: { baseUrl: "" },
    },
    managedItems: [
      { id: "item-scissors", label: "가위", policy: "included" },
      { id: "item-cutter", label: "커터칼", policy: "included" },
      { id: "item-kitchen-knife", label: "주방 칼", policy: "excluded" },
    ],
    zones: [],
    subjects: [{ id: "subject-demo-01", name: "조정민", role: "돌봄 대상", createdAt: new Date().toISOString() }],
  };
}

/**
 * Creates a demo fall-suspected event with current timestamps and sequence-based identifiers.
 *
 * @param sequence - The numeric suffix used for the event and media identifiers
 * @returns A new emergency event in the unconfirmed state
 */
export function createDemoEvent(sequence: number): WardyEvent {
  const now = new Date().toISOString();
  return {
    event_id: `EVT-DEMO-${String(sequence).padStart(3, "0")}`,
    event_type: "fall_suspected",
    occurred_at: now,
    first_seen_at: now,
    last_seen_at: now,
    subject_id: "subject-demo-01",
    subject_name: "조정민",
    subject_location: "거실",
    object_id: null,
    object_class: null,
    zone_id: null,
    care_status: "emergency",
    event_status: "new",
    confirmed_at: null,
    released_at: null,
    false_detection_at: null,
    reason: "낙상 의심 이벤트 화면을 확인하기 위한 demo fixture입니다.",
    source_results: [{ source: "ui_demo_fixture", note: "AI 결과가 아님" }],
    media_type: "video",
    media_path: `demo/media/EVT-DEMO-${String(sequence).padStart(3, "0")}.mp4`,
    media_started_at: new Date(Date.now() - 5_000).toISOString(),
    media_ended_at: new Date(Date.now() + 5_000).toISOString(),
  };
}
