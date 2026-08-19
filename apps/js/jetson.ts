import type { JetsonHealthResult, JetsonStatus, JetsonStatusDetail } from "./types.ts";

type JetsonStatusHandler = (status: JetsonStatus, detail?: JetsonStatusDetail) => void;

interface JetsonConnectionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onStatus?: JetsonStatusHandler;
}

/**
 * Converts an unknown error value to a message string.
 *
 * @param error - The error value to convert
 * @returns The error message or string representation of `error`
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalizes and validates a Jetson base URL.
 *
 * @param value - The preferred Jetson URL.
 * @param fallbackOrigin - The URL to use when `value` is empty.
 * @returns The normalized HTTP(S) base URL without trailing slashes, query strings, or fragments.
 * @throws Error if no URL is provided, the URL is invalid, uses an unsupported protocol/port, or contains credentials.
 */
export function normalizeJetsonBaseUrl(value: string, fallbackOrigin = ""): string {
  const candidate = String(value ?? "").trim() || String(fallbackOrigin ?? "").trim();
  if (!candidate) throw new Error("Jetson 서비스 주소를 입력해 주세요.");
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Jetson 주소는 HTTP 또는 HTTPS 형식이어야 합니다.");
  }
  if (url.username || url.password) throw new Error("주소에 계정 정보를 포함할 수 없습니다.");
  const servicePort = url.protocol === "https:" ? "8443" : "8088";
  const authority = candidate.match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const explicitPort = hostPort.startsWith("[")
    ? hostPort.match(/\]:(\d+)$/)?.[1]
    : hostPort.match(/:(\d+)$/)?.[1];
  if (explicitPort && explicitPort !== servicePort) {
    throw new Error(`Jetson ${url.protocol === "https:" ? "HTTPS" : "HTTP"} 주소 port는 ${servicePort}이어야 합니다. 8189는 WebRTC 전송 전용입니다.`);
  }
  if (!url.port) url.port = servicePort;
  if (url.port !== servicePort) {
    throw new Error(`Jetson ${url.protocol === "https:" ? "HTTPS" : "HTTP"} 주소 port는 ${servicePort}이어야 합니다. 8189는 WebRTC 전송 전용입니다.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Builds the Jetson health endpoint URL from a base URL.
 *
 * @param value - The Jetson base URL.
 * @param fallbackOrigin - The origin to use when `value` is empty.
 * @returns The normalized base URL with `/api/health` appended.
 */
export function jetsonHealthUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/health`;
}

/**
 * Builds the top-level browser route used to confirm the Jetson TLS certificate.
 *
 * The route returns to the configured Wardy UI after the browser has accepted
 * the Jetson certificate, so mobile users do not need to type API URLs.
 */
export function jetsonBrowserBootstrapUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/connect`;
}

export class JetsonConnection {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onStatus: JetsonStatusHandler | undefined;

  constructor({ fetchImpl = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args), timeoutMs = 3500, onStatus }: JetsonConnectionOptions = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onStatus = onStatus;
  }

  async check(baseUrl: string, fallbackOrigin = globalThis.location?.origin ?? ""): Promise<JetsonHealthResult> {
    const endpoint = jetsonHealthUrl(baseUrl, fallbackOrigin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.onStatus?.("connecting", { endpoint });
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Jetson 서비스가 HTTP ${response.status}로 응답했습니다.`);
      const contentType = response.headers?.get?.("content-type") ?? "";
      const rawBody: unknown = contentType.includes("application/json") ? await response.json() : {};
      const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
      const service = typeof body.service === "string" ? body.service : "wardy-edge";
      const version = typeof body.version === "string" ? body.version : null;
      const result: JetsonHealthResult = { endpoint, service, version };
      this.onStatus?.("connected", result);
      return result;
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError" ? "Jetson 연결 확인 시간이 초과되었습니다." : errorMessage(error);
      this.onStatus?.("fault", { endpoint, message });
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }
}
