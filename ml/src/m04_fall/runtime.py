from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from dataclasses import replace
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
    history_frames: int
    window_frames: int
    fall_threshold: float

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "accepted": self.accepted,
            "history_frames": self.history_frames,
            "window_frames": self.window_frames,
            "fall_threshold": self.fall_threshold,
        }
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
        # Keep temporal state through normal camera/worker scheduling jitter.
        # A three-frame gap at 10 FPS reset the 20-frame M-04 window before it
        # could ever produce a fall confidence on a busy Jetson.
        self.maximum_gap_ms = self.interval_ms * max(fall.window_frames, 10)
        self.histories: dict[int, deque[PoseResult]] = defaultdict(
            lambda: deque(maxlen=fall.window_frames)
        )
        self.last_timestamp: dict[int, int] = {}
        # Landmark noise can flip a posture label for one frame. Keep the
        # displayed label stable with a short per-track majority vote while
        # preserving the raw keypoints used by M-04.
        self.posture_histories: dict[int, deque[str]] = defaultdict(
            lambda: deque(maxlen=5)
        )

    def diagnostics(self, track_id: int) -> dict[str, int | float]:
        return {
            "history_frames": len(self.histories.get(track_id, ())),
            "window_frames": self.fall.window_frames,
            "fall_threshold": self.fall.threshold,
        }

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
            return RuntimeResult(
                accepted=False,
                pose=None,
                fall=None,
                **self.diagnostics(person.track_id),
        )
        result = self.pose.infer(frame_bgr, person)
        raw_posture = result.posture
        posture_history = self.posture_histories[person.track_id]
        previous_postures = tuple(posture_history)
        if result.posture != "unknown":
            posture_history.append(result.posture)
        if posture_history:
            labels, counts = np.unique(np.asarray(posture_history), return_counts=True)
            max_count = int(counts.max())
            candidates = {str(label) for label, count in zip(labels, counts) if int(count) == max_count}
            smoothed_posture = (
                result.posture if result.posture in candidates else str(labels[int(np.argmax(counts))])
            )
            if smoothed_posture != result.posture:
                result = replace(result, posture=smoothed_posture)
        history = self.histories[person.track_id]
        history.append(result)
        self.last_timestamp[person.track_id] = person.timestamp_ms
        fall_result = None
        # A rapid standing-to-lying transition is a strong fall candidate even
        # before the full temporal model window is available. Require two
        # consecutive smoothed standing samples to avoid one-frame pose noise.
        rapid_transition = (
            raw_posture == "lying"
            and len(previous_postures) >= 2
            and previous_postures[-1] == "standing"
            and previous_postures[-2] == "standing"
        )
        if rapid_transition:
            result = replace(result, posture="lying")
            fall_result = FallResult(
                track_id=person.track_id,
                timestamp_ms=person.timestamp_ms,
                fall_suspected=True,
                confidence=1.0,
                threshold=self.fall.threshold,
                model_name="standing_to_lying_transition",
            )
        elif len(history) >= self.fall.window_frames:
            features = pose_results_to_features(list(history))
            fall_result = self.fall.predict(
                features, person.track_id, person.timestamp_ms
            )
        return RuntimeResult(
            accepted=True,
            pose=result,
            fall=fall_result,
            **self.diagnostics(person.track_id),
        )

    def reset_track(self, track_id: int) -> None:
        self.histories.pop(track_id, None)
        self.last_timestamp.pop(track_id, None)
        self.posture_histories.pop(track_id, None)

    def retain_tracks(self, active_track_ids: set[int] | frozenset[int]) -> None:
        """Discard temporal state after the owning anonymous track expires."""
        known_track_ids = set(self.histories) | set(self.last_timestamp)
        for track_id in known_track_ids - set(active_track_ids):
            self.reset_track(track_id)

    def reset_all(self) -> None:
        self.histories.clear()
        self.last_timestamp.clear()
        self.posture_histories.clear()
