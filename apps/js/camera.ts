import type { CameraStatus } from "./types.ts";

import { normalizeJetsonBaseUrl } from "./jetson.ts";

export function jetsonWebRtcStreamUrl(value: string, fallbackOrigin = ""): string {
  const url = new URL(normalizeJetsonBaseUrl(value, fallbackOrigin));
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

export function jetsonWhepUrl(value: string, fallbackOrigin = ""): string {
  const url = new URL(normalizeJetsonBaseUrl(value, fallbackOrigin));
  url.pathname = "/wardy/whep";
  url.search = "";
  return url.toString();
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

export class JetsonCameraController {
  private readonly video: HTMLVideoElement;
  private readonly onStatusChange: ((status: CameraStatus) => void) | undefined;
  private peer: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;

  constructor(video: HTMLVideoElement, onStatusChange?: (status: CameraStatus) => void) {
    this.video = video;
    this.onStatusChange = onStatusChange;
  }

  async start(baseUrl: string,
              fallbackOrigin = globalThis.location?.origin ?? ""): Promise<string> {
    this.stop("connecting");
    const generation = this.generation;
    let endpoint: string;
    try {
      endpoint = jetsonWhepUrl(baseUrl, fallbackOrigin);
      if (new URL(endpoint).protocol !== "https:") {
        throw new Error("인증된 카메라 연결에는 https가 필요합니다.");
      }
    } catch (error) {
      this.stop("fault");
      throw error;
    }
    const peer = new RTCPeerConnection();
    this.peer = peer;
    const abortController = new AbortController();
    this.abortController = abortController;
    const timeout = globalThis.setTimeout(() => abortController.abort(), 5000);
    let peerReady = false;
    let videoPlaying = false;
    const fail = () => {
      globalThis.clearTimeout(readinessTimeout);
      if (generation === this.generation) this.stop("fault");
    };
    const readinessTimeout = globalThis.setTimeout(() => {
      fail();
    }, 8000);
    const updateReady = () => {
      if (generation === this.generation && peerReady && videoPlaying) {
        globalThis.clearTimeout(readinessTimeout);
        this.onStatusChange?.("connected");
      }
    };

    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addEventListener("track", (event) => {
      this.video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.video.play().catch(fail);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (generation !== this.generation) return;
      peerReady = peer.connectionState === "connected";
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        fail();
      } else {
        updateReady();
      }
    });
    this.video.onplaying = () => {
      videoPlaying = true;
      updateReady();
    };
    this.video.onerror = fail;

    try {
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIceGathering(peer);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: peer.localDescription?.sdp ?? "",
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`WebRTC 연결 요청이 HTTP ${response.status}로 실패했습니다.`);
      const location = response.headers.get("location");
      if (location) {
        const resource = new URL(location, endpoint);
        const publicEndpoint = new URL(endpoint);
        resource.protocol = publicEndpoint.protocol;
        resource.host = publicEndpoint.host;
        this.resourceUrl = resource.toString();
      } else {
        this.resourceUrl = null;
      }
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
      return endpoint;
    } catch (error) {
      globalThis.clearTimeout(readinessTimeout);
      if (generation === this.generation) this.stop("fault");
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  stop(status: CameraStatus = "idle"): void {
    this.generation += 1;
    const resourceUrl = this.resourceUrl;
    this.resourceUrl = null;
    if (resourceUrl) {
      void fetch(resourceUrl, {
        method: "DELETE",
        headers: { "If-Match": "*" },
      }).catch(() => undefined);
    }
    this.abortController?.abort();
    this.abortController = null;
    this.video.onplaying = null;
    this.video.onerror = null;
    this.video.pause();
    this.video.srcObject = null;
    this.peer?.close();
    this.peer = null;
    this.onStatusChange?.(status);
  }
}
