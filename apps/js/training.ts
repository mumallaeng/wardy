import { normalizeJetsonBaseUrl } from "./jetson.ts";
import type { ManagedItem, TrainingSampleResult } from "./types.ts";

export function trainingSampleUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/training/items/sample`;
}

export class TrainingSampleClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) {
    this.fetchImpl = fetchImpl;
  }

  async capture(item: ManagedItem, baseUrl: string,
                fallbackOrigin = globalThis.location?.origin ?? ""): Promise<TrainingSampleResult> {
    const endpoint = trainingSampleUrl(baseUrl, fallbackOrigin);
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Wardy-Item-Id": item.id,
        "X-Wardy-Item-Label": encodeURIComponent(item.label),
        "X-Wardy-Item-Policy": item.policy,
      },
      cache: "no-store",
    });
    const rawBody: unknown = await response.json().catch(() => ({}));
    const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
    if (!response.ok) {
      const message = typeof body.error === "string" ? body.error : `학습 사진 저장에 실패했습니다. HTTP ${response.status}`;
      throw new Error(message);
    }
    if (typeof body.sample_id !== "string" || typeof body.image_path !== "string" ||
        typeof body.sample_count !== "number") {
      throw new Error("Jetson이 올바르지 않은 학습 사진 정보를 반환했습니다.");
    }
    return {
      sampleId: body.sample_id,
      imagePath: body.image_path,
      sampleCount: body.sample_count,
    };
  }
}
