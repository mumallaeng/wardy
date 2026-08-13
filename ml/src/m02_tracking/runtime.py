"""Connect M02-A tracking to the promoted M03/M04 inference runtime."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
import sys
from typing import Any

import numpy as np

from m03_pose import PersonInput
from m04_fall import PoseFallRuntime

from .adapter import M02TrackingAdapter


class TrackingPoseFallRuntime:
    """Run M02-A once per frame, then route each tracked person to M03/M04."""

    def __init__(
        self,
        tracking: M02TrackingAdapter,
        pose_fall: PoseFallRuntime,
        identity: Any | None = None,
    ) -> None:
        self.tracking = tracking
        self.pose_fall = pose_fall
        self.identity = identity
        self._request_mode: str | None = None

    def reset(self) -> None:
        self.tracking.reset()
        self.pose_fall.reset_all()
        if self.identity is not None:
            self.identity.reset()

    def process_tracked_person(
        self,
        frame_bgr: np.ndarray,
        person: PersonInput,
    ) -> Any:
        """Run the transitional legacy contract in an isolated ID namespace."""
        self._select_request_mode("legacy")
        return self.pose_fall.process(frame_bgr, person)

    def process_frame(
        self,
        frame_bgr: np.ndarray,
        *,
        frame_id: str,
        timestamp_ms: int,
        person_detections: Iterable[Mapping[str, Any]],
    ) -> dict[str, Any]:
        self._select_request_mode("tracking")
        if frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3:
            raise ValueError("tracking runtime requires one HWC BGR frame")
        frame_height, frame_width = frame_bgr.shape[:2]
        tracking_result = self.tracking.process_frame(
            frame_id=frame_id,
            timestamp_ms=timestamp_ms,
            frame_width=frame_width,
            frame_height=frame_height,
            person_detections=person_detections,
        )

        identity_results: dict[int, dict[str, Any]] = {}
        if self.identity is not None:
            try:
                identity_results = self.identity.identify(
                    frame_bgr,
                    tracking_result["persons"],
                    captured_at=datetime.fromtimestamp(
                        timestamp_ms / 1000.0, tz=timezone.utc
                    ).isoformat(timespec="seconds").replace("+00:00", "Z"),
                )
            except Exception as error:
                print(
                    f"identity recognition failed: {error}",
                    file=sys.stderr,
                    flush=True,
                )
        persons = []
        for tracked_person in tracking_result["persons"]:
            person = PersonInput(
                frame_id=frame_id,
                timestamp_ms=timestamp_ms,
                track_id=tracked_person["track_id"],
                bbox_xyxy=tracked_person["bbox_xyxy"],
            )
            identity = identity_results.get(tracked_person["track_id"])
            try:
                inference = self.pose_fall.process(frame_bgr, person)
            except Exception:
                # A malformed pose for one crop is a skipped observation, not
                # a frame-wide detection outage. Reset only that track's
                # temporal history so M04 never consumes a broken sequence.
                self.pose_fall.reset_track(person.track_id)
                persons.append({
                    **tracked_person,
                    "accepted": False,
                    **({"identity": identity} if identity is not None else {}),
                })
                continue
            persons.append({
                **tracked_person,
                **inference.to_dict(),
                **({"identity": identity} if identity is not None else {}),
            })

        # M04 history must not outlive the anonymous M02 track that owns it.
        self.pose_fall.retain_tracks(self.tracking.tracker.active_track_ids)
        if self.identity is not None:
            self.identity.retain_tracks(self.tracking.tracker.active_track_ids)
        return {
            "frame_id": frame_id,
            "timestamp_ms": timestamp_ms,
            "tracking_scope": tracking_result["tracking_scope"],
            "active_track_ids": sorted(self.tracking.tracker.active_track_ids),
            "persons": persons,
        }

    def _select_request_mode(self, request_mode: str) -> None:
        if self._request_mode is None:
            self._request_mode = request_mode
            return
        if self._request_mode != request_mode:
            raise ValueError(
                "tracked requests and person_detections requests cannot share "
                "one runtime"
            )
