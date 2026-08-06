import type { CameraStatus } from "./types.ts";

import { normalizeJetsonBaseUrl } from "./jetson.ts";

export function jetsonWebRtcStreamUrl(value: string, fallbackOrigin = ""): string {
  const url = new URL(normalizeJetsonBaseUrl(value, fallbackOrigin));
  url.port = "8889";
  url.pathname = "/wardy";
  url.search = new URLSearchParams({
    controls: "false",
    muted: "true",
    autoplay: "true",
    playsInline: "true",
    disablepictureinpicture: "true",
  }).toString();
  return url.toString();
}

export class JetsonCameraController {
  private readonly frame: HTMLIFrameElement;
  private readonly onStatusChange: ((status: CameraStatus) => void) | undefined;

  constructor(frame: HTMLIFrameElement, onStatusChange?: (status: CameraStatus) => void) {
    this.frame = frame;
    this.onStatusChange = onStatusChange;
  }

  start(baseUrl: string, fallbackOrigin = globalThis.location?.origin ?? ""): string {
    const endpoint = jetsonWebRtcStreamUrl(baseUrl, fallbackOrigin);
    this.stop();
    this.onStatusChange?.("connecting");

    this.frame.onload = () => {
      this.onStatusChange?.("connected");
    };
    this.frame.onerror = () => {
      this.onStatusChange?.("fault");
    };
    this.frame.src = endpoint;
    return endpoint;
  }

  stop(status: CameraStatus = "idle"): void {
    this.frame.onload = null;
    this.frame.onerror = null;
    this.frame.removeAttribute("src");
    this.onStatusChange?.(status);
  }
}
