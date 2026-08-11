export type CareStatus = "normal" | "caution" | "warning" | "emergency";
export type EventStatus = "new" | "confirmed" | "released" | "false_detection";
export type EventType =
  | "fall_suspected"
  | "inactivity"
  | "hazard_detected"
  | "hazard_proximity"
  | "zone_entry"
  | "zone_dwell"
  | "camera_fault"
  | "detection_fault";
export type MediaType = "none" | "image" | "video";
export type OverlaySettingKey = "showClass" | "showRole" | "showName" | "showPosture";
export type NotificationSetting = "off" | "on";
export type ManagedItemPolicy = "included" | "excluded";
export type CameraStatus = "idle" | "connecting" | "connected" | "fault";
export type JetsonStatus = CameraStatus;

export interface SourceResult {
  source: string;
  note: string;
}

export interface WardyEvent {
  event_id: string;
  event_type: EventType;
  occurred_at: string;
  first_seen_at: string;
  last_seen_at: string;
  subject_id: string | null;
  subject_name: string | null;
  subject_location: string | null;
  object_id: string | null;
  object_class: string | null;
  zone_id: string | null;
  care_status: CareStatus | null;
  event_status: EventStatus;
  confirmed_at: string | null;
  released_at: string | null;
  false_detection_at: string | null;
  reason: string;
  source_results: SourceResult[];
  media_type: MediaType;
  media_path: string | null;
  media_started_at: string | null;
  media_ended_at: string | null;
}

export interface OverlaySettings extends Record<OverlaySettingKey, boolean> {}
export type NotificationSettings = Partial<Record<EventType, NotificationSetting>>;

export interface CareState {
  status: CareStatus | null;
  reason: string;
  updatedAt: string;
  source: "manual_ui" | "jetson_runtime";
}

export interface SystemState {
  care_state: CareStatus | null;
  camera_state: CameraStatus;
  detection_state: "disconnected" | "ready" | "running" | "fault";
  event_state: "ready" | "processing" | "fault";
  reason: string;
  updated_at: string;
}

export interface ManagedItem {
  id: string;
  label: string;
  policy: ManagedItemPolicy;
  sampleCount?: number;
}

export interface TrainingSampleResult {
  sampleId: string;
  imagePath: string;
  sampleCount: number;
}

export type IdentityReviewDecision = "pending" | "subject" | "unknown" | "excluded";
export type DatasetReviewStatus = "pending" | "approved" | "rejected";
export type DatasetSampleSource = "jetson_camera" | "local_file";

export interface IdentityReview {
  id: string;
  imagePath: string;
  capturedAt: string;
  predictedName: string | null;
  confidence: number | null;
  decision: IdentityReviewDecision;
  subjectId: string | null;
}

export interface DatasetSample {
  id: string;
  modelId: string;
  requirementId: string;
  label: string;
  reviewStatus: DatasetReviewStatus;
  captureSession: string;
  source: DatasetSampleSource;
  imagePath: string;
  originalFilename: string | null;
  capturedAt: string;
  width: number;
  height: number;
}

export interface DatasetSampleMetadata {
  modelId: string;
  requirementId: string;
  label: string;
  captureSession: string;
}

export interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
}

export interface Zone extends ZoneRect {
  id: string;
}

export interface Subject {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  referenceSampleCount?: number;
}

export interface WardyState {
  version: 1;
  careState: CareState;
  events: WardyEvent[];
  settings: {
    overlay: OverlaySettings;
    notifications: NotificationSettings;
    camera: { mirrored: boolean };
    jetson: { baseUrl: string };
    dataWorkspace: { captureSession: string; datasetVersion: string };
  };
  managedItems: ManagedItem[];
  zones: Zone[];
  subjects: Subject[];
  identityReviews: IdentityReview[];
  datasetSamples: DatasetSample[];
}

export interface Detection {
  id: string;
  box: readonly [number, number, number, number];
  className: string;
  role: string;
  name: string;
  posture: string;
  color: string;
}

export interface EventFilters {
  query?: string;
  eventStatus?: EventStatus | "all";
  careStatus?: CareStatus | "all";
}

export interface EventSummary extends Record<CareStatus, number> {
  total: number;
  unconfirmed: number;
}

export interface JetsonStatusDetail {
  endpoint?: string;
  service?: string;
  version?: string | null;
  message?: string;
}

export interface JetsonHealthResult {
  endpoint: string;
  service: string;
  version: string | null;
}
