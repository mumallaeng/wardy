export function normalizeJetsonBaseUrl(value, fallbackOrigin = "") {
  const candidate = String(value ?? "").trim() || String(fallbackOrigin ?? "").trim();
  if (!candidate) throw new Error("Jetson 서비스 주소를 입력해 주세요.");
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Jetson 주소는 http 또는 https 형식이어야 합니다.");
  if (url.username || url.password) throw new Error("주소에 계정 정보를 포함할 수 없습니다.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function jetsonHealthUrl(value, fallbackOrigin = "") {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/health`;
}

export class JetsonConnection {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 3500, onStatus } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onStatus = onStatus;
  }

  async check(baseUrl, fallbackOrigin = globalThis.location?.origin ?? "") {
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
      const body = contentType.includes("application/json") ? await response.json() : {};
      const result = { endpoint, service: body.service ?? "wardy-edge", version: body.version ?? null };
      this.onStatus?.("connected", result);
      return result;
    } catch (error) {
      const message = error.name === "AbortError" ? "Jetson 연결 확인 시간이 초과되었습니다." : error.message;
      this.onStatus?.("fault", { endpoint, message });
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }
}
