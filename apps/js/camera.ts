import type { CameraStatus } from "./types.ts";

export class CameraController {
  private readonly video: HTMLVideoElement;
  private readonly onStatusChange: ((status: CameraStatus) => void) | undefined;
  private stream: MediaStream | null = null;

  constructor(video: HTMLVideoElement, onStatusChange?: (status: CameraStatus) => void) {
    this.video = video;
    this.onStatusChange = onStatusChange;
    this.stream = null;
  }

  async start(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 카메라 입력을 지원하지 않습니다.");
    this.onStatusChange?.("connecting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => this.stop("fault"), { once: true }));
      this.onStatusChange?.("connected");
      return this.stream;
    } catch (error) {
      this.stop("fault");
      throw error;
    }
  }

  stop(status: CameraStatus = "idle"): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.onStatusChange?.(status);
  }
}
