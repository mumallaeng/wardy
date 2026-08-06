import { CARE_STATUS, createInitialState } from "./constants.ts";
import type { CareStatus, EventType, ManagedItemPolicy, NotificationSetting, OverlaySettingKey, WardyEvent, WardyState, ZoneRect } from "./types.ts";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StoreListener = (state: WardyState) => void;

const clone = <T>(value: T): T => structuredClone(value);

function isWardyState(value: unknown): value is WardyState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WardyState>;
  return candidate.version === 1 && Array.isArray(candidate.events) && Boolean(candidate.settings);
}

export class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
  removeItem(key: string): void { this.data.delete(key); }
}

export class WardyStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private readonly listeners = new Set<StoreListener>();
  private state: WardyState;

  constructor(storage: StorageLike | null, key = "wardy-ui-state-v1") {
    this.storage = storage;
    this.key = key;
    this.state = this.#load();
  }

  #load(): WardyState {
    try {
      const stored = this.storage?.getItem(this.key);
      if (!stored) return createInitialState();
      const parsed = JSON.parse(stored);
      if (!isWardyState(parsed)) return createInitialState();
      const state = parsed as WardyState;
      const notifications = state.settings.notifications as Record<string, NotificationSetting | "normal" | "strong">;
      Object.entries(notifications).forEach(([eventType, value]) => {
        notifications[eventType] = value === "off" ? "off" : "on";
      });
      return state;
    } catch {
      return createInitialState();
    }
  }

  #persist(): void {
    try { this.storage?.setItem(this.key, JSON.stringify(this.state)); } catch { /* UI remains usable without persistence. */ }
  }

  #commit(mutator: (state: WardyState) => void): WardyState {
    const next = clone(this.state);
    mutator(next);
    this.state = next;
    this.#persist();
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  getState(): WardyState { return clone(this.state); }
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setCareState(status: CareStatus, reason = CARE_STATUS[status].reason): WardyState {
    if (!CARE_STATUS[status]) throw new Error(`Unsupported care status: ${status}`);
    return this.#commit((state) => { state.careState = { status, reason, updatedAt: new Date().toISOString(), source: "manual_ui" }; });
  }

  setOverlaySetting(key: OverlaySettingKey, value: boolean): WardyState {
    return this.#commit((state) => { state.settings.overlay[key] = Boolean(value); });
  }

  setNotificationSetting(eventType: EventType, value: NotificationSetting): WardyState {
    return this.#commit((state) => { state.settings.notifications[eventType] = value; });
  }

  setJetsonBaseUrl(baseUrl: string): WardyState {
    return this.#commit((state) => { state.settings.jetson = { baseUrl: String(baseUrl ?? "").trim() }; });
  }

  addEvent(event: WardyEvent): WardyState {
    return this.#commit((state) => { state.events.unshift(clone(event)); });
  }

  confirmEvent(eventId: string, at = new Date().toISOString()): WardyState {
    return this.#commit((state) => {
      const event = state.events.find((candidate) => candidate.event_id === eventId);
      if (!event) throw new Error(`Unknown event: ${eventId}`);
      if (event.event_status === "released" || event.event_status === "false_detection") return;
      event.event_status = "confirmed";
      event.confirmed_at = at;
    });
  }

  markFalseDetection(eventId: string, at = new Date().toISOString()): WardyState {
    return this.#commit((state) => {
      const event = state.events.find((candidate) => candidate.event_id === eventId);
      if (!event) throw new Error(`Unknown event: ${eventId}`);
      event.event_status = "false_detection";
      event.false_detection_at = at;
    });
  }

  removeEventMedia(eventId: string): WardyState {
    return this.#commit((state) => {
      const event = state.events.find((candidate) => candidate.event_id === eventId);
      if (!event) throw new Error(`Unknown event: ${eventId}`);
      event.media_type = "none";
      event.media_path = null;
      event.media_started_at = null;
      event.media_ended_at = null;
    });
  }

  addManagedItem(label: string, policy: ManagedItemPolicy): WardyState {
    return this.#commit((state) => {
      state.managedItems.push({ id: `item-${crypto.randomUUID()}`, label, policy, sampleCount: 0 });
    });
  }

  setManagedItemSampleCount(itemId: string, sampleCount: number): WardyState {
    return this.#commit((state) => {
      const item = state.managedItems.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`Unknown managed item: ${itemId}`);
      item.sampleCount = Math.max(0, Math.trunc(sampleCount));
    });
  }

  removeManagedItem(itemId: string): WardyState {
    return this.#commit((state) => { state.managedItems = state.managedItems.filter((item) => item.id !== itemId); });
  }

  addZone(zone: ZoneRect): WardyState {
    return this.#commit((state) => { state.zones.push({ id: `zone-${crypto.randomUUID()}`, ...zone }); });
  }

  removeZone(zoneId: string): WardyState {
    return this.#commit((state) => { state.zones = state.zones.filter((zone) => zone.id !== zoneId); });
  }

  addSubject(name: string, role: string): WardyState {
    return this.#commit((state) => {
      state.subjects.push({ id: `subject-${crypto.randomUUID()}`, name, role, createdAt: new Date().toISOString() });
    });
  }

  removeSubject(subjectId: string): WardyState {
    return this.#commit((state) => { state.subjects = state.subjects.filter((subject) => subject.id !== subjectId); });
  }

  reset(): WardyState {
    this.state = createInitialState();
    this.#persist();
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }
}
