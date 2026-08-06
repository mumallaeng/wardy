import { EVENT_TYPES, OVERLAY_FIELDS } from "./constants.ts";
import type { EventType, ManagedItem, NotificationLevel, NotificationSettings, OverlaySettingKey, OverlaySettings, Subject, Zone } from "./types.ts";

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

export function renderNotifications(
  container: HTMLElement,
  settings: NotificationSettings,
  onChange: (eventType: EventType, value: NotificationLevel) => void,
): void {
  container.replaceChildren();
  const configurableEventTypes: EventType[] = ["fall_suspected", "inactivity", "hazard_detected", "hazard_proximity"];
  configurableEventTypes.forEach((eventType) => {
    const row = document.createElement("div");
    row.className = "setting-row";
    const label = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = EVENT_TYPES[eventType];
    const description = document.createElement("small");
    description.textContent = "알림 사용 여부와 강도";
    label.append(title, description);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${EVENT_TYPES[eventType]} 알림`);
    const options: Array<[NotificationLevel, string]> = [["off", "사용 안 함"], ["normal", "일반"], ["strong", "강하게"]];
    options.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    select.value = settings[eventType] ?? "normal";
    select.addEventListener("change", () => onChange(eventType, select.value as NotificationLevel));
    row.append(label, select);
    container.append(row);
  });
}

function removeButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = "삭제";
  button.setAttribute("aria-label", `${label} 삭제`);
  button.addEventListener("click", onClick);
  return button;
}

export function renderSubjects(container: HTMLElement, subjects: readonly Subject[], onRemove: (id: string) => void): void {
  container.replaceChildren();
  subjects.forEach((subject) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = subject.name;
    const meta = document.createElement("small");
    meta.textContent = `${subject.role} · ${subject.id}`;
    copy.append(title, meta);
    item.append(copy, removeButton(subject.name, () => onRemove(subject.id)));
    container.append(item);
  });
}

export function renderManagedItems(container: HTMLElement, items: readonly ManagedItem[], onRemove: (id: string) => void): void {
  container.replaceChildren();
  items.forEach((item) => {
    const chip = document.createElement("span");
    chip.className = `item-chip${item.policy === "excluded" ? " is-excluded" : ""}`;
    const label = document.createElement("span");
    label.textContent = `${item.label} · ${item.policy === "included" ? "관리" : "제외"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "×";
    button.setAttribute("aria-label", `${item.label} 삭제`);
    button.addEventListener("click", () => onRemove(item.id));
    chip.append(label, button);
    container.append(chip);
  });
}

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
