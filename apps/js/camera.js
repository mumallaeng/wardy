export class CameraController {
  constructor(video, onStatusChange) {
    this.video = video;
    this.onStatusChange = onStatusChange;
    this.stream = null;
  }

  async start() {
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
      this.onStatusChange?.("fault");
      throw error;
    }
  }

  stop(status = "idle") {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.onStatusChange?.(status);
  }
}
