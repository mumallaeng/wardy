import { normalizeJetsonBaseUrl } from "./jetson.ts";
import type {
  DatasetReviewStatus,
  DatasetSample,
  DatasetSampleMetadata,
  ManagedItem,
  Subject,
  TrainingSampleResult,
} from "./types.ts";

const DATASET_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;
const DATASET_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function trainingSampleUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/training/items/sample`;
}

export function subjectReferenceUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/training/subjects/reference`;
}

export function datasetSamplesUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/data-samples`;
}

function requireSecureEndpoint(endpoint: string): string {
  if (new URL(endpoint).protocol !== "https:") {
    throw new Error("인증된 Jetson 요청에는 https가 필요합니다.");
  }
  return endpoint;
}

function datasetHeaders(metadata: DatasetSampleMetadata, accessToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Wardy-Model-Id": metadata.modelId,
    "X-Wardy-Requirement-Id": metadata.requirementId,
    "X-Wardy-Label": encodeURIComponent(metadata.label),
    "X-Wardy-Capture-Session": encodeURIComponent(metadata.captureSession),
    "X-Wardy-Access-Token": accessToken,
  };
}

function isDatasetSample(value: unknown): value is DatasetSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return typeof sample.id === "string" && typeof sample.modelId === "string"
    && typeof sample.requirementId === "string" && typeof sample.label === "string"
    && ["pending", "approved", "rejected"].includes(String(sample.reviewStatus))
    && typeof sample.captureSession === "string"
    && ["jetson_camera", "local_file"].includes(String(sample.source))
    && typeof sample.imagePath === "string"
    && (sample.originalFilename === null || typeof sample.originalFilename === "string")
    && typeof sample.capturedAt === "string"
    && typeof sample.width === "number" && typeof sample.height === "number";
}

async function readDatasetResponse(response: Response): Promise<Record<string, unknown>> {
  const rawBody: unknown = await response.json().catch(() => ({}));
  const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error : `데이터 sample 요청에 실패했습니다. HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function datasetSampleList(body: Record<string, unknown>): DatasetSample[] {
  if (!Array.isArray(body.samples) || !body.samples.every(isDatasetSample)) {
    throw new Error("Jetson이 올바르지 않은 데이터 sample 목록을 반환했습니다.");
  }
  return body.samples;
}

export class TrainingSampleClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) {
    this.fetchImpl = fetchImpl;
  }

  async capture(item: ManagedItem, baseUrl: string,
                accessToken: string,
                fallbackOrigin = globalThis.location?.origin ?? ""): Promise<TrainingSampleResult> {
    const endpoint = requireSecureEndpoint(trainingSampleUrl(baseUrl, fallbackOrigin));
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
    const endpoint = requireSecureEndpoint(subjectReferenceUrl(baseUrl, fallbackOrigin));
    const response = await this.fetchImpl(endpoint, {
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

  async listDatasetSamples(baseUrl: string, accessToken: string,
                           fallbackOrigin = globalThis.location?.origin ?? ""): Promise<DatasetSample[]> {
    const endpoint = requireSecureEndpoint(datasetSamplesUrl(baseUrl, fallbackOrigin));
    const response = await this.fetchImpl(endpoint, {
      headers: { Accept: "application/json", "X-Wardy-Access-Token": accessToken },
      cache: "no-store",
    });
    const body = await readDatasetResponse(response);
    return datasetSampleList(body);
  }

  async captureDatasetSample(metadata: DatasetSampleMetadata, baseUrl: string,
                             accessToken: string,
                             fallbackOrigin = globalThis.location?.origin ?? ""): Promise<DatasetSample[]> {
    const endpoint = requireSecureEndpoint(`${datasetSamplesUrl(baseUrl, fallbackOrigin)}/camera`);
    const response = await this.fetchImpl(endpoint, {
      method: "POST", headers: datasetHeaders(metadata, accessToken), cache: "no-store",
    });
    const body = await readDatasetResponse(response);
    return datasetSampleList(body);
  }

  async uploadDatasetSample(file: File, metadata: DatasetSampleMetadata, baseUrl: string,
                            accessToken: string,
                            fallbackOrigin = globalThis.location?.origin ?? ""): Promise<DatasetSample[]> {
    if (!DATASET_IMAGE_TYPES.has(file.type)) throw new Error(`지원하지 않는 이미지 형식입니다: ${file.type || file.name}`);
    if (file.size > DATASET_UPLOAD_LIMIT_BYTES) throw new Error(`이미지는 8 MiB 이하여야 합니다: ${file.name}`);
    const endpoint = requireSecureEndpoint(`${datasetSamplesUrl(baseUrl, fallbackOrigin)}/upload`);
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        ...datasetHeaders(metadata, accessToken),
        "Content-Type": file.type,
        "X-Wardy-Original-Filename": encodeURIComponent(file.name),
      },
      body: file,
      cache: "no-store",
    });
    const body = await readDatasetResponse(response);
    return datasetSampleList(body);
  }

  async updateDatasetSample(sampleId: string, label: string, reviewStatus: DatasetReviewStatus,
                            baseUrl: string, accessToken: string,
                            fallbackOrigin = globalThis.location?.origin ?? ""): Promise<DatasetSample[]> {
    const endpoint = requireSecureEndpoint(`${datasetSamplesUrl(baseUrl, fallbackOrigin)}/${encodeURIComponent(sampleId)}`);
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Wardy-Label": encodeURIComponent(label),
        "X-Wardy-Review-Status": reviewStatus,
        "X-Wardy-Access-Token": accessToken,
      },
      cache: "no-store",
    });
    const body = await readDatasetResponse(response);
    return datasetSampleList(body);
  }

  async deleteDatasetSample(sampleId: string, baseUrl: string, accessToken: string,
                            fallbackOrigin = globalThis.location?.origin ?? ""): Promise<DatasetSample[]> {
    const endpoint = requireSecureEndpoint(`${datasetSamplesUrl(baseUrl, fallbackOrigin)}/${encodeURIComponent(sampleId)}`);
    const response = await this.fetchImpl(endpoint, {
      method: "DELETE",
      headers: { Accept: "application/json", "X-Wardy-Access-Token": accessToken },
      cache: "no-store",
    });
    return datasetSampleList(await readDatasetResponse(response));
  }
}
