import { EVENT_TYPES, OVERLAY_FIELDS } from "./constants.ts";
import type { EventType, ManagedItem, NotificationSetting, NotificationSettings, OverlaySettingKey, OverlaySettings, Subject, Zone } from "./types.ts";

/**
 * Creates an accessible checkbox switch with an initial state and change callback.
 *
 * @param checked - Whether the switch starts checked
 * @param onChange - Callback invoked with the switch's current checked state
 * @param label - Accessible label for the switch
 * @returns The switch element
 */
function switchControl(checked: boolean, onChange: (checked: boolean) => void, label: string): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.className = "switch";
  wrapper.setAttribute("aria-label", label);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span");
  wrapper.append(input, track);
  return wrapper;
}

/**
 * Renders a toggle row for each overlay setting and reports changes through the callback.
 *
 * @param settings - The current values for the overlay settings
 * @param onChange - Called with the setting key and updated value when a toggle changes
 */
export function renderOverlaySettings(
  container: HTMLElement,
  settings: OverlaySettings,
  onChange: (key: OverlaySettingKey, value: boolean) => void,
): void {
  container.replaceChildren();
  OVERLAY_FIELDS.forEach((field) => {
    const row = document.createElement("div");
    row.className = "setting-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = field.label;
    const description = document.createElement("small");
    description.textContent = field.description;
    copy.append(title, description);
    row.append(copy, switchControl(Boolean(settings[field.key]), (value) => onChange(field.key, value), field.label));
    container.append(row);
  });
}

/**
 * Renders notification level controls for configurable event types.
 *
 * @param settings - Notification levels for each event type; unset levels default to `"normal"`.
 * @param onChange - Callback invoked with the event type and selected notification level.
 */
export function renderNotifications(
  container: HTMLElement,
  settings: NotificationSettings,
  onChange: (eventType: EventType, value: NotificationSetting) => void,
): void {
  container.replaceChildren();
  const configurableEventTypes = Object.keys(EVENT_TYPES) as EventType[];
  configurableEventTypes.forEach((eventType) => {
    const row = document.createElement("div");
    row.className = "setting-row";
    const label = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = EVENT_TYPES[eventType];
    const description = document.createElement("small");
    description.textContent = "알림 ON/OFF";
    label.append(title, description);
    const enabled = settings[eventType] !== "off";
    row.append(label, switchControl(enabled, (checked) => onChange(eventType, checked ? "on" : "off"), `${EVENT_TYPES[eventType]} 알림`));
    container.append(row);
  });
}

/**
 * Creates a button for removing an item.
 *
 * @param label - The item label included in the button's accessible name
 * @param onClick - The callback invoked when the button is clicked
 * @returns The configured removal button
 */
function removeButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = "삭제";
  button.setAttribute("aria-label", `${label} 삭제`);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Renders subjects with their names, roles, IDs, and removal controls.
 *
 * @param subjects - The subjects to display.
 * @param onRemove - Called with a subject ID when its removal control is activated.
 * @param onCapture - Called with a subject ID when its reference capture control is activated.
 */
export function renderSubjects(
  container: HTMLElement,
  subjects: readonly Subject[],
  onRemove: (id: string) => void,
  onCapture: (id: string) => Promise<void> | void,
): void {
  container.replaceChildren();
  subjects.forEach((subject) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = subject.name;
    const meta = document.createElement("small");
    meta.textContent = `${subject.role} · 기준 사진 ${subject.referenceSampleCount ?? 0}장 · ${subject.id}`;
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "inline-actions";
    const capture = document.createElement("button");
    capture.type = "button";
    capture.className = "button button-secondary button-small";
    capture.textContent = "기준 사진 촬영";
    capture.addEventListener("click", async () => {
      capture.disabled = true;
      try { await onCapture(subject.id); } finally { capture.disabled = false; }
    });
    actions.append(capture, removeButton(subject.name, () => onRemove(subject.id)));
    item.append(copy, actions);
    container.append(item);
  });
}

/**
 * Renders managed items as removable chips.
 *
 * @param items - The managed items to display, including their labels and policies
 * @param onRemove - Called with an item's ID when its remove button is clicked
 * @param onCapture - Called with an item's ID when its camera capture button is clicked
 */
export function renderManagedItems(
  container: HTMLElement,
  items: readonly ManagedItem[],
  onRemove: (id: string) => void,
  onCapture: (id: string) => Promise<void> | void,
): void {
  container.replaceChildren();
  items.forEach((item) => {
    const chip = document.createElement("span");
    chip.className = `item-chip${item.policy === "excluded" ? " is-excluded" : ""}`;
    const label = document.createElement("span");
    label.textContent = `${item.label} · ${item.policy === "included" ? "위험물 탐지" : "event 제외"} · 학습 사진 ${item.sampleCount ?? 0}장`;
    const capture = document.createElement("button");
    capture.type = "button";
    capture.className = "item-capture-button";
    capture.textContent = "카메라 촬영";
    capture.addEventListener("click", async () => {
      capture.disabled = true;
      try { await onCapture(item.id); } finally { capture.disabled = false; }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `${item.label} 삭제`);
    remove.addEventListener("click", () => onRemove(item.id));
    chip.append(label, capture, remove);
    container.append(chip);
  });
}

/**
 * Renders saved zones with their names, dimensions, and removal controls.
 *
 * @param container - The element that receives the rendered zone list
 * @param zones - The zones to display
 * @param onRemove - Callback invoked with a zone ID when its removal control is activated
 */
export function renderZones(container: HTMLElement, zones: readonly Zone[], onRemove: (id: string) => void): void {
  container.replaceChildren();
  if (!zones.length) {
    const empty = document.createElement("p");
    empty.className = "helper";
    empty.textContent = "저장된 주의 구역이 없습니다.";
    container.append(empty);
    return;
  }
  zones.forEach((zone) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = zone.name;
    const meta = document.createElement("small");
    meta.textContent = `x ${Math.round(zone.x * 100)}% · y ${Math.round(zone.y * 100)}% · ${Math.round(zone.width * 100)}×${Math.round(zone.height * 100)}%`;
    copy.append(title, meta);
    item.append(copy, removeButton(zone.name, () => onRemove(zone.id)));
    container.append(item);
  });
}
