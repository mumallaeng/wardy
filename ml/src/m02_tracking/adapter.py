"""M-01 detection to M-02 track to M-03 pose-input adapter."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

import numpy as np

from .tracker import Detection, GeometricMultiObjectTracker


class M02TrackingAdapter:
    """Connect person detections to anonymous, M-03-ready tracked persons.

    Call ``process_frame`` once for every camera frame, including frames with no
    detections. Call ``reset`` whenever the camera stream reconnects or changes.
    """

    def __init__(self, tracker: GeometricMultiObjectTracker | None = None) -> None:
        self.tracker = tracker or GeometricMultiObjectTracker()

    def reset(self) -> None:
        self.tracker.reset()

    def process_frame(
        self,
        *,
        frame_id: str,
        timestamp_ms: int,
        frame_width: int,
        frame_height: int,
        person_detections: Iterable[Mapping[str, Any]],
    ) -> dict[str, Any]:
        if not isinstance(frame_id, str) or not frame_id:
            raise ValueError("frame_id must be a non-empty string")
        if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, int):
            raise TypeError("timestamp_ms must be an integer")
        if timestamp_ms < 0:
            raise ValueError("timestamp_ms must be non-negative")
        if frame_width <= 0 or frame_height <= 0:
            raise ValueError("frame dimensions must be positive")

        detections = [
            self._person_detection_from_mapping(
                raw_detection,
                frame_width=frame_width,
                frame_height=frame_height,
            )
            for raw_detection in person_detections
        ]
        tracks = self.tracker.update(detections)

        # Each item is the direct bbox input contract expected by M-03 RTMPose.
        pose_inputs = [
            {
                "frame_id": frame_id,
                "timestamp_ms": timestamp_ms,
                "frame_width": frame_width,
                "frame_height": frame_height,
                "track_id": track.track_id,
                "bbox_xyxy": list(track.bbox_xyxy),
                "detection_confidence": track.confidence,
                "track_age_frames": track.age_frames,
                "track_hits": track.hits,
            }
            for track in tracks
        ]
        return {
            "frame_id": frame_id,
            "timestamp_ms": timestamp_ms,
            "tracking_scope": "anonymous_short_term",
            "persons": pose_inputs,
        }

    @staticmethod
    def _person_detection_from_mapping(
        raw_detection: Mapping[str, Any], *, frame_width: int, frame_height: int
    ) -> Detection:
        if not isinstance(raw_detection, Mapping):
            raise TypeError("each person detection must be a mapping")
        if "bbox_xyxy" not in raw_detection or "confidence" not in raw_detection:
            raise ValueError("person detection requires bbox_xyxy and confidence")

        bbox = np.asarray(raw_detection["bbox_xyxy"], dtype=np.float32).copy()
        if bbox.shape != (4,) or not np.all(np.isfinite(bbox)):
            raise ValueError("bbox_xyxy must contain four finite values")
        bbox[[0, 2]] = np.clip(bbox[[0, 2]], 0.0, float(frame_width))
        bbox[[1, 3]] = np.clip(bbox[[1, 3]], 0.0, float(frame_height))
        return Detection(bbox_xyxy=bbox, confidence=raw_detection["confidence"])
