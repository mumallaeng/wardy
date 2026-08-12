from __future__ import annotations

import sys
import unittest
from pathlib import Path


ML_SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(ML_SRC))

from m02_tracking import (  # noqa: E402
    Detection,
    GeometricMultiObjectTracker,
    M02TrackingAdapter,
)


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


if __name__ == "__main__":
    unittest.main()
