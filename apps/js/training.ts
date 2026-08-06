import { normalizeJetsonBaseUrl } from "./jetson.ts";
import type { ManagedItem, Subject, TrainingSampleResult } from "./types.ts";

export function trainingSampleUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/training/items/sample`;
}

export function subjectReferenceUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/training/subjects/reference`;
}

export class TrainingSampleClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) {
    this.fetchImpl = fetchImpl;
  }

  async capture(item: ManagedItem, baseUrl: string,
                accessToken: string,
                fallbackOrigin = globalThis.location?.origin ?? ""): Promise<TrainingSampleResult> {
    const endpoint = trainingSampleUrl(baseUrl, fallbackOrigin);
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Wardy-Item-Id": item.id,
        "X-Wardy-Item-Label": encodeURIComponent(item.label),
        "X-Wardy-Item-Policy": item.policy,
        "X-Wardy-Access-Token": accessToken,
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

  async captureSubject(subject: Subject, baseUrl: string,
                       accessToken: string,
                       fallbackOrigin = globalThis.location?.origin ?? ""): Promise<TrainingSampleResult> {
    const response = await this.fetchImpl(subjectReferenceUrl(baseUrl, fallbackOrigin), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Wardy-Subject-Id": subject.id,
        "X-Wardy-Subject-Name": encodeURIComponent(subject.name),
        "X-Wardy-Subject-Role": encodeURIComponent(subject.role),
        "X-Wardy-Access-Token": accessToken,
      },
      cache: "no-store",
    });
    const rawBody: unknown = await response.json().catch(() => ({}));
    const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
    if (!response.ok) {
      const message = typeof body.error === "string" ? body.error : `식별 기준 사진 저장에 실패했습니다. HTTP ${response.status}`;
      throw new Error(message);
    }
    if (typeof body.sample_id !== "string" || typeof body.image_path !== "string" ||
        typeof body.sample_count !== "number") {
      throw new Error("Jetson이 올바르지 않은 식별 기준 사진 정보를 반환했습니다.");
    }
    return { sampleId: body.sample_id, imagePath: body.image_path, sampleCount: body.sample_count };
  }
}
