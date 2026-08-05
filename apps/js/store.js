import { CARE_STATUS, createInitialState } from "./constants.js";

const clone = (value) => structuredClone(value);

export class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

export class WardyStore {
  constructor(storage, key = "wardy-ui-state-v1") {
    this.storage = storage;
    this.key = key;
    this.listeners = new Set();
    this.state = this.#load();
  }

  #load() {
    try {
      const stored = this.storage?.getItem(this.key);
      if (!stored) return createInitialState();
      const parsed = JSON.parse(stored);
      if (parsed?.version !== 1 || !Array.isArray(parsed.events)) return createInitialState();
      return parsed;
    } catch {
      return createInitialState();
    }
  }

  #persist() {
    try { this.storage?.setItem(this.key, JSON.stringify(this.state)); } catch { /* UI remains usable without persistence. */ }
  }

  #commit(mutator) {
    const next = clone(this.state);
    mutator(next);
    this.state = next;
    this.#persist();
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  getState() { return clone(this.state); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  setCareState(status, reason = CARE_STATUS[status]?.reason) {
    if (!CARE_STATUS[status]) throw new Error(`Unsupported care status: ${status}`);
    return this.#commit((state) => { state.careState = { status, reason, updatedAt: new Date().toISOString(), source: "manual_ui" }; });
  }

  setOverlaySetting(key, value) {
    return this.#commit((state) => { state.settings.overlay[key] = Boolean(value); });
  }

  setNotificationSetting(eventType, value) {
    return this.#commit((state) => { state.settings.notifications[eventType] = value; });
  }

  addEvent(event) {
    return this.#commit((state) => { state.events.unshift(clone(event)); });
  }

  confirmEvent(eventId, at = new Date().toISOString()) {
    return this.#commit((state) => {
      const event = state.events.find((candidate) => candidate.event_id === eventId);
      if (!event) throw new Error(`Unknown event: ${eventId}`);
      if (event.event_status === "released" || event.event_status === "false_detection") return;
      event.event_status = "confirmed";
      event.confirmed_at = at;
    });
  }

  markFalseDetection(eventId, at = new Date().toISOString()) {
    return this.#commit((state) => {
      const event = state.events.find((candidate) => candidate.event_id === eventId);
      if (!event) throw new Error(`Unknown event: ${eventId}`);
      event.event_status = "false_detection";
      event.false_detection_at = at;
    });
  }

  removeEventMedia(eventId) {
    return this.#commit((state) => {
      const event = state.events.find((candidate) => candidate.event_id === eventId);
      if (!event) throw new Error(`Unknown event: ${eventId}`);
      event.media_type = "none";
      event.media_path = null;
      event.media_started_at = null;
      event.media_ended_at = null;
    });
  }

  addManagedItem(label, policy) {
    return this.#commit((state) => {
      state.managedItems.push({ id: `item-${crypto.randomUUID()}`, label, policy });
    });
  }

  removeManagedItem(itemId) {
    return this.#commit((state) => { state.managedItems = state.managedItems.filter((item) => item.id !== itemId); });
  }

  addZone(zone) {
    return this.#commit((state) => { state.zones.push({ id: `zone-${crypto.randomUUID()}`, ...zone }); });
  }

  removeZone(zoneId) {
    return this.#commit((state) => { state.zones = state.zones.filter((zone) => zone.id !== zoneId); });
  }

  addSubject(name, role) {
    return this.#commit((state) => {
      state.subjects.push({ id: `subject-${crypto.randomUUID()}`, name, role, createdAt: new Date().toISOString() });
    });
  }

  removeSubject(subjectId) {
    return this.#commit((state) => { state.subjects = state.subjects.filter((subject) => subject.id !== subjectId); });
  }

  reset() {
    this.state = createInitialState();
    this.#persist();
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }
}
