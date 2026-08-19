from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

import numpy as np

from m03_pose import PersonInput, PoseEstimator, PoseResult

from .features import pose_results_to_features
from .inference import FallInferenceSession, FallResult


@dataclass(frozen=True)
class RuntimeResult:
    accepted: bool
    pose: PoseResult | None
    fall: FallResult | None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"accepted": self.accepted}
        if self.pose is not None:
            payload["pose"] = self.pose.to_dict()
        if self.fall is not None:
            payload["fall"] = self.fall.to_dict()
        return payload


class PoseFallRuntime:
    def __init__(self, pose: PoseEstimator, fall: FallInferenceSession):
        self.pose = pose
        self.fall = fall
        self.interval_ms = int(round(1000.0 / fall.target_fps))
        self.maximum_gap_ms = self.interval_ms * 3
        self.histories: dict[int, deque[PoseResult]] = defaultdict(
            lambda: deque(maxlen=fall.window_frames)
        )
        self.last_timestamp: dict[int, int] = {}

    def process(self, frame_bgr: np.ndarray, person: PersonInput) -> RuntimeResult:
        previous = self.last_timestamp.get(person.track_id)
        if previous is not None and person.timestamp_ms <= previous:
            self.reset_track(person.track_id)
            previous = None
        if (
            previous is not None
            and person.timestamp_ms - previous > self.maximum_gap_ms
        ):
            self.reset_track(person.track_id)
            previous = None
        if previous is not None and person.timestamp_ms - previous < self.interval_ms:
            return RuntimeResult(accepted=False, pose=None, fall=None)
        result = self.pose.infer(frame_bgr, person)
        history = self.histories[person.track_id]
        history.append(result)
        self.last_timestamp[person.track_id] = person.timestamp_ms
        fall_result = None
        if len(history) >= self.fall.window_frames:
            features = pose_results_to_features(list(history))
            fall_result = self.fall.predict(
                features, person.track_id, person.timestamp_ms
            )
        return RuntimeResult(accepted=True, pose=result, fall=fall_result)

    def reset_track(self, track_id: int) -> None:
        self.histories.pop(track_id, None)
        self.last_timestamp.pop(track_id, None)
