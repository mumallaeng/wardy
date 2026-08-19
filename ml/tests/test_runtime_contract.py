from __future__ import annotations

import unittest

import numpy as np

from m03_pose.contract import PersonInput, PoseResult
from m03_pose.preprocess import decode_simcc, preprocess_pose
from m04_fall.features import FEATURE_NAMES, pose_results_to_features
from m04_fall.inference import FallResult
from m04_fall.runtime import PoseFallRuntime


class FakePose:
    def infer(self, _frame: np.ndarray, person: PersonInput) -> PoseResult:
        keypoints = np.zeros((17, 3), dtype=np.float32)
        keypoints[:, 0] = np.linspace(person.bbox_xyxy[0], person.bbox_xyxy[2], 17)
        keypoints[:, 1] = np.linspace(person.bbox_xyxy[1], person.bbox_xyxy[3], 17)
        keypoints[:, 2] = 0.9
        return PoseResult(
            frame_id=person.frame_id,
            timestamp_ms=person.timestamp_ms,
            track_id=person.track_id,
            bbox_xyxy=person.bbox_xyxy,
            keypoints_xyc=keypoints,
            pose_quality=0.9,
        )


class FakeFall:
    window_frames = 3
    target_fps = 10.0
    threshold = 0.5

    def predict(
        self, features: np.ndarray, track_id: int, timestamp_ms: int
    ) -> FallResult:
        self.last_features = features
        return FallResult(track_id, timestamp_ms, False, 0.1, 0.5, "fake")


class RuntimeContractTest(unittest.TestCase):
    def test_pose_preprocess_and_simcc_decode(self) -> None:
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        tensor, center, scale = preprocess_pose(frame, np.array([100, 50, 400, 450]))
        self.assertEqual(tensor.shape, (1, 3, 256, 192))
        simcc_x = np.zeros((1, 17, 384), dtype=np.float32)
        simcc_y = np.zeros((1, 17, 512), dtype=np.float32)
        simcc_x[:, :, 192] = 0.8
        simcc_y[:, :, 256] = 0.7
        decoded = decode_simcc(simcc_x, simcc_y, center, scale)
        self.assertEqual(decoded.shape, (1, 17, 3))
        expected = 1.0 / (1.0 + np.exp(-0.7))
        np.testing.assert_allclose(decoded[0, :, 2], expected)

        simcc_x[:, :, 192] = 8.0
        simcc_y[:, :, 256] = 7.0
        decoded = decode_simcc(simcc_x, simcc_y, center, scale)
        self.assertTrue(np.all(decoded[0, :, 2] <= 1.0))
        self.assertTrue(np.all(decoded[0, :, 2] >= 0.0))

    def test_feature_contract_is_twenty_by_eighty(self) -> None:
        pose = FakePose()
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        results = [
            pose.infer(
                frame, PersonInput(f"f-{index}", index * 100, 3, [100, 50, 400, 450])
            )
            for index in range(20)
        ]
        features = pose_results_to_features(results)
        self.assertEqual(features.shape, (20, 80))
        self.assertEqual(len(FEATURE_NAMES), 80)
        self.assertTrue(np.isfinite(features).all())

    def test_runtime_samples_per_track_and_resets_backwards_time(self) -> None:
        fall = FakeFall()
        runtime = PoseFallRuntime(FakePose(), fall)
        frame = np.zeros((32, 32, 3), dtype=np.uint8)

        def process(timestamp: int):
            return runtime.process(
                frame, PersonInput("f", timestamp, 9, [1, 1, 30, 30])
            )

        self.assertTrue(process(1000).accepted)
        skipped = process(1050)
        self.assertFalse(skipped.accepted)
        self.assertEqual(skipped.to_dict(), {
            "accepted": False,
            "history_frames": 1,
            "window_frames": 3,
            "fall_threshold": 0.5,
        })
        self.assertTrue(process(1100).accepted)
        completed = process(1200)
        self.assertIsNotNone(completed.fall)
        self.assertEqual(fall.last_features.shape, (3, 80))
        reset = process(900)
        self.assertTrue(reset.accepted)
        self.assertIsNone(reset.fall)
        gap_reset = process(1500)
        self.assertTrue(gap_reset.accepted)
        self.assertIsNone(gap_reset.fall)
        self.assertIsNone(process(1600).fall)

    def test_person_box_rejects_non_positive_area(self) -> None:
        with self.assertRaises(ValueError):
            PersonInput("f", 0, 1, [10, 10, 10, 20])


if __name__ == "__main__":
    unittest.main()
