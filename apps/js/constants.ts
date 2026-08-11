import type { CareStatus, EventStatus, EventType, OverlaySettingKey, WardyState } from "./types.ts";

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

/**
 * Creates the initial application state without simulated operational data.
 *
 * @returns The initial application state
 */
export function createInitialState(): WardyState {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return {
    version: 1,
    careState: { status: null, reason: "Jetson 연결 뒤 안전 상태를 확인합니다.", updatedAt: new Date().toISOString(), source: "manual_ui" },
    events: [],
    settings: {
      overlay: { showClass: true, showRole: true, showName: true, showPosture: true },
      notifications: { fall_suspected: "on", inactivity: "on", hazard_detected: "on", hazard_proximity: "on" },
      camera: { mirrored: false },
      jetson: { baseUrl: "" },
      dataWorkspace: { captureSession: `session-${day}`, datasetVersion: `wardy-${day}-v1` },
    },
    managedItems: [],
    zones: [],
    subjects: [],
    identityReviews: [],
    datasetSamples: [],
  };
}
