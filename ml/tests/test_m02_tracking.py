from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np


ML_SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(ML_SRC))

from m02_tracking import (  # noqa: E402
    Detection,
    GeometricMultiObjectTracker,
    M02TrackingAdapter,
    TrackingPoseFallRuntime,
)
from pose_fall_worker import process_request  # noqa: E402


class _FakeRuntimeResult:
    def __init__(self, track_id: int) -> None:
        self.track_id = track_id

    def to_dict(self) -> dict:
        return {"accepted": True, "processed_track_id": self.track_id}


class _FakePoseFallRuntime:
    def __init__(self) -> None:
        self.processed_track_ids: list[int] = []
        self.retained_track_ids: frozenset[int] = frozenset()
        self.reset_count = 0

    def process(self, _frame: np.ndarray, person) -> _FakeRuntimeResult:
        self.processed_track_ids.append(person.track_id)
        return _FakeRuntimeResult(person.track_id)

    def retain_tracks(self, track_ids: frozenset[int]) -> None:
        self.retained_track_ids = track_ids

    def reset_all(self) -> None:
        self.reset_count += 1


class _FakeHazard:
    def to_dict(self) -> dict:
        return {
            "detection_id": "frame-1:hazard:0",
            "class_name": "scissors",
            "confidence": 0.9,
            "bbox_xyxy": [70.0, 60.0, 90.0, 90.0],
        }


class _FakeHazardDetector:
    def infer(self, _frame: np.ndarray, _frame_id: str) -> list[_FakeHazard]:
        return [_FakeHazard()]


class GeometricMultiObjectTrackerTest(unittest.TestCase):
    def test_nearby_detections_keep_the_same_track_id(self) -> None:
        tracker = GeometricMultiObjectTracker()

        first = tracker.update([Detection([10, 10, 50, 90], 0.95)])
        second = tracker.update([Detection([13, 11, 53, 91], 0.93)])

        self.assertEqual(first[0].track_id, 1)
        self.assertEqual(second[0].track_id, 1)
        self.assertEqual(second[0].hits, 2)

    def test_distant_detection_starts_a_new_track(self) -> None:
        tracker = GeometricMultiObjectTracker()
        tracker.update([Detection([0, 0, 20, 40], 0.9)])

        output = tracker.update([Detection([500, 500, 520, 540], 0.8)])

        self.assertEqual([track.track_id for track in output], [2])

    def test_missing_track_expires_after_max_age(self) -> None:
        tracker = GeometricMultiObjectTracker(max_age_frames=2)
        tracker.update([Detection([10, 10, 50, 90], 0.95)])
        tracker.update([])
        tracker.update([])
        tracker.update([])

        output = tracker.update([Detection([10, 10, 50, 90], 0.95)])

        self.assertEqual([track.track_id for track in output], [2])

    def test_reset_restarts_anonymous_ids(self) -> None:
        tracker = GeometricMultiObjectTracker()
        tracker.update([Detection([10, 10, 50, 90], 0.95)])

        tracker.reset()
        output = tracker.update([Detection([100, 100, 140, 180], 0.95)])

        self.assertEqual(output[0].track_id, 1)


class M02TrackingAdapterTest(unittest.TestCase):
    def test_output_is_ready_for_m03_pose_input(self) -> None:
        adapter = M02TrackingAdapter()
        source_bbox = [-5, 20, 200, 500]

        result = adapter.process_frame(
            frame_id="camera-1:42",
            timestamp_ms=1400,
            frame_width=640,
            frame_height=480,
            person_detections=[
                {"bbox_xyxy": source_bbox, "confidence": 0.91}
            ],
        )

        self.assertEqual(result["tracking_scope"], "anonymous_short_term")
        person = result["persons"][0]
        self.assertEqual(person["track_id"], 1)
        self.assertEqual(person["bbox_xyxy"], [0.0, 20.0, 200.0, 480.0])
        self.assertEqual(person["frame_width"], 640)
        self.assertEqual(person["frame_height"], 480)
        self.assertEqual(source_bbox, [-5, 20, 200, 500])

    def test_empty_frame_advances_track_lifecycle(self) -> None:
        adapter = M02TrackingAdapter(
            GeometricMultiObjectTracker(max_age_frames=0)
        )
        adapter.process_frame(
            frame_id="frame-1",
            timestamp_ms=0,
            frame_width=320,
            frame_height=240,
            person_detections=[
                {"bbox_xyxy": [10, 10, 50, 100], "confidence": 0.9}
            ],
        )

        empty = adapter.process_frame(
            frame_id="frame-2",
            timestamp_ms=33,
            frame_width=320,
            frame_height=240,
            person_detections=[],
        )

        self.assertEqual(empty["persons"], [])

    def test_invalid_detection_contract_is_rejected(self) -> None:
        adapter = M02TrackingAdapter()

        with self.assertRaises(ValueError):
            adapter.process_frame(
                frame_id="frame-1",
                timestamp_ms=0,
                frame_width=320,
                frame_height=240,
                person_detections=[{"bbox_xyxy": [10, 10, 50, 100]}],
            )

    def test_fully_off_frame_detection_is_ignored(self) -> None:
        adapter = M02TrackingAdapter()

        result = adapter.process_frame(
            frame_id="frame-1",
            timestamp_ms=0,
            frame_width=320,
            frame_height=240,
            person_detections=[
                {"bbox_xyxy": [-50, 10, -5, 100], "confidence": 0.8},
                {"bbox_xyxy": [10, 10, 50, 100], "confidence": 0.9},
            ],
        )

        self.assertEqual(len(result["persons"]), 1)
        self.assertEqual(
            result["persons"][0]["bbox_xyxy"],
            [10.0, 10.0, 50.0, 100.0],
        )

    def test_malformed_off_frame_detection_is_rejected(self) -> None:
        adapter = M02TrackingAdapter()

        with self.assertRaises(ValueError):
            adapter.process_frame(
                frame_id="frame-1",
                timestamp_ms=0,
                frame_width=320,
                frame_height=240,
                person_detections=[
                    {"bbox_xyxy": [-5, 10, -50, 100], "confidence": 0.8}
                ],
            )


class TrackingPoseFallRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.pose_fall = _FakePoseFallRuntime()
        self.runtime = TrackingPoseFallRuntime(
            M02TrackingAdapter(), self.pose_fall  # type: ignore[arg-type]
        )
        self.frame = np.zeros((120, 160, 3), dtype=np.uint8)

    def test_m02_track_is_forwarded_to_m03_m04_runtime(self) -> None:
        first = self.runtime.process_frame(
            self.frame,
            frame_id="frame-1",
            timestamp_ms=0,
            person_detections=[
                {"bbox_xyxy": [10, 10, 60, 110], "confidence": 0.95}
            ],
        )
        second = self.runtime.process_frame(
            self.frame,
            frame_id="frame-2",
            timestamp_ms=100,
            person_detections=[
                {"bbox_xyxy": [13, 10, 63, 110], "confidence": 0.94}
            ],
        )

        self.assertEqual(first["persons"][0]["track_id"], 1)
        self.assertEqual(second["persons"][0]["track_id"], 1)
        self.assertEqual(first["active_track_ids"], [1])
        self.assertEqual(self.pose_fall.processed_track_ids, [1, 1])
        self.assertEqual(self.pose_fall.retained_track_ids, frozenset({1}))

    def test_worker_detection_request_runs_tracking_path(self) -> None:
        encoded, jpeg = cv2.imencode(".jpg", self.frame)
        self.assertTrue(encoded)
        response = process_request(
            {
                "frame_id": "frame-1",
                "timestamp_ms": 0,
                "person_detections": [
                    {"bbox_xyxy": [10, 10, 60, 110], "confidence": 0.95}
                ],
                "frame_jpeg_base64": base64.b64encode(jpeg).decode(),
            },
            self.runtime,
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["persons"][0]["track_id"], 1)
        self.assertEqual(response["persons"][0]["processed_track_id"], 1)

    def test_worker_adds_m05_hazard_output_to_the_same_frame(self) -> None:
        encoded, jpeg = cv2.imencode(".jpg", self.frame)
        self.assertTrue(encoded)
        response = process_request(
            {
                "frame_id": "frame-1",
                "timestamp_ms": 0,
                "person_detections": [
                    {"bbox_xyxy": [10, 10, 60, 110], "confidence": 0.95}
                ],
                "frame_jpeg_base64": base64.b64encode(jpeg).decode(),
            },
            self.runtime,
            _FakeHazardDetector(),  # type: ignore[arg-type]
        )
        self.assertTrue(response["ok"])
        self.assertEqual(response["persons"][0]["track_id"], 1)
        self.assertEqual(response["hazards"][0]["class_name"], "scissors")

    def test_reset_clears_tracking_and_temporal_runtime(self) -> None:
        self.runtime.process_frame(
            self.frame,
            frame_id="frame-1",
            timestamp_ms=0,
            person_detections=[
                {"bbox_xyxy": [10, 10, 60, 110], "confidence": 0.95}
            ],
        )

        self.runtime.reset()

        self.assertEqual(self.pose_fall.reset_count, 1)
        self.assertEqual(self.runtime.tracking.tracker.active_track_ids, frozenset())

    def test_worker_can_reset_tracking_before_a_new_stream(self) -> None:
        encoded, jpeg = cv2.imencode(".jpg", self.frame)
        self.assertTrue(encoded)
        image_base64 = base64.b64encode(jpeg).decode()
        request = {
            "frame_id": "frame-1",
            "timestamp_ms": 0,
            "person_detections": [
                {"bbox_xyxy": [10, 10, 60, 110], "confidence": 0.95}
            ],
            "frame_jpeg_base64": image_base64,
        }
        process_request(request, self.runtime)

        request["frame_id"] = "new-stream:1"
        request["reset_tracking"] = True
        response = process_request(request, self.runtime)

        self.assertEqual(response["persons"][0]["track_id"], 1)
        self.assertEqual(self.pose_fall.reset_count, 1)

    def test_worker_rejects_legacy_request_after_tracking_path(self) -> None:
        encoded, jpeg = cv2.imencode(".jpg", self.frame)
        self.assertTrue(encoded)
        image_base64 = base64.b64encode(jpeg).decode()
        process_request(
            {
                "frame_id": "frame-1",
                "timestamp_ms": 0,
                "person_detections": [],
                "frame_jpeg_base64": image_base64,
            },
            self.runtime,
        )

        with self.assertRaisesRegex(ValueError, "cannot share one runtime"):
            process_request(
                {
                    "frame_id": "frame-2",
                    "timestamp_ms": 33,
                    "track_id": 1,
                    "bbox_xyxy": [10, 10, 50, 100],
                    "frame_jpeg_base64": image_base64,
                },
                self.runtime,
            )

    def test_worker_rejects_tracking_request_after_legacy_path(self) -> None:
        encoded, jpeg = cv2.imencode(".jpg", self.frame)
        self.assertTrue(encoded)
        image_base64 = base64.b64encode(jpeg).decode()
        process_request(
            {
                "frame_id": "frame-1",
                "timestamp_ms": 0,
                "track_id": 7,
                "bbox_xyxy": [10, 10, 50, 100],
                "frame_jpeg_base64": image_base64,
            },
            self.runtime,
        )

        with self.assertRaisesRegex(ValueError, "cannot share one runtime"):
            process_request(
                {
                    "frame_id": "frame-2",
                    "timestamp_ms": 33,
                    "person_detections": [],
                    "frame_jpeg_base64": image_base64,
                },
                self.runtime,
            )


if __name__ == "__main__":
    unittest.main()
