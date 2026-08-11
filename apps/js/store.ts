import { CARE_STATUS, EVENT_STATUS, EVENT_TYPES, createInitialState } from "./constants.ts";
import type { CareStatus, DatasetSample, EventType, IdentityReview, IdentityReviewDecision, ManagedItem, ManagedItemPolicy, NotificationSetting, OverlaySettingKey, Subject, SystemState, WardyEvent, WardyState, ZoneRect } from "./types.ts";

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

function isDatasetSample(value: unknown): value is DatasetSample {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.modelId === "string"
    && typeof value.requirementId === "string"
    && typeof value.label === "string"
    && ["pending", "approved", "rejected"].includes(String(value.reviewStatus))
    && typeof value.captureSession === "string"
    && ["jetson_camera", "local_file"].includes(String(value.source))
    && typeof value.imagePath === "string"
    && isStringOrNull(value.originalFilename)
    && typeof value.capturedAt === "string"
    && typeof value.width === "number" && Number.isInteger(value.width) && value.width > 0
    && typeof value.height === "number" && Number.isInteger(value.height) && value.height > 0;
}

function migrateJetsonBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port !== "8189") return value;
    url.port = "8443";
    const migrated = url.toString();
    return url.pathname === "/" && !url.search && !url.hash ? migrated.replace(/\/$/, "") : migrated;
  } catch {
    return value;
  }
}

function migratePersistedState(value: unknown): void {
  if (!isRecord(value)) return;
  if (value.identityReviews === undefined) value.identityReviews = [];
  if (value.datasetSamples === undefined) value.datasetSamples = [];
  if (Array.isArray(value.events)) {
    value.events = value.events.filter(
      (event) => !isRecord(event) || event.event_type !== "managed_item_moved",
    );
  }
  const settings = value.settings;
  if (!isRecord(settings)) return;
  if (!isRecord(settings.camera)) settings.camera = {};
  const camera = settings.camera as Record<string, unknown>;
  if (typeof camera.mirrored !== "boolean") camera.mirrored = false;
  if (!isRecord(settings.jetson)) settings.jetson = {};
  const jetson = settings.jetson as Record<string, unknown>;
  const baseUrl = typeof jetson.baseUrl === "string" ? jetson.baseUrl : "";
  jetson.baseUrl = migrateJetsonBaseUrl(baseUrl);
  delete jetson.accessToken;
  delete jetson.viewerToken;
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  if (!isRecord(settings.dataWorkspace)) settings.dataWorkspace = {};
  const dataWorkspace = settings.dataWorkspace as Record<string, unknown>;
  if (typeof dataWorkspace.captureSession !== "string") {
    dataWorkspace.captureSession = `session-${day}`;
  }
  if (typeof dataWorkspace.datasetVersion !== "string") {
    dataWorkspace.datasetVersion = `wardy-${day}-v1`;
  }
  if (!isRecord(settings.notifications)) return;
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
    && (value.care_status === null || (typeof value.care_status === "string" && Object.hasOwn(CARE_STATUS, value.care_status)))
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

function isSystemState(value: unknown): value is SystemState {
  if (!isRecord(value)) return false;
  return (value.care_state === null
      || (typeof value.care_state === "string" && Object.hasOwn(CARE_STATUS, value.care_state)))
    && ["idle", "connecting", "connected", "fault"].includes(String(value.camera_state))
    && ["disconnected", "ready", "running", "fault"].includes(String(value.detection_state))
    && ["ready", "processing", "fault"].includes(String(value.event_state))
    && typeof value.reason === "string"
    && typeof value.updated_at === "string";
}

function isSubject(value: unknown): value is Subject {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.name === "string"
    && typeof value.role === "string" && typeof value.createdAt === "string"
    && isOptionalCount(value.referenceSampleCount);
}

function isManagedItem(value: unknown): value is ManagedItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.label === "string"
    && ["included", "excluded"].includes(String(value.policy))
    && isOptionalCount(value.sampleCount);
}
function isWardyState(value: unknown): value is WardyState {
  if (!isRecord(value) || value.version !== 1) return false;
  const careState = value.careState;
  const settings = value.settings;
  if (!isRecord(careState)
    || !(careState.status === null || (typeof careState.status === "string" && Object.hasOwn(CARE_STATUS, careState.status)))
    || typeof careState.reason !== "string"
    || typeof careState.updatedAt !== "string"
    || !["manual_ui", "jetson_runtime"].includes(String(careState.source))
    || !isRecord(settings)
    || !isRecord(settings.overlay)
    || typeof settings.overlay.showClass !== "boolean"
    || typeof settings.overlay.showRole !== "boolean"
    || typeof settings.overlay.showName !== "boolean"
    || typeof settings.overlay.showPosture !== "boolean"
    || !isRecord(settings.camera)
    || typeof settings.camera.mirrored !== "boolean"
    || !isRecord(settings.notifications)
    || !Object.entries(settings.notifications).every(([key, level]) => Object.hasOwn(EVENT_TYPES, key) && ["off", "on"].includes(String(level)))
    || !isRecord(settings.jetson)
    || typeof settings.jetson.baseUrl !== "string"
    || !isRecord(settings.dataWorkspace)
    || typeof settings.dataWorkspace.captureSession !== "string"
    || typeof settings.dataWorkspace.datasetVersion !== "string") return false;

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
    && Array.isArray(value.identityReviews) && value.identityReviews.every(isIdentityReview)
    && Array.isArray(value.datasetSamples) && value.datasetSamples.every(isDatasetSample);
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
      if (!isWardyState(parsed)) {
        const initial = createInitialState();
        try { this.storage?.setItem(this.key, JSON.stringify(initial)); } catch { /* In-memory defaults remain usable. */ }
        return initial;
      }
      try { this.storage?.setItem(this.key, JSON.stringify(parsed)); } catch { /* Valid in-memory state remains usable. */ }
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

  applyRuntimeSnapshot(system: SystemState, events: WardyEvent[]): WardyState {
    if (!isSystemState(system)) throw new Error("Jetson system 상태 응답 형식이 올바르지 않습니다.");
    const status = system.care_state;
    const validEvents = events.filter(isWardyEvent);
    return this.#commit((state) => {
      state.careState = {
        status,
        reason: system.reason || (status ? CARE_STATUS[status].reason : "안전 상태를 판단할 수 없습니다."),
        updatedAt: system.updated_at,
        source: "jetson_runtime",
      };
      state.events = clone(validEvents);
    });
  }

  replaceSubjects(subjects: Subject[]): WardyState {
    return this.#commit((state) => { state.subjects = clone(subjects.filter(isSubject)); });
  }

  replaceManagedItems(items: ManagedItem[]): WardyState {
    return this.#commit((state) => { state.managedItems = clone(items.filter(isManagedItem)); });
  }

  replaceDatasetSamples(samples: DatasetSample[]): WardyState {
    return this.#commit((state) => { state.datasetSamples = clone(samples.filter(isDatasetSample)); });
  }

  setDataWorkspace(captureSession: string, datasetVersion: string): WardyState {
    return this.#commit((state) => {
      state.settings.dataWorkspace = {
        captureSession: captureSession.trim(),
        datasetVersion: datasetVersion.trim(),
      };
    });
  }

  setOverlaySetting(key: OverlaySettingKey, value: boolean): WardyState {
    return this.#commit((state) => { state.settings.overlay[key] = Boolean(value); });
  }

  setNotificationSetting(eventType: EventType, value: NotificationSetting): WardyState {
    return this.#commit((state) => { state.settings.notifications[eventType] = value; });
  }

  setCameraMirrored(mirrored: boolean): WardyState {
    return this.#commit((state) => { state.settings.camera.mirrored = Boolean(mirrored); });
  }

  setJetsonBaseUrl(baseUrl: string): WardyState {
    return this.#commit((state) => {
      state.settings.jetson = { baseUrl: String(baseUrl ?? "").trim() };
    });
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
