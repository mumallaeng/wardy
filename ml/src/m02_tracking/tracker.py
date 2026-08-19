"""M02-A: Kalman prediction and geometric Hungarian association.

The tracker keeps anonymous IDs only for the lifetime of one camera stream. It
does not use faces, appearance embeddings, or persistent person identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np
from scipy.optimize import linear_sum_assignment


DEFAULT_MAX_AGE_FRAMES = 3
DEFAULT_MIN_HITS = 1
DEFAULT_COST_LIMIT = 0.85
MIN_IOU_GATE = 0.01
MAX_NORMALIZED_CENTER_DISTANCE = 1.25


def _validated_bbox(values: Sequence[float]) -> np.ndarray:
    bbox = np.asarray(values, dtype=np.float32)
    if bbox.shape != (4,):
        raise ValueError("bbox_xyxy must contain exactly four values")
    if not np.all(np.isfinite(bbox)):
        raise ValueError("bbox_xyxy must contain finite values")
    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
        raise ValueError("bbox_xyxy must have positive width and height")
    return bbox


@dataclass(frozen=True)
class Detection:
    """One current-frame person detection from M-01."""

    bbox_xyxy: Sequence[float]
    confidence: float

    def __post_init__(self) -> None:
        bbox = _validated_bbox(self.bbox_xyxy)
        confidence = float(self.confidence)
        if not np.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
            raise ValueError("confidence must be finite and between 0 and 1")
        object.__setattr__(self, "bbox_xyxy", tuple(float(value) for value in bbox))
        object.__setattr__(self, "confidence", confidence)


@dataclass(frozen=True)
class TrackedDetection:
    """A detection associated with an anonymous short-term track ID."""

    track_id: int
    bbox_xyxy: tuple[float, float, float, float]
    confidence: float
    age_frames: int
    hits: int


def bbox_iou(first: np.ndarray, second: np.ndarray) -> float:
    intersection_x1 = max(float(first[0]), float(second[0]))
    intersection_y1 = max(float(first[1]), float(second[1]))
    intersection_x2 = min(float(first[2]), float(second[2]))
    intersection_y2 = min(float(first[3]), float(second[3]))
    intersection_width = max(0.0, intersection_x2 - intersection_x1)
    intersection_height = max(0.0, intersection_y2 - intersection_y1)
    intersection = intersection_width * intersection_height

    first_area = max(1.0, float(first[2] - first[0])) * max(
        1.0, float(first[3] - first[1])
    )
    second_area = max(1.0, float(second[2] - second[0])) * max(
        1.0, float(second[3] - second[1])
    )
    union = max(first_area + second_area - intersection, 1e-6)
    return intersection / union


def bbox_center_size(bbox: np.ndarray) -> np.ndarray:
    width = max(1.0, float(bbox[2] - bbox[0]))
    height = max(1.0, float(bbox[3] - bbox[1]))
    return np.asarray(
        [
            (float(bbox[0]) + float(bbox[2])) / 2.0,
            (float(bbox[1]) + float(bbox[3])) / 2.0,
            width,
            height,
        ],
        dtype=np.float64,
    )


def normalized_center_distance(first: np.ndarray, second: np.ndarray) -> float:
    first_center = bbox_center_size(first)
    second_center = bbox_center_size(second)
    delta = first_center[:2] - second_center[:2]
    reference_diagonal = max(
        float(np.hypot(first_center[2], first_center[3])),
        1.0,
    )
    return float(np.linalg.norm(delta) / reference_diagonal)


class _KalmanBoxFilter:
    """Constant-velocity Kalman state for bbox center, size, and velocities."""

    def __init__(self, bbox: np.ndarray) -> None:
        self.state = np.zeros(8, dtype=np.float64)
        self.state[:4] = bbox_center_size(bbox)
        self.covariance = np.eye(8, dtype=np.float64) * 10.0
        self.transition = np.eye(8, dtype=np.float64)
        self.transition[:4, 4:] = np.eye(4, dtype=np.float64)
        self.observation = np.zeros((4, 8), dtype=np.float64)
        self.observation[:, :4] = np.eye(4, dtype=np.float64)
        self.process_noise = np.diag([1, 1, 1, 1, 4, 4, 2, 2]).astype(
            np.float64
        )
        self.measurement_noise = np.diag([4, 4, 6, 6]).astype(np.float64)

    def predict(self) -> np.ndarray:
        self.state = self.transition @ self.state
        self.covariance = (
            self.transition @ self.covariance @ self.transition.T
            + self.process_noise
        )
        return self.bbox()

    def update(self, bbox: np.ndarray) -> None:
        measurement = bbox_center_size(bbox)
        residual = measurement - self.observation @ self.state
        innovation = (
            self.observation @ self.covariance @ self.observation.T
            + self.measurement_noise
        )
        gain = self.covariance @ self.observation.T @ np.linalg.inv(innovation)
        self.state = self.state + gain @ residual
        identity = np.eye(8, dtype=np.float64)
        self.covariance = (identity - gain @ self.observation) @ self.covariance

    def bbox(self) -> np.ndarray:
        center_x, center_y, width, height = self.state[:4]
        width = max(1.0, width)
        height = max(1.0, height)
        return np.asarray(
            [
                center_x - width / 2.0,
                center_y - height / 2.0,
                center_x + width / 2.0,
                center_y + height / 2.0,
            ],
            dtype=np.float32,
        )


class _Track:
    def __init__(self, track_id: int, detection: Detection) -> None:
        bbox = np.asarray(detection.bbox_xyxy, dtype=np.float32)
        self.track_id = track_id
        self.filter = _KalmanBoxFilter(bbox)
        self.confidence = detection.confidence
        self.hits = 1
        self.age_frames = 1
        self.frames_since_update = 0
        self.predicted_bbox = bbox.copy()

    def predict(self) -> np.ndarray:
        self.predicted_bbox = self.filter.predict()
        self.age_frames += 1
        self.frames_since_update += 1
        return self.predicted_bbox

    def update(self, detection: Detection) -> None:
        self.filter.update(np.asarray(detection.bbox_xyxy, dtype=np.float32))
        self.predicted_bbox = self.filter.bbox()
        self.confidence = detection.confidence
        self.hits += 1
        self.frames_since_update = 0


class GeometricMultiObjectTracker:
    """Production M02-A tracker selected by the controlled A/B experiment."""

    def __init__(
        self,
        *,
        max_age_frames: int = DEFAULT_MAX_AGE_FRAMES,
        min_hits: int = DEFAULT_MIN_HITS,
        cost_limit: float = DEFAULT_COST_LIMIT,
    ) -> None:
        if max_age_frames < 0:
            raise ValueError("max_age_frames must be non-negative")
        if min_hits < 1:
            raise ValueError("min_hits must be at least 1")
        if not 0.0 <= cost_limit <= 1.0:
            raise ValueError("cost_limit must be between 0 and 1")
        self.max_age_frames = max_age_frames
        self.min_hits = min_hits
        self.cost_limit = cost_limit
        self._tracks: list[_Track] = []
        self._next_track_id = 1

    def reset(self) -> None:
        """Start a new anonymous ID namespace after stream reconnect or switch."""
        self._tracks.clear()
        self._next_track_id = 1

    def update(self, detections: Iterable[Detection]) -> list[TrackedDetection]:
        detections = list(detections)
        if not all(isinstance(detection, Detection) for detection in detections):
            raise TypeError("detections must contain Detection instances")

        predicted_boxes = [track.predict() for track in self._tracks]
        matched_detection_indices: set[int] = set()

        if predicted_boxes and detections:
            costs, valid_gate = self._association_costs(predicted_boxes, detections)
            gated_costs = np.where(valid_gate, costs, 1e6)
            track_indices, detection_indices = linear_sum_assignment(gated_costs)
            for track_index, detection_index in zip(
                track_indices.tolist(), detection_indices.tolist()
            ):
                if not valid_gate[track_index, detection_index]:
                    continue
                if costs[track_index, detection_index] > self.cost_limit:
                    continue
                self._tracks[track_index].update(detections[detection_index])
                matched_detection_indices.add(detection_index)

        # A current-frame detection without an acceptable match begins a new ID.
        for detection_index, detection in enumerate(detections):
            if detection_index not in matched_detection_indices:
                self._tracks.append(_Track(self._next_track_id, detection))
                self._next_track_id += 1

        self._tracks = [
            track
            for track in self._tracks
            if track.frames_since_update <= self.max_age_frames
        ]
        return [
            TrackedDetection(
                track_id=track.track_id,
                bbox_xyxy=tuple(float(value) for value in track.filter.bbox()),
                confidence=track.confidence,
                age_frames=track.age_frames,
                hits=track.hits,
            )
            for track in self._tracks
            if track.frames_since_update == 0 and track.hits >= self.min_hits
        ]

    @staticmethod
    def _association_costs(
        predicted_boxes: list[np.ndarray], detections: list[Detection]
    ) -> tuple[np.ndarray, np.ndarray]:
        costs = np.empty((len(predicted_boxes), len(detections)), dtype=np.float32)
        valid_gate = np.empty_like(costs, dtype=bool)
        for track_index, predicted_bbox in enumerate(predicted_boxes):
            for detection_index, detection in enumerate(detections):
                detection_bbox = np.asarray(detection.bbox_xyxy, dtype=np.float32)
                iou = bbox_iou(predicted_bbox, detection_bbox)
                center_distance = normalized_center_distance(
                    predicted_bbox, detection_bbox
                )
                valid_gate[track_index, detection_index] = (
                    iou >= MIN_IOU_GATE
                    or center_distance <= MAX_NORMALIZED_CENTER_DISTANCE
                )
                costs[track_index, detection_index] = (
                    0.65 * (1.0 - iou)
                    + 0.35
                    * min(center_distance / MAX_NORMALIZED_CENTER_DISTANCE, 1.0)
                )
        return costs, valid_gate
