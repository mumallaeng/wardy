import type { CareStatus, EventStatus, EventType, OverlaySettingKey, WardyState } from "./types.ts";

export const CARE_STATUS: Readonly<Record<CareStatus, { label: string; reason: string; rank: number }>> = Object.freeze({
  normal: { label: "정상", reason: "활성화된 안전 이벤트가 없습니다.", rank: 0 },
  caution: { label: "주의", reason: "사용자가 상황을 확인할 필요가 있습니다.", rank: 1 },
  warning: { label: "경고", reason: "빠른 확인이 필요한 상태입니다.", rank: 2 },
  emergency: { label: "긴급", reason: "즉시 확인이 필요한 의심 상황입니다.", rank: 3 },
});

/** Convert runtime diagnostics into caregiver-facing status text. */
export function userFacingCareReason(status: CareStatus, reason: string): string {
  const normalized = reason.trim().toLocaleLowerCase("en-US");
  if (normalized.includes("fall threshold") || normalized.includes("m-04")) {
    return "낙상 의심 신호가 일정 시간 누적되었습니다.";
  }
  if (normalized.includes("event runtime") || normalized.includes("worker")) {
    return CARE_STATUS[status].reason;
  }
  if (!reason.trim() || /\b(m-0[1-5]|sqlite|onnx|opencv|runtime|worker|threshold)\b/i.test(reason)) {
    return CARE_STATUS[status].reason;
  }
  return reason;
}

/** Keep implementation diagnostics out of caregiver-facing event descriptions. */
export function userFacingEventReason(eventType: EventType, reason: string): string {
  const technical = /\b(m-0[1-5]|sqlite|onnx|opencv|runtime|worker|threshold|failed|error|exception|cannot|unable|stopped|recovered|input|encode|encoding|frame)\b/i.test(reason);
  if (!technical) return reason.trim() || CARE_STATUS.normal.reason;
  switch (eventType) {
    case "fall_suspected": return "낙상 의심 신호가 일정 시간 누적되었습니다.";
    case "camera_fault": return "카메라 입력을 확인해 주세요.";
    case "detection_fault": return "안전 감지 기능을 확인해 주세요.";
    case "hazard_detected": return "위험물이 감지되었습니다.";
    case "hazard_proximity": return "위험물이 돌봄 대상자 가까이에 있습니다.";
    case "inactivity": return "장시간 움직임이 없어 확인이 필요합니다.";
    case "zone_entry": return "주의 구역 진입이 감지되었습니다.";
    case "zone_dwell": return "주의 구역에 오래 머물고 있습니다.";
    default: return CARE_STATUS.normal.reason;
  }
}

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
  { key: "showPosture", label: "M-03 자세·스켈레톤", description: "관절선과 서 있음·앉음·누움 자세 표시" },
  { key: "showFall", label: "M-04 낙상 감지", description: "낙상 시퀀스 점수와 분석 진행 상태 표시" },
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
    careState: { status: "normal", reason: CARE_STATUS.normal.reason, updatedAt: new Date().toISOString(), source: "manual_ui" },
    events: [],
    settings: {
      overlay: { showClass: true, showRole: true, showName: true, showPosture: true, showFall: true },
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
