import type { Detection, OverlaySettings, Zone, ZoneRect } from "./types.ts";

interface Point {
  x: number;
  y: number;
}

interface Drawing {
  start: Point;
  end: Point;
}

export class OverlayController {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly onZoneCreated: (zone: ZoneRect) => void;
  private detections: readonly Detection[] = [];
  private zones: readonly Zone[] = [];
  private settings: OverlaySettings = { showClass: true, showRole: true, showName: true, showPosture: true };
  private drawing: Drawing | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, onZoneCreated: (zone: ZoneRect) => void) {
    this.canvas = canvas;
    this.container = container;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas를 초기화할 수 없습니다.");
    this.context = context;
    this.onZoneCreated = onZoneCreated;
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(container);
    canvas.addEventListener("pointerdown", (event) => this.#pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.#pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.#pointerUp(event));
  }

  setDetections(detections: readonly Detection[]): void { this.detections = detections; this.draw(); }
  setZones(zones: readonly Zone[]): void { this.zones = zones; this.draw(); }
  setSettings(settings: OverlaySettings): void { this.settings = { ...settings }; this.draw(); }
  beginZoneDrawing(): void { this.container.classList.add("is-zone-drawing"); }

  #point(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
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
    this.zones.forEach((zone) => this.#drawZone(zone, dpr));
    if (this.drawing) this.#drawZone({ x: Math.min(this.drawing.start.x, this.drawing.end.x), y: Math.min(this.drawing.start.y, this.drawing.end.y), width: Math.abs(this.drawing.end.x - this.drawing.start.x), height: Math.abs(this.drawing.end.y - this.drawing.start.y), name: "새 구역" }, dpr, true);
    this.detections.forEach((detection) => this.#drawDetection(detection, dpr));
  }

  #drawZone(zone: ZoneRect, dpr: number, draft = false): void {
    const x = zone.x * this.canvas.width, y = zone.y * this.canvas.height, width = zone.width * this.canvas.width, height = zone.height * this.canvas.height;
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

  #drawDetection(detection: Detection, dpr: number): void {
    const [nx, ny, nw, nh] = detection.box;
    const x = nx * this.canvas.width, y = ny * this.canvas.height, width = nw * this.canvas.width, height = nh * this.canvas.height;
    const labels = [];
    if (this.settings.showClass && detection.className) labels.push(detection.className);
    if (this.settings.showRole && detection.role) labels.push(detection.role);
    if (this.settings.showName && detection.name) labels.push(detection.name);
    if (this.settings.showPosture && detection.posture) labels.push(detection.posture);
    this.context.save();
    this.context.strokeStyle = detection.color;
    this.context.lineWidth = 3 * dpr;
    this.context.strokeRect(x, y, width, height);
    if (labels.length) {
      const text = labels.join(" · ");
      this.context.font = `700 ${13 * dpr}px system-ui`;
      const padding = 6 * dpr;
      const textWidth = this.context.measureText(text).width;
      const labelY = Math.max(0, y - 27 * dpr);
      this.context.fillStyle = detection.color;
      this.context.fillRect(x, labelY, textWidth + padding * 2, 24 * dpr);
      this.context.fillStyle = "#101813";
      this.context.fillText(text, x + padding, labelY + 17 * dpr);
    }
    this.context.restore();
  }
}
