import type { CameraStatus } from "./types.ts";

import { normalizeJetsonBaseUrl } from "./jetson.ts";

export function jetsonCameraStreamUrl(value: string, fallbackOrigin = ""): string {
  return `${normalizeJetsonBaseUrl(value, fallbackOrigin)}/api/camera/stream`;
}

export class JetsonCameraController {
  private readonly image: HTMLImageElement;
  private readonly onStatusChange: ((status: CameraStatus) => void) | undefined;

  constructor(image: HTMLImageElement, onStatusChange?: (status: CameraStatus) => void) {
    this.image = image;
    this.onStatusChange = onStatusChange;
  }

  start(baseUrl: string, fallbackOrigin = globalThis.location?.origin ?? ""): string {
    const endpoint = jetsonCameraStreamUrl(baseUrl, fallbackOrigin);
    this.stop();
    this.onStatusChange?.("connecting");

    this.image.onload = () => {
      this.onStatusChange?.("connected");
    };
    this.image.onerror = () => {
      this.onStatusChange?.("fault");
    };
    this.image.src = endpoint;
    return endpoint;
  }

  stop(status: CameraStatus = "idle"): void {
    this.image.onload = null;
    this.image.onerror = null;
    this.image.removeAttribute("src");
    this.onStatusChange?.(status);
  }
}
