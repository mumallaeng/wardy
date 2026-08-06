import { CARE_STATUS, EVENT_STATUS, EVENT_TYPES } from "./constants.ts";
import type { EventFilters, EventSummary, WardyEvent } from "./types.ts";

export function sortEvents(events: readonly WardyEvent[]): WardyEvent[] {
  return [...events].sort((a, b) => {
    const statusDelta = (CARE_STATUS[b.care_status]?.rank ?? -1) - (CARE_STATUS[a.care_status]?.rank ?? -1);
    return statusDelta || new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
  });
}

export function filterEvents(events: readonly WardyEvent[], filters: EventFilters = {}): WardyEvent[] {
  const query = (filters.query ?? "").trim().toLocaleLowerCase("ko");
  return sortEvents(events).filter((event) => {
    if (filters.eventStatus && filters.eventStatus !== "all" && event.event_status !== filters.eventStatus) return false;
    if (filters.careStatus && filters.careStatus !== "all" && event.care_status !== filters.careStatus) return false;
    if (!query) return true;
    return [event.event_id, EVENT_TYPES[event.event_type], event.reason, event.subject_name, event.subject_location, event.object_class]
      .filter(Boolean).join(" ").toLocaleLowerCase("ko").includes(query);
  });
}

export function summarizeEvents(events: readonly WardyEvent[], now = new Date()): EventSummary {
  const dayKey = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = events.filter((event) => dayKey(new Date(event.occurred_at)) === dayKey(now));
  const result: EventSummary = { total: today.length, normal: 0, caution: 0, warning: 0, emergency: 0, unconfirmed: 0 };
  today.forEach((event) => {
    if (event.care_status in result) result[event.care_status] += 1;
    if (event.event_status === "new") result.unconfirmed += 1;
  });
  return result;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function chip(text: string, className: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `status-chip is-${className}`;
  span.textContent = text;
  return span;
}

function actionButton(text: string, action: string, eventId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.dataset.eventId = eventId;
  button.textContent = text;
  return button;
}

export function renderEventRows(tbody: HTMLTableSectionElement, events: readonly WardyEvent[]): void {
  tbody.replaceChildren();
  events.forEach((event) => {
    const row = document.createElement("tr");
    const time = document.createElement("td");
    time.textContent = formatDateTime(event.occurred_at);

    const detail = document.createElement("td");
    const type = document.createElement("strong");
    type.textContent = EVENT_TYPES[event.event_type] ?? event.event_type;
    const reason = document.createElement("small");
    reason.textContent = event.reason;
    detail.append(type, reason);

    const target = document.createElement("td");
    target.textContent = event.subject_name || event.subject_id || "대상 없음";
    const location = document.createElement("small");
    location.textContent = [event.subject_location, event.object_class].filter(Boolean).join(" · ") || "—";
    target.append(location);

    const care = document.createElement("td");
    care.append(chip(CARE_STATUS[event.care_status]?.label ?? "확인 불가", event.care_status ?? "released"));

    const media = document.createElement("td");
    media.textContent = event.media_type === "image" ? "사진" : event.media_type === "video" ? "10초 영상" : "없음";
    const mediaPath = document.createElement("small");
    mediaPath.textContent = event.media_path || "저장하지 않음";
    media.append(mediaPath);

    const status = document.createElement("td");
    status.append(chip(EVENT_STATUS[event.event_status] ?? event.event_status, event.event_status));

    const actions = document.createElement("td");
    actions.className = "table-actions";
    const actionGroup = document.createElement("div");
    actionGroup.className = "table-action-group";
    if (event.event_status === "new") actionGroup.append(actionButton("확인", "confirm", event.event_id));
    if (!["released", "false_detection"].includes(event.event_status)) actionGroup.append(actionButton("오탐", "false", event.event_id));
    if (event.media_type !== "none" && event.media_path) actionGroup.append(actionButton("자료 삭제", "delete-media", event.event_id));
    if (actionGroup.childElementCount) actions.append(actionGroup);
    else actions.textContent = "—";

    row.append(time, detail, target, care, media, status, actions);
    tbody.append(row);
  });
}
