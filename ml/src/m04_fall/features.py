from __future__ import annotations

import numpy as np

from m03_pose.contract import COCO_KEYPOINT_NAMES, PoseResult


KEYPOINT_CONFIDENCE_THRESHOLD = 0.30
DERIVED_FEATURE_NAMES = (
    "torso_tilt",
    "shoulder_y",
    "hip_y",
    "hip_vertical_velocity",
    "hip_vertical_acceleration",
    "bbox_aspect",
    "bbox_height_ratio",
    "bbox_height_velocity",
    "visible_ratio",
    "body_center_y",
    "low_posture_score",
    "joint_motion",
)
FEATURE_NAMES = tuple(
    [f"{name}_{axis}" for name in COCO_KEYPOINT_NAMES for axis in ("x", "y")]
    + [f"{name}_confidence" for name in COCO_KEYPOINT_NAMES]
    + [f"{name}_visible" for name in COCO_KEYPOINT_NAMES]
    + list(DERIVED_FEATURE_NAMES)
)


def _visible_pair_center(
    normalized_xy: np.ndarray,
    joint_mask: np.ndarray,
    left: int,
    right: int,
) -> tuple[np.ndarray, np.ndarray]:
    pair_mask = joint_mask[:, [left, right]]
    weights = pair_mask / np.maximum(pair_mask.sum(axis=1, keepdims=True), 1.0)
    center = (normalized_xy[:, [left, right]] * weights[:, :, None]).sum(axis=1)
    return center, pair_mask.sum(axis=1) > 0


def _interpolate(values: np.ndarray, valid: np.ndarray) -> np.ndarray:
    valid_indices = np.flatnonzero(valid)
    if len(valid_indices) == 0:
        return np.zeros_like(values, dtype=np.float32)
    return np.interp(
        np.arange(len(values)), valid_indices, values[valid_indices]
    ).astype(np.float32)


def pose_results_to_features(results: list[PoseResult]) -> np.ndarray:
    if len(results) < 2:
        raise ValueError("at least two pose results are required")
    timestamps_ms = np.asarray(
        [result.timestamp_ms for result in results], dtype=np.int64
    )
    if np.any(np.diff(timestamps_ms) <= 0):
        raise ValueError("pose timestamps must increase")
    keypoints = np.stack([result.keypoints_xyc for result in results]).astype(
        np.float32
    )
    bboxes = np.stack([result.bbox_xyxy for result in results]).astype(np.float32)
    bbox_widths = np.maximum(bboxes[:, 2] - bboxes[:, 0], 1.0)
    bbox_heights = np.maximum(bboxes[:, 3] - bboxes[:, 1], 1.0)
    bbox_centers = np.column_stack(
        ((bboxes[:, 0] + bboxes[:, 2]) * 0.5, (bboxes[:, 1] + bboxes[:, 3]) * 0.5)
    )

    confidence = np.clip(keypoints[:, :, 2], 0.0, 1.0).astype(np.float32)
    joint_mask = (confidence >= KEYPOINT_CONFIDENCE_THRESHOLD).astype(np.float32)
    normalized_xy = keypoints[:, :, :2].copy()
    normalized_xy[:, :, 0] = (
        normalized_xy[:, :, 0] - bbox_centers[:, None, 0]
    ) / bbox_widths[:, None]
    normalized_xy[:, :, 1] = (
        normalized_xy[:, :, 1] - bbox_centers[:, None, 1]
    ) / bbox_heights[:, None]
    normalized_xy = np.clip(normalized_xy, -2.0, 2.0) * joint_mask[:, :, None]

    shoulder, shoulder_valid = _visible_pair_center(normalized_xy, joint_mask, 5, 6)
    hip, hip_valid = _visible_pair_center(normalized_xy, joint_mask, 11, 12)
    shoulder_y = _interpolate(shoulder[:, 1], shoulder_valid)
    hip_y = _interpolate(hip[:, 1], hip_valid)
    torso_valid = shoulder_valid & hip_valid
    torso_dx = _interpolate(hip[:, 0] - shoulder[:, 0], torso_valid)
    torso_dy = _interpolate(hip[:, 1] - shoulder[:, 1], torso_valid)
    torso_tilt = np.arctan2(np.abs(torso_dx), np.maximum(np.abs(torso_dy), 1e-6)) / (
        np.pi / 2
    )

    timestamps_s = timestamps_ms.astype(np.float64) / 1000.0
    hip_velocity = np.clip(np.gradient(hip_y, timestamps_s), -8.0, 8.0)
    hip_acceleration = np.clip(np.gradient(hip_velocity, timestamps_s), -32.0, 32.0)
    bbox_height_ratio = bbox_heights / np.maximum(bbox_heights.max(), 1.0)
    bbox_height_velocity = np.clip(
        np.gradient(bbox_height_ratio, timestamps_s), -8.0, 8.0
    )
    visible_ratio = joint_mask.mean(axis=1)
    body_center_y = (shoulder_y + hip_y) * 0.5
    low_posture = np.clip((body_center_y + 0.10) / 0.55, 0.0, 1.0)

    joint_delta = np.diff(normalized_xy, axis=0, prepend=normalized_xy[[0]])
    joint_pair_mask = joint_mask * np.vstack((joint_mask[[0]], joint_mask[:-1]))
    joint_motion = (np.linalg.norm(joint_delta, axis=-1) * joint_pair_mask).sum(axis=1)
    joint_motion /= np.maximum(joint_pair_mask.sum(axis=1), 1.0)
    joint_motion /= np.maximum(np.gradient(timestamps_s), 1e-6)
    joint_motion = np.clip(joint_motion, 0.0, 10.0)

    derived = np.column_stack(
        (
            torso_tilt,
            shoulder_y,
            hip_y,
            hip_velocity,
            hip_acceleration,
            bbox_widths / bbox_heights,
            bbox_height_ratio,
            bbox_height_velocity,
            visible_ratio,
            body_center_y,
            low_posture,
            joint_motion,
        )
    )
    features = np.concatenate(
        (normalized_xy.reshape(len(results), -1), confidence, joint_mask, derived),
        axis=1,
    )
    features = np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0).astype(
        np.float32
    )
    if features.shape[1] != len(FEATURE_NAMES):
        raise RuntimeError("M-04 feature contract changed")
    return features
