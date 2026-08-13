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

POSTURE_LABELS = frozenset(("standing", "sitting", "lying", "unknown"))


def _joint_angle(first: np.ndarray, vertex: np.ndarray, last: np.ndarray) -> float:
    """Return the 2-D angle at ``vertex`` in degrees."""
    first_vector = first - vertex
    last_vector = last - vertex
    denominator = float(np.linalg.norm(first_vector) * np.linalg.norm(last_vector))
    if denominator < 1e-6:
        return float("nan")
    cosine = float(np.dot(first_vector, last_vector) / denominator)
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def classify_posture(keypoints_xyc: np.ndarray, minimum_confidence: float = 0.3) -> str:
    """Derive a coarse posture label from visible COCO-17 body geometry.

    RTMPose supplies landmarks, not posture classes.  Use torso orientation to
    identify lying poses and knee geometry for the standing/sitting split.  A
    knee-height fallback is retained for crops where ankles are occluded.
    """
    keypoints = np.asarray(keypoints_xyc, dtype=np.float32)
    if keypoints.shape != (17, 3):
        raise ValueError("keypoints_xyc must be a COCO-17 [17,3] array")

    required = keypoints[[5, 6, 11, 12]]
    if np.any(required[:, 2] < minimum_confidence):
        return "unknown"

    shoulder = required[:2, :2].mean(axis=0)
    hip = required[2:, :2].mean(axis=0)
    torso = hip - shoulder
    torso_length = float(np.linalg.norm(torso))
    if torso_length < 1.0:
        return "unknown"
    # A near-horizontal shoulder-to-hip axis is a lying pose.  The previous
    # 0.85 ratio treated many oblique, seated poses as lying; require a more
    # decisive tilt instead.
    if abs(float(torso[0])) > abs(float(torso[1])) * 1.2:
        return "lying"

    knees = keypoints[[13, 14]]
    visible_knees = knees[knees[:, 2] >= minimum_confidence]
    if visible_knees.size == 0:
        return "unknown"

    # Knee flexion is much less sensitive to camera distance than a raw
    # hip-to-knee pixel threshold.  Bent knees are a sitting cue; extended
    # knees are a standing cue.  Use whichever complete leg is visible.
    knee_angles = []
    for hip_index, knee_index, ankle_index in ((11, 13, 15), (12, 14, 16)):
        if min(keypoints[hip_index, 2], keypoints[knee_index, 2],
               keypoints[ankle_index, 2]) < minimum_confidence:
            continue
        angle = _joint_angle(
            keypoints[hip_index, :2],
            keypoints[knee_index, :2],
            keypoints[ankle_index, :2],
        )
        if np.isfinite(angle):
            knee_angles.append(angle)
    if knee_angles:
        mean_knee_angle = float(np.mean(knee_angles))
        if mean_knee_angle < 145.0:
            return "sitting"
        if mean_knee_angle >= 155.0:
            return "standing"

    # Occluded ankles or an ambiguous knee angle: use a conservative fallback.
    # Standing legs normally extend to at least half a torso below the hips;
    # the old 0.65 cutoff was too eager to label short/partial standing crops
    # as sitting.
    knee = visible_knees[:, :2].mean(axis=0)
    hip_to_knee = knee - hip
    if float(hip_to_knee[1]) < torso_length * 0.50:
        return "sitting"
    return "standing"


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
    posture: str

    def __post_init__(self) -> None:
        keypoints = np.asarray(self.keypoints_xyc, dtype=np.float32)
        if keypoints.shape != (17, 3) or not np.isfinite(keypoints).all():
            raise ValueError("keypoints_xyc must be a finite COCO-17 [17,3] array")
        if np.any((keypoints[:, 2] < 0.0) | (keypoints[:, 2] > 1.0)):
            raise ValueError("keypoint confidence must be between 0 and 1")
        if self.posture not in POSTURE_LABELS:
            raise ValueError("posture must be standing, sitting, lying, or unknown")
        object.__setattr__(self, "keypoints_xyc", keypoints)

    def to_dict(self) -> dict[str, Any]:
        return {
            "frame_id": self.frame_id,
            "timestamp_ms": self.timestamp_ms,
            "track_id": self.track_id,
            "bbox_xyxy": self.bbox_xyxy.tolist(),
            "keypoints_xyc": self.keypoints_xyc.tolist(),
            "pose_quality": self.pose_quality,
            "posture": self.posture,
            "keypoint_format": "COCO-17",
        }
