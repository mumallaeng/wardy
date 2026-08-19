from __future__ import annotations

import cv2
import numpy as np


MODEL_INPUT_SIZE = np.asarray([192, 256], dtype=np.float32)
BBOX_PADDING = 1.25
IMAGE_MEAN = np.asarray([123.675, 116.28, 103.53], dtype=np.float32)
IMAGE_STD = np.asarray([58.395, 57.12, 57.375], dtype=np.float32)
SIMCC_SPLIT_RATIO = 2.0


def bbox_xyxy_to_center_scale(bbox_xyxy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x1, y1, x2, y2 = np.asarray(bbox_xyxy, dtype=np.float32)
    if x2 <= x1 or y2 <= y1:
        raise ValueError("invalid bbox_xyxy")
    center = np.asarray([(x1 + x2) * 0.5, (y1 + y2) * 0.5], dtype=np.float32)
    scale = np.asarray([x2 - x1, y2 - y1], dtype=np.float32) * BBOX_PADDING
    aspect_ratio = float(MODEL_INPUT_SIZE[0] / MODEL_INPUT_SIZE[1])
    if scale[0] > scale[1] * aspect_ratio:
        scale[1] = scale[0] / aspect_ratio
    else:
        scale[0] = scale[1] * aspect_ratio
    return center, scale


def _third_point(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    direction = a - b
    return b + np.asarray([-direction[1], direction[0]], dtype=np.float32)


def affine_matrix(center: np.ndarray, scale: np.ndarray) -> np.ndarray:
    width, height = MODEL_INPUT_SIZE
    source_direction = np.asarray([0.0, -0.5 * scale[0]], dtype=np.float32)
    destination_direction = np.asarray([0.0, -0.5 * width], dtype=np.float32)
    source = np.stack(
        (
            center,
            center + source_direction,
            _third_point(center, center + source_direction),
        )
    )
    destination_center = np.asarray([width * 0.5, height * 0.5], dtype=np.float32)
    destination = np.stack(
        (
            destination_center,
            destination_center + destination_direction,
            _third_point(
                destination_center, destination_center + destination_direction
            ),
        )
    )
    return cv2.getAffineTransform(
        source.astype(np.float32), destination.astype(np.float32)
    )


def preprocess_pose(
    frame_bgr: np.ndarray, bbox_xyxy: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3:
        raise ValueError("frame must be a BGR image")
    center, scale = bbox_xyxy_to_center_scale(bbox_xyxy)
    width, height = MODEL_INPUT_SIZE.astype(int)
    crop = cv2.warpAffine(frame_bgr, affine_matrix(center, scale), (width, height))
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32)
    tensor = ((rgb - IMAGE_MEAN) / IMAGE_STD).transpose(2, 0, 1)[None]
    return np.ascontiguousarray(tensor, dtype=np.float32), center, scale


def decode_simcc(
    simcc_x: np.ndarray,
    simcc_y: np.ndarray,
    center: np.ndarray,
    scale: np.ndarray,
) -> np.ndarray:
    expected_x = int(MODEL_INPUT_SIZE[0] * SIMCC_SPLIT_RATIO)
    expected_y = int(MODEL_INPUT_SIZE[1] * SIMCC_SPLIT_RATIO)
    if simcc_x.shape != (1, 17, expected_x) or simcc_y.shape != (1, 17, expected_y):
        raise ValueError(f"unexpected SimCC output: {simcc_x.shape}, {simcc_y.shape}")
    locations = np.stack(
        (np.argmax(simcc_x, axis=-1), np.argmax(simcc_y, axis=-1)), axis=-1
    ).astype(np.float32)
    raw_scores = np.minimum(np.max(simcc_x, axis=-1), np.max(simcc_y, axis=-1))
    # RTMPose exports SimCC logits, not bounded probabilities. Convert the
    # joint score to a stable [0, 1] confidence before enforcing the contract.
    scores = 1.0 / (1.0 + np.exp(-np.clip(raw_scores, -30.0, 30.0)))
    model_xy = locations / SIMCC_SPLIT_RATIO
    frame_xy = model_xy / MODEL_INPUT_SIZE * scale + center - scale * 0.5
    return np.concatenate((frame_xy, scores[..., None]), axis=-1).astype(np.float32)
