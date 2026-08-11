import type { NotificationSettings, WardyEvent } from "./types.ts";

export function newNotifiableEvents(
  events: readonly WardyEvent[],
  knownEventIds: ReadonlySet<string> | null,
  settings: NotificationSettings,
): WardyEvent[] {
  if (knownEventIds === null) return [];
  return events.filter((event) => event.event_status === "new"
    && !knownEventIds.has(event.event_id)
    && settings[event.event_type] !== "off");
}
