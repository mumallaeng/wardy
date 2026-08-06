import { CARE_STATUS, EVENT_STATUS, EVENT_TYPES, createInitialState } from "./constants.ts";
import type { CareStatus, EventType, IdentityReview, IdentityReviewDecision, ManagedItemPolicy, NotificationSetting, OverlaySettingKey, WardyEvent, WardyState, ZoneRect } from "./types.ts";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StoreListener = (state: WardyState) => void;

const clone = <T>(value: T): T => structuredClone(value);

/** Returns whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isIdentityReview(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.imagePath === "string"
    && typeof value.capturedAt === "string"
    && isStringOrNull(value.predictedName)
    && (value.confidence === null || (typeof value.confidence === "number" && Number.isFinite(value.confidence)))
    && ["pending", "subject", "unknown", "excluded"].includes(String(value.decision))
    && isStringOrNull(value.subjectId);
}

function migratePersistedState(value: unknown): void {
  if (!isRecord(value)) return;
  if (value.identityReviews === undefined) value.identityReviews = [];
  if (Array.isArray(value.events)) {
    value.events = value.events.filter(
      (event) => !isRecord(event) || event.event_type !== "managed_item_moved",
    );
  }
  const settings = value.settings;
  if (!isRecord(settings) || !isRecord(settings.notifications)) return;
  const notifications = settings.notifications;
  delete notifications.managed_item_moved;
  Object.entries(notifications).forEach(([eventType, level]) => {
    if (level === "normal" || level === "strong") notifications[eventType] = "on";
  });
}

function isWardyEvent(value: unknown): value is WardyEvent {
  if (!isRecord(value)) return false;
  return typeof value.event_id === "string"
    && typeof value.event_type === "string" && Object.hasOwn(EVENT_TYPES, value.event_type)
    && typeof value.occurred_at === "string"
    && typeof value.first_seen_at === "string"
    && typeof value.last_seen_at === "string"
    && isStringOrNull(value.subject_id)
    && isStringOrNull(value.subject_name)
    && isStringOrNull(value.subject_location)
    && isStringOrNull(value.object_id)
    && isStringOrNull(value.object_class)
    && isStringOrNull(value.zone_id)
    && typeof value.care_status === "string" && Object.hasOwn(CARE_STATUS, value.care_status)
    && typeof value.event_status === "string" && Object.hasOwn(EVENT_STATUS, value.event_status)
    && isStringOrNull(value.confirmed_at)
    && isStringOrNull(value.released_at)
    && isStringOrNull(value.false_detection_at)
    && typeof value.reason === "string"
    && Array.isArray(value.source_results)
    && value.source_results.every((result) => isRecord(result) && typeof result.source === "string" && typeof result.note === "string")
    && ["none", "image", "video"].includes(String(value.media_type))
    && isStringOrNull(value.media_path)
    && isStringOrNull(value.media_started_at)
    && isStringOrNull(value.media_ended_at);
}
function isWardyState(value: unknown): value is WardyState {
  if (!isRecord(value) || value.version !== 1) return false;
  const careState = value.careState;
  const settings = value.settings;
  if (!isRecord(careState)
    || typeof careState.status !== "string" || !Object.hasOwn(CARE_STATUS, careState.status)
    || typeof careState.reason !== "string"
    || typeof careState.updatedAt !== "string"
    || careState.source !== "manual_ui"
    || !isRecord(settings)
    || !isRecord(settings.overlay)
    || typeof settings.overlay.showClass !== "boolean"
    || typeof settings.overlay.showRole !== "boolean"
    || typeof settings.overlay.showName !== "boolean"
    || typeof settings.overlay.showPosture !== "boolean"
    || !isRecord(settings.notifications)
    || !Object.entries(settings.notifications).every(([key, level]) => Object.hasOwn(EVENT_TYPES, key) && ["off", "on"].includes(String(level)))
    || !isRecord(settings.jetson)
    || typeof settings.jetson.baseUrl !== "string") return false;

  return Array.isArray(value.events) && value.events.every(isWardyEvent)
    && Array.isArray(value.managedItems) && value.managedItems.every((item) => isRecord(item)
      && typeof item.id === "string" && typeof item.label === "string"
      && ["included", "excluded"].includes(String(item.policy)) && isOptionalCount(item.sampleCount))
    && Array.isArray(value.zones) && value.zones.every((zone) => isRecord(zone)
      && typeof zone.id === "string" && typeof zone.name === "string"
      && [zone.x, zone.y, zone.width, zone.height].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)))
    && Array.isArray(value.subjects) && value.subjects.every((subject) => isRecord(subject)
      && typeof subject.id === "string" && typeof subject.name === "string"
      && typeof subject.role === "string" && typeof subject.createdAt === "string"
      && isOptionalCount(subject.referenceSampleCount))
    && Array.isArray(value.identityReviews) && value.identityReviews.every(isIdentityReview);
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
      const parsed: unknown = JSON.parse(stored);
      migratePersistedState(parsed);
      if (!isWardyState(parsed)) return createInitialState();
      return parsed;
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
      state.subjects.push({ id: `subject-${crypto.randomUUID()}`, name, role, createdAt: new Date().toISOString(), referenceSampleCount: 0 });
    });
  }

  setSubjectReferenceSampleCount(subjectId: string, sampleCount: number): WardyState {
    return this.#commit((state) => {
      const subject = state.subjects.find((candidate) => candidate.id === subjectId);
      if (!subject) throw new Error(`Unknown subject: ${subjectId}`);
      subject.referenceSampleCount = Math.max(0, Math.trunc(sampleCount));
    });
  }

  addIdentityReview(review: Omit<IdentityReview, "id" | "decision" | "subjectId">): WardyState {
    return this.#commit((state) => {
      state.identityReviews.unshift({
        ...review,
        id: `review-${crypto.randomUUID()}`,
        decision: "pending",
        subjectId: null,
      });
    });
  }

  resolveIdentityReview(reviewId: string, decision: IdentityReviewDecision,
                        subjectId: string | null = null): WardyState {
    return this.#commit((state) => {
      const review = state.identityReviews.find((candidate) => candidate.id === reviewId);
      if (!review) throw new Error(`Unknown identity review: ${reviewId}`);
      review.decision = decision;
      review.subjectId = decision === "subject" ? subjectId : null;
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
