from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


COCO_KEYPOINT_NAMES = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)


@dataclass(frozen=True)
class PersonInput:
    frame_id: str
    timestamp_ms: int
    track_id: int
    bbox_xyxy: np.ndarray

    def __post_init__(self) -> None:
        bbox = np.asarray(self.bbox_xyxy, dtype=np.float32)
        if (
            bbox.shape != (4,)
            or not np.isfinite(bbox).all()
            or bbox[2] <= bbox[0]
            or bbox[3] <= bbox[1]
        ):
            raise ValueError("bbox_xyxy must contain finite x1,y1,x2,y2 coordinates")
        object.__setattr__(self, "bbox_xyxy", bbox)


@dataclass(frozen=True)
class PoseResult:
    frame_id: str
    timestamp_ms: int
    track_id: int
    bbox_xyxy: np.ndarray
    keypoints_xyc: np.ndarray
    pose_quality: float

    def __post_init__(self) -> None:
        keypoints = np.asarray(self.keypoints_xyc, dtype=np.float32)
        if keypoints.shape != (17, 3) or not np.isfinite(keypoints).all():
            raise ValueError("keypoints_xyc must be a finite COCO-17 [17,3] array")
        if np.any((keypoints[:, 2] < 0.0) | (keypoints[:, 2] > 1.0)):
            raise ValueError("keypoint confidence must be between 0 and 1")
        object.__setattr__(self, "keypoints_xyc", keypoints)

    def to_dict(self) -> dict[str, Any]:
        return {
            "frame_id": self.frame_id,
            "timestamp_ms": self.timestamp_ms,
            "track_id": self.track_id,
            "bbox_xyxy": self.bbox_xyxy.tolist(),
            "keypoints_xyc": self.keypoints_xyc.tolist(),
            "pose_quality": self.pose_quality,
            "keypoint_format": "COCO-17",
        }
