import { CARE_STATUS, EVENT_STATUS, EVENT_TYPES, userFacingEventReason } from "./constants.ts";
import type { EventFilters, EventSummary, WardyEvent } from "./types.ts";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function kstDateKey(date = new Date()): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Sorts events by care-status priority and occurrence time.
 *
 * @param events - The events to sort.
 * @returns A new array ordered by descending care-status rank, then by descending occurrence time. Unknown care statuses are placed last.
 */
export function sortEvents(events: readonly WardyEvent[]): WardyEvent[] {
  const rank = (event: WardyEvent): number => event.care_status
    ? CARE_STATUS[event.care_status]?.rank ?? -1
    : Number.MAX_SAFE_INTEGER;
  return [...events].sort((a, b) => {
    const statusDelta = rank(b) - rank(a);
    return statusDelta || new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
  });
}

/**
 * Filters events by status and a Korean-locale, case-insensitive text query.
 *
 * @param filters - Optional event-status, care-status, and text-search criteria.
 * @returns Events matching the filters, sorted by care-status rank and occurrence time.
 */
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

/**
 * Summarizes events that occurred on the same Korean calendar day as the reference time.
 *
 * @param now - The reference time used to determine the calendar day.
 * @returns Counts for total events, each care status, and events with a `"new"` status.
 */
export function summarizeEvents(events: readonly WardyEvent[], now = new Date()): EventSummary {
  const today = events.filter((event) => kstDateKey(new Date(event.occurred_at)) === kstDateKey(now));
  const result: EventSummary = { total: today.length, normal: 0, caution: 0, warning: 0, emergency: 0, unconfirmed: 0 };
  today.forEach((event) => {
    const systemFault = event.event_type === "camera_fault" || event.event_type === "detection_fault";
    if (!systemFault && event.care_status in result) result[event.care_status] += 1;
    if (event.event_status === "new") result.unconfirmed += 1;
  });
  return result;
}

/**
 * Formats a timestamp for display using Korean locale and 24-hour time.
 *
 * @param value - The timestamp to format; missing values produce an em dash
 * @returns The formatted date and time, or `"—"` when `value` is missing
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

/**
 * Creates a status chip element with the specified text and style class.
 *
 * @param text - The text displayed in the chip
 * @param className - The status class appended to the chip's `is-` class prefix
 * @returns The created status chip element
 */
function chip(text: string, className: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `status-chip is-${className}`;
  span.textContent = text;
  return span;
}

/**
 * Creates a button configured with an action and event identifier.
 *
 * @param text - The text displayed on the button
 * @param action - The action associated with the button
 * @param eventId - The identifier of the event associated with the button
 * @returns A configured button element
 */
function actionButton(text: string, action: string, eventId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.dataset.eventId = eventId;
  button.textContent = text;
  return button;
}

/**
 * Renders event rows in a table body.
 *
 * @param tbody - The table body to replace
 * @param events - The events to render
 */
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
    reason.textContent = userFacingEventReason(event.event_type, event.reason);
    detail.append(type, reason);

    const target = document.createElement("td");
    target.textContent = event.subject_name || event.subject_id || "대상 없음";
    const location = document.createElement("small");
    location.textContent = [event.subject_location, event.object_class].filter(Boolean).join(" · ") || "—";
    target.append(location);

    const care = document.createElement("td");
    care.append(chip(event.care_status ? CARE_STATUS[event.care_status]?.label ?? "확인 불가" : "해당 없음",
      event.care_status ?? "unavailable"));

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
    if (!["released", "false_detection"].includes(event.event_status)) {
      actionGroup.append(actionButton("해제", "release", event.event_id));
      actionGroup.append(actionButton("오탐", "false", event.event_id));
    }
    if (event.media_type !== "none" && event.media_path) {
      actionGroup.append(actionButton("자료 보기", "view-media", event.event_id));
      actionGroup.append(actionButton("자료 삭제", "delete-media", event.event_id));
    }
    if (actionGroup.childElementCount) actions.append(actionGroup);
    else actions.textContent = "—";

    row.append(time, detail, target, care, media, status, actions);
    tbody.append(row);
  });
}
