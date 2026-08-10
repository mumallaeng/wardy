import { normalizeJetsonBaseUrl } from "./jetson.ts";
import type { ManagedItem, ManagedItemPolicy, Subject, SystemState, WardyEvent } from "./types.ts";

export interface RuntimeSnapshot {
  state: SystemState;
  events: WardyEvent[];
}

interface RuntimeCollections {
  subjects: Subject[];
  managedItems: ManagedItem[];
}

type SnapshotHandler = (snapshot: RuntimeSnapshot) => void;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type ScheduleTimeout = (callback: () => void, delay: number) => TimeoutHandle;
type CancelTimeout = (handle: TimeoutHandle) => void;

const REQUEST_TIMEOUT_MS = 10_000;
const MEDIA_TIMEOUT_MS = 60_000;
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

function endpoint(baseUrl: string, path: string, fallbackOrigin: string): string {
  return `${normalizeJetsonBaseUrl(baseUrl, fallbackOrigin)}${path}`;
}

function encodedHeaders(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encodeURIComponent(value)]));
}

export class WardyRuntimeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: (url: string, protocols: string[]) => WebSocket;
  private readonly scheduleTimeout: ScheduleTimeout;
  private readonly cancelTimeout: CancelTimeout;
  private readonly random: () => number;
  private socket: WebSocket | null = null;
  private reconnectTimer: TimeoutHandle | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private connected = false;
  private stopped = true;

  constructor(
    fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    websocketFactory = (url: string, protocols: string[]) => new WebSocket(url, protocols),
    scheduleTimeout: ScheduleTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancelTimeout: CancelTimeout = (handle) => globalThis.clearTimeout(handle),
    random: () => number = Math.random,
  ) {
    this.fetchImpl = fetchImpl;
    this.websocketFactory = websocketFactory;
    this.scheduleTimeout = scheduleTimeout;
    this.cancelTimeout = cancelTimeout;
    this.random = random;
  }

  private async request<T>(baseUrl: string, accessToken: string, fallbackOrigin: string,
                           path: string, init: RequestInit = {}): Promise<T> {
    if (!accessToken) throw new Error("Jetson 데이터 API 토큰이 필요합니다.");
    const signal = init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this.fetchImpl(endpoint(baseUrl, path, fallbackOrigin), {
      ...init,
      cache: "no-store",
      signal,
      headers: { Accept: "application/json", "X-Wardy-Access-Token": accessToken, ...init.headers },
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error : `Jetson 요청에 실패했습니다. HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }

  async loadSnapshot(baseUrl: string, accessToken: string,
                     fallbackOrigin: string): Promise<RuntimeSnapshot> {
    const [state, eventBody] = await Promise.all([
      this.request<SystemState>(baseUrl, accessToken, fallbackOrigin, "/api/state"),
      this.request<{ events: WardyEvent[] }>(baseUrl, accessToken, fallbackOrigin, "/api/events"),
    ]);
    return { state, events: eventBody.events };
  }

  async loadCollections(baseUrl: string, accessToken: string,
                        fallbackOrigin: string): Promise<RuntimeCollections> {
    const [subjectBody, itemBody] = await Promise.all([
      this.request<{ subjects: Subject[] }>(baseUrl, accessToken, fallbackOrigin, "/api/subjects"),
      this.request<{ managedItems: ManagedItem[] }>(baseUrl, accessToken, fallbackOrigin, "/api/managed-items"),
    ]);
    return { subjects: subjectBody.subjects, managedItems: itemBody.managedItems };
  }

  async eventAction(baseUrl: string, accessToken: string, fallbackOrigin: string,
                    eventId: string, action: "confirm" | "release" | "false-detection"): Promise<WardyEvent> {
    return this.request(baseUrl, accessToken, fallbackOrigin,
      `/api/events/${encodeURIComponent(eventId)}/${action}`, { method: "POST" });
  }

  async loadEventMedia(baseUrl: string, accessToken: string, fallbackOrigin: string,
                       eventId: string): Promise<Blob> {
    if (!accessToken) throw new Error("Jetson 데이터 API 토큰이 필요합니다.");
    const response = await this.fetchImpl(endpoint(baseUrl,
      `/api/events/${encodeURIComponent(eventId)}/media`, fallbackOrigin), {
      headers: { "X-Wardy-Access-Token": accessToken }, cache: "no-store",
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`이벤트 자료를 불러오지 못했습니다. HTTP ${response.status}`);
    return response.blob();
  }

  async deleteEventMedia(baseUrl: string, accessToken: string, fallbackOrigin: string,
                         eventId: string): Promise<void> {
    await this.request(baseUrl, accessToken, fallbackOrigin,
      `/api/events/${encodeURIComponent(eventId)}/media`, { method: "DELETE" });
  }

  async createDebugEvent(baseUrl: string, accessToken: string,
                         fallbackOrigin: string): Promise<WardyEvent> {
    return this.request(baseUrl, accessToken, fallbackOrigin, "/api/debug/events", {
      method: "POST",
      headers: encodedHeaders({
        "X-Wardy-Event-Type": "fall_suspected",
        "X-Wardy-Event-Active": "true",
        "X-Wardy-Subject-Id": "subject-debug",
        "X-Wardy-Subject-Name": "UI 검증 대상",
        "X-Wardy-Subject-Location": "거실",
        "X-Wardy-Reason": "AI와 연결되지 않은 event runtime 검증 입력",
      }),
    });
  }

  async createSubject(baseUrl: string, accessToken: string, fallbackOrigin: string,
                      name: string, role: string): Promise<Subject[]> {
    const body = await this.request<{ subjects: Subject[] }>(baseUrl, accessToken, fallbackOrigin,
      "/api/subjects", { method: "POST", headers: encodedHeaders({
        "X-Wardy-Subject-Id": `subject-${crypto.randomUUID()}`,
        "X-Wardy-Subject-Name": name,
        "X-Wardy-Subject-Role": role,
      }) });
    return body.subjects;
  }

  async deleteSubject(baseUrl: string, accessToken: string, fallbackOrigin: string,
                      subjectId: string): Promise<Subject[]> {
    const body = await this.request<{ subjects: Subject[] }>(baseUrl, accessToken, fallbackOrigin,
      `/api/subjects/${encodeURIComponent(subjectId)}`, { method: "DELETE" });
    return body.subjects;
  }

  async createManagedItem(baseUrl: string, accessToken: string, fallbackOrigin: string,
                          label: string, policy: ManagedItemPolicy): Promise<ManagedItem[]> {
    const body = await this.request<{ managedItems: ManagedItem[] }>(baseUrl, accessToken, fallbackOrigin,
      "/api/managed-items", { method: "POST", headers: encodedHeaders({
        "X-Wardy-Item-Id": `item-${crypto.randomUUID()}`,
        "X-Wardy-Item-Label": label,
        "X-Wardy-Item-Policy": policy,
      }) });
    return body.managedItems;
  }

  async deleteManagedItem(baseUrl: string, accessToken: string, fallbackOrigin: string,
                          itemId: string): Promise<ManagedItem[]> {
    const body = await this.request<{ managedItems: ManagedItem[] }>(baseUrl, accessToken, fallbackOrigin,
      `/api/managed-items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
    return body.managedItems;
  }

  connect(baseUrl: string, accessToken: string, fallbackOrigin: string,
          onSnapshot: SnapshotHandler): void {
    this.stop();
    this.stopped = false;
    this.reconnectDelay = RECONNECT_INITIAL_MS;
    const open = (): void => {
      if (this.stopped) return;
      const url = new URL(endpoint(baseUrl, "/api/ws", fallbackOrigin));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = this.websocketFactory(url.toString(), ["wardy-events", accessToken]);
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.connected = true;
        this.reconnectDelay = RECONNECT_INITIAL_MS;
      }, { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const body: unknown = JSON.parse(String(event.data));
          if (body && typeof body === "object" && "type" in body && body.type === "snapshot" &&
              "state" in body && "events" in body && Array.isArray(body.events)) {
            onSnapshot({ state: body.state as SystemState, events: body.events as WardyEvent[] });
          }
        } catch { /* A later valid snapshot can recover the view. */ }
      });
      const reconnect = (): void => {
        if (this.socket === socket) this.socket = null;
        this.connected = false;
        if (!this.stopped && this.reconnectTimer === null) {
          const jitter = 0.8 + this.random() * 0.4;
          const delay = Math.round(this.reconnectDelay * jitter);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
          this.reconnectTimer = this.scheduleTimeout(() => {
            this.reconnectTimer = null;
            open();
          }, delay);
        }
      };
      socket.addEventListener("close", reconnect, { once: true });
      socket.addEventListener("error", () => socket.close(), { once: true });
    };
    open();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer !== null) this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  isConnected(): boolean { return this.connected; }
}
