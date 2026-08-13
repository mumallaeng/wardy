import type { Detection, OverlaySettings, Zone, ZoneRect } from "./types.ts";

interface Point {
  x: number;
  y: number;
}

interface Drawing {
  start: Point;
  end: Point;
}

interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COCO_SKELETON: readonly (readonly [number, number])[] = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
];
const KEYPOINT_THRESHOLD = 0.3;

export class OverlayController {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly media: HTMLVideoElement | HTMLIFrameElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly onZoneCreated: (zone: ZoneRect) => void;
  private detections: readonly Detection[] = [];
  private zones: readonly Zone[] = [];
  private settings: OverlaySettings = { showClass: true, showRole: true, showName: true, showPosture: true, showFall: true };
  private mirrored = false;
  private drawing: Drawing | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, media: HTMLVideoElement | HTMLIFrameElement, onZoneCreated: (zone: ZoneRect) => void) {
    this.canvas = canvas;
    this.container = container;
    this.media = media;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas를 초기화할 수 없습니다.");
    this.context = context;
    this.onZoneCreated = onZoneCreated;
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(container);
    if (media instanceof HTMLVideoElement) {
      media.addEventListener("loadedmetadata", () => this.draw());
      media.addEventListener("resize", () => this.draw());
    } else {
      media.addEventListener("load", () => this.draw());
    }
    canvas.addEventListener("pointerdown", (event) => this.#pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.#pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.#pointerUp(event));
  }

  setDetections(detections: readonly Detection[]): void { this.detections = detections; this.draw(); }
  setZones(zones: readonly Zone[]): void { this.zones = zones; this.draw(); }
  setSettings(settings: OverlaySettings): void { this.settings = { ...settings }; this.draw(); }
  setMirrored(mirrored: boolean): void { this.mirrored = mirrored; this.draw(); }
  beginZoneDrawing(): void { this.container.classList.add("is-zone-drawing"); }

  #contentRect(): ContentRect {
    const canvasRect = this.canvas.getBoundingClientRect();
    const mediaRect = this.media.getBoundingClientRect();
    if (mediaRect.width <= 0 || mediaRect.height <= 0) {
      return { x: 0, y: 0, width: canvasRect.width, height: canvasRect.height };
    }
    if (!(this.media instanceof HTMLVideoElement) || this.media.videoWidth <= 0 || this.media.videoHeight <= 0) {
      return { x: mediaRect.left - canvasRect.left, y: mediaRect.top - canvasRect.top, width: mediaRect.width, height: mediaRect.height };
    }
    const scale = Math.min(mediaRect.width / this.media.videoWidth, mediaRect.height / this.media.videoHeight);
    const sourceWidth = this.media.videoWidth;
    const sourceHeight = this.media.videoHeight;
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    return {
      x: mediaRect.left - canvasRect.left + (mediaRect.width - width) / 2,
      y: mediaRect.top - canvasRect.top + (mediaRect.height - height) / 2,
      width,
      height,
    };
  }

  #point(event: PointerEvent): Point {
    const canvasRect = this.canvas.getBoundingClientRect();
    const content = this.#contentRect();
    const x = Math.min(1, Math.max(0, (event.clientX - canvasRect.left - content.x) / Math.max(1, content.width)));
    return {
      x: this.mirrored ? 1 - x : x,
      y: Math.min(1, Math.max(0, (event.clientY - canvasRect.top - content.y) / Math.max(1, content.height))),
    };
  }
  #pointerDown(event: PointerEvent): void {
    if (!this.container.classList.contains("is-zone-drawing")) return;
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.#point(event);
    this.drawing = { start: point, end: point };
    this.draw();
  }
  #pointerMove(event: PointerEvent): void { if (this.drawing) { this.drawing.end = this.#point(event); this.draw(); } }
  #pointerUp(event: PointerEvent): void {
    if (!this.drawing) return;
    this.drawing.end = this.#point(event);
    const { start, end } = this.drawing;
    const zone = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    this.drawing = null;
    this.container.classList.remove("is-zone-drawing");
    if (zone.width < .03 || zone.height < .03) { this.draw(); return; }
    const name = window.prompt("주의 구역 이름", `주의 구역 ${this.zones.length + 1}`)?.trim();
    if (name) this.onZoneCreated?.({ ...zone, name });
    this.draw();
  }

  draw(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.lineJoin = "round";
    const content = this.#contentRect();
    this.zones.forEach((zone) => this.#drawZone(zone, dpr, content));
    if (this.drawing) this.#drawZone({ x: Math.min(this.drawing.start.x, this.drawing.end.x), y: Math.min(this.drawing.start.y, this.drawing.end.y), width: Math.abs(this.drawing.end.x - this.drawing.start.x), height: Math.abs(this.drawing.end.y - this.drawing.start.y), name: "새 구역" }, dpr, content, true);
    this.detections.forEach((detection) => this.#drawDetection(detection, dpr, content));
  }

  #drawZone(zone: ZoneRect, dpr: number, content: ContentRect, draft = false): void {
    const normalizedX = this.mirrored ? 1 - zone.x - zone.width : zone.x;
    const x = (content.x + normalizedX * content.width) * dpr;
    const y = (content.y + zone.y * content.height) * dpr;
    const width = zone.width * content.width * dpr;
    const height = zone.height * content.height * dpr;
    this.context.save();
    this.context.strokeStyle = draft ? "#ffffff" : "#62b88f";
    this.context.fillStyle = draft ? "rgba(255,255,255,.08)" : "rgba(52,139,99,.13)";
    this.context.lineWidth = 2 * dpr;
    this.context.setLineDash([7 * dpr, 5 * dpr]);
    this.context.fillRect(x, y, width, height);
    this.context.strokeRect(x, y, width, height);
    this.context.setLineDash([]);
    this.context.font = `700 ${12 * dpr}px system-ui`;
    this.context.fillStyle = "#ffffff";
    this.context.fillText(zone.name, x + 6 * dpr, y + 16 * dpr);
    this.context.restore();
  }

  #drawDetection(detection: Detection, dpr: number, content: ContentRect): void {
    const [nx, ny, nw, nh] = detection.box;
    const normalizedX = this.mirrored ? 1 - nx - nw : nx;
    const x = (content.x + normalizedX * content.width) * dpr;
    const y = (content.y + ny * content.height) * dpr;
    const width = nw * content.width * dpr;
    const height = nh * content.height * dpr;
    const labels: string[] = [];
    this.context.save();
    this.context.strokeStyle = detection.color;
    this.context.lineWidth = 3 * dpr;
    if (this.settings.showClass) this.context.strokeRect(x, y, width, height);
    if (this.settings.showPosture) this.#drawSkeleton(detection, dpr, content);
    if (detection.fallDiagnostics) {
      const diagnostic = detection.fallDiagnostics;
      if (this.settings.showClass) {
        labels.push(`[M-01] ${detection.className || "person"} ${Math.round(diagnostic.detectorConfidence * 100)}%`);
      }
      if (this.settings.showRole || this.settings.showName) {
        const identity = [
          this.settings.showRole ? detection.role : "",
          this.settings.showName ? detection.name : "",
        ].filter(Boolean).join(" · ");
        labels.push(`[M-02] track #${diagnostic.trackId}${identity ? ` · ${identity}` : ""}`);
      }
      if (this.settings.showPosture) {
        const quality = diagnostic.poseQuality === null ? "--" : `${Math.round(diagnostic.poseQuality * 100)}%`;
        labels.push(`[M-03] ${detection.posture || "자세 확인 불가"} · ${quality}`);
      }
      if (this.settings.showFall) {
        labels.push(diagnostic.fallConfidence === null
          ? `[M-04] 분석 중 ${diagnostic.historyFrames}/${diagnostic.windowFrames}`
          : `[M-04] ${diagnostic.fallConfidence >= diagnostic.fallThreshold ? "낙상 의심" : "낙상 아님"} ${Math.round(diagnostic.fallConfidence * 100)}%`);
      }
    } else {
      if (this.settings.showClass && detection.className) labels.push(detection.className);
      if (this.settings.showRole && detection.role) labels.push(detection.role);
      if (this.settings.showName && detection.name) labels.push(detection.name);
      if (this.settings.showPosture && detection.posture) labels.push(detection.posture);
    }
    if (labels.length) {
      this.context.font = `700 ${13 * dpr}px system-ui`;
      const padding = 6 * dpr;
      const lineHeight = 18 * dpr;
      const textWidth = Math.max(...labels.map((label) => this.context.measureText(label).width));
      const labelHeight = labels.length * lineHeight + padding;
      const labelY = Math.max(0, y - labelHeight - 3 * dpr);
      this.context.fillStyle = detection.color;
      this.context.fillRect(x, labelY, textWidth + padding * 2, labelHeight);
      this.context.fillStyle = "#101813";
      labels.forEach((label, index) => {
        this.context.fillText(label, x + padding, labelY + (index + 1) * lineHeight);
      });
    }
    this.context.restore();
  }

  #drawSkeleton(detection: Detection, dpr: number, content: ContentRect): void {
    const keypoints = detection.fallDiagnostics?.keypoints;
    if (!keypoints || keypoints.length !== 17) return;
    const point = (index: number): Point => {
      const [normalizedX, normalizedY] = keypoints[index]!;
      return {
        x: (content.x + (this.mirrored ? 1 - normalizedX : normalizedX) * content.width) * dpr,
        y: (content.y + normalizedY * content.height) * dpr,
      };
    };
    this.context.strokeStyle = "rgba(255,255,255,.9)";
    this.context.lineWidth = 2 * dpr;
    for (const [start, end] of COCO_SKELETON) {
      if (keypoints[start]![2] < KEYPOINT_THRESHOLD || keypoints[end]![2] < KEYPOINT_THRESHOLD) continue;
      const first = point(start);
      const second = point(end);
      this.context.beginPath();
      this.context.moveTo(first.x, first.y);
      this.context.lineTo(second.x, second.y);
      this.context.stroke();
    }
    this.context.fillStyle = detection.color;
    keypoints.forEach((keypoint, index) => {
      if (keypoint[2] < KEYPOINT_THRESHOLD) return;
      const current = point(index);
      this.context.beginPath();
      this.context.arc(current.x, current.y, 3 * dpr, 0, Math.PI * 2);
      this.context.fill();
    });
  }
}
