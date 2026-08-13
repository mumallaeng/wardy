from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from m02_identity.runtime import RegisteredSubjectIdentifier, _GalleryFeature, _Subject


class _Detector:
    def __init__(self) -> None:
        self.input_size: tuple[int, int] | None = None
        self.image_shape: tuple[int, ...] | None = None

    def setInputSize(self, size: tuple[int, int]) -> None:
        self.input_size = size

    def detect(self, image: np.ndarray) -> tuple[None, np.ndarray]:
        self.image_shape = image.shape
        return None, np.array([[2, 2, 12, 12, 3, 5, 10, 5, 6, 9, 4, 12, 10, 12, 0.99]])


class _Recognizer:
    def __init__(self) -> None:
        self.feature_calls = 0

    def alignCrop(self, image: np.ndarray, _face: np.ndarray) -> np.ndarray:
        return image

    def feature(self, image: np.ndarray) -> np.ndarray:
        self.feature_calls += 1
        return np.array([[float(image.mean())]], dtype=np.float32)

    def match(self, feature: np.ndarray, candidate: np.ndarray, _metric: int) -> float:
        return 0.9 if abs(float(feature[0, 0] - candidate[0, 0])) < 1.0 else 0.2


def _create_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE subjects(subject_id TEXT PRIMARY KEY,name TEXT,role TEXT);
        CREATE TABLE subject_reference_samples(
          sample_id TEXT PRIMARY KEY,subject_id TEXT,image_path TEXT
        );
        CREATE TABLE identity_reviews(
          review_id TEXT PRIMARY KEY,image_path TEXT,captured_at TEXT,
          predicted_name TEXT,confidence REAL,decision TEXT,subject_id TEXT,
          updated_at TEXT
        );
        CREATE TABLE data_collection_settings(
          singleton_id INTEGER PRIMARY KEY,identity_review_enabled INTEGER
        );
        INSERT INTO data_collection_settings VALUES(1,1);
        """
    )
    connection.commit()
    connection.close()


class RegisteredSubjectIdentifierTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.database = root / "wardy.sqlite"
        self.training = root / "training"
        self.training.mkdir()
        _create_database(self.database)
        with patch.object(cv2, "FaceDetectorYN"), patch.object(cv2, "FaceRecognizerSF"):
            self.runtime = RegisteredSubjectIdentifier(
                root / "detector.onnx",
                root / "recognizer.onnx",
                self.database,
                self.training,
                refresh_seconds=0.0,
            )
        self.runtime.detector = _Detector()
        self.runtime.recognizer = _Recognizer()

    def tearDown(self) -> None:
        self.runtime.close()
        self.temporary.cleanup()

    def test_registered_subject_metadata_is_returned(self) -> None:
        self.runtime._gallery = [
            _GalleryFeature(_Subject("subject-1", "김연우", "돌봄 대상"),
                            np.array([[100.0]], dtype=np.float32))
        ]
        self.runtime._data_version = int(
            self.runtime._connection.execute("PRAGMA data_version").fetchone()[0]
        )
        frame = np.full((30, 30, 3), 100, dtype=np.uint8)
        result = self.runtime.identify(
            frame,
            [{"track_id": 7, "bbox_xyxy": [0, 0, 30, 30]}],
            captured_at="2026-08-12T00:00:00Z",
        )
        self.assertEqual(result[7]["status"], "registered")
        self.assertEqual(result[7]["subject_id"], "subject-1")
        self.assertEqual(result[7]["subject_name"], "김연우")

    def test_yunet_input_is_letterboxed_and_face_coordinates_are_restored(self) -> None:
        image = np.full((61, 47, 3), 100, dtype=np.uint8)
        face = self.runtime._largest_face(image)
        self.assertIsNotNone(face)
        self.assertEqual(self.runtime.detector.input_size, (320, 320))
        self.assertEqual(self.runtime.detector.image_shape, (320, 320, 3))
        x_scale = 247 / 47
        y_scale = 320 / 61
        expected = np.array(
            [2, 2, 12, 12, 3, 5, 10, 5, 6, 9, 4, 12, 10, 12, 0.99],
            dtype=np.float64,
        )
        expected[[0, 2, 4, 6, 8, 10, 12]] /= x_scale
        expected[[1, 3, 5, 7, 9, 11, 13]] /= y_scale
        np.testing.assert_allclose(
            face,
            expected,
            rtol=1e-6,
        )

    def test_unknown_face_creates_one_rate_limited_local_review(self) -> None:
        frame = np.full((30, 30, 3), 50, dtype=np.uint8)
        person = [{"track_id": 8, "bbox_xyxy": [0, 0, 30, 30]}]
        first = self.runtime.identify(
            frame, person, captured_at="2026-08-12T00:00:00Z"
        )
        second = self.runtime.identify(
            frame, person, captured_at="2026-08-12T00:00:01Z"
        )
        self.assertIsNotNone(first[8]["review_id"])
        self.assertIsNone(second[8]["review_id"])
        row = self.runtime._connection.execute(
            "SELECT image_path,decision FROM identity_reviews"
        ).fetchone()
        self.assertEqual(row[1], "pending")
        self.assertTrue((self.training / row[0]).is_file())

    def test_failed_review_write_does_not_start_cooldown(self) -> None:
        frame = np.full((30, 30, 3), 50, dtype=np.uint8)
        self.runtime.max_pending_reviews = 1
        first = self.runtime.identify(
            frame,
            [{"track_id": 8, "bbox_xyxy": [0, 0, 30, 30]}],
            captured_at="2026-08-12T00:00:00Z",
        )
        first_path = self.runtime._connection.execute(
            "SELECT image_path FROM identity_reviews WHERE review_id=?",
            (first[8]["review_id"],),
        ).fetchone()[0]
        with patch.object(cv2, "imwrite", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "unable to save"):
                self.runtime.identify(
                    frame,
                    [{"track_id": 9, "bbox_xyxy": [0, 0, 30, 30]}],
                    captured_at="2026-08-12T00:00:00Z",
                )
        self.assertNotIn(9, self.runtime._last_review_by_track)
        self.assertEqual(
            self.runtime._connection.execute(
                "SELECT COUNT(*) FROM identity_reviews"
            ).fetchone()[0],
            1,
        )
        self.assertTrue((self.training / first_path).is_file())

    def test_uncertain_face_review_keeps_predicted_name(self) -> None:
        candidate = _GalleryFeature(
            _Subject("subject-2", "등록 인물", "돌봄 대상"),
            np.array([[100.0]], dtype=np.float32),
        )
        frame = np.full((30, 30, 3), 50, dtype=np.uint8)
        with patch.object(self.runtime, "_best_match", return_value=(candidate, 0.35)):
            result = self.runtime.identify(
                frame,
                [{"track_id": 10, "bbox_xyxy": [0, 0, 30, 30]}],
                captured_at="2026-08-12T00:00:00Z",
            )
        self.assertEqual(result[10]["status"], "uncertain")
        predicted_name = self.runtime._connection.execute(
            "SELECT predicted_name FROM identity_reviews"
        ).fetchone()[0]
        self.assertEqual(predicted_name, "등록 인물")

    def test_stored_path_rejects_parent_directory_escape(self) -> None:
        outside = self.training.parent / "outside.jpg"
        outside.write_bytes(b"outside")
        self.assertIsNone(self.runtime._stored_path("../outside.jpg"))

    def test_malformed_person_does_not_discard_other_identity_results(self) -> None:
        frame = np.full((30, 30, 3), 50, dtype=np.uint8)
        result = self.runtime.identify(
            frame,
            [
                {"track_id": 11, "bbox_xyxy": [50, 50, 60, 60]},
                {"track_id": 12, "bbox_xyxy": [0, 0, 30, 30]},
            ],
            captured_at="2026-08-12T00:00:00Z",
        )
        self.assertEqual(result[11]["status"], "no_face")
        self.assertEqual(result[12]["status"], "unknown")

    def test_gallery_features_are_reused_after_unrelated_database_write(self) -> None:
        reference = self.training / "identity" / "subject-1" / "reference.jpg"
        reference.parent.mkdir(parents=True)
        self.assertTrue(cv2.imwrite(str(reference), np.full((30, 30, 3), 80, dtype=np.uint8)))
        with self.runtime._connection:
            self.runtime._connection.execute(
                "INSERT INTO subjects(subject_id,name,role) VALUES(?,?,?)",
                ("subject-1", "등록 인물", "돌봄 대상"),
            )
            self.runtime._connection.execute(
                "INSERT INTO subject_reference_samples(sample_id,subject_id,image_path) VALUES(?,?,?)",
                ("sample-1", "subject-1", "identity/subject-1/reference.jpg"),
            )
        self.runtime._refresh_gallery_if_needed()
        self.assertEqual(self.runtime.recognizer.feature_calls, 1)

        other = sqlite3.connect(self.database)
        other.execute("CREATE TABLE unrelated(value TEXT)")
        other.execute("INSERT INTO unrelated(value) VALUES('changed')")
        other.commit()
        other.close()
        self.runtime._refresh_gallery_if_needed()
        self.assertEqual(self.runtime.recognizer.feature_calls, 1)

    def test_pending_review_retention_removes_oldest_image_and_row(self) -> None:
        self.runtime.max_pending_reviews = 2
        self.runtime.review_cooldown_seconds = 0.0
        frame = np.full((30, 30, 3), 50, dtype=np.uint8)
        first = self.runtime.identify(
            frame,
            [{"track_id": 20, "bbox_xyxy": [0, 0, 30, 30]}],
            captured_at="2026-08-12T00:00:00Z",
        )
        first_path = self.runtime._connection.execute(
            "SELECT image_path FROM identity_reviews WHERE review_id=?",
            (first[20]["review_id"],),
        ).fetchone()[0]
        for track_id, captured_at in (
            (21, "2026-08-12T00:00:01Z"),
            (22, "2026-08-12T00:00:02Z"),
        ):
            self.runtime.identify(
                frame,
                [{"track_id": track_id, "bbox_xyxy": [0, 0, 30, 30]}],
                captured_at=captured_at,
            )
        self.assertEqual(
            self.runtime._connection.execute(
                "SELECT COUNT(*) FROM identity_reviews WHERE decision='pending'"
            ).fetchone()[0],
            2,
        )
        self.assertFalse((self.training / first_path).exists())

    def test_stale_new_review_can_prune_itself(self) -> None:
        self.runtime.max_pending_reviews = 1
        self.runtime.review_cooldown_seconds = 0.0
        frame = np.full((30, 30, 3), 50, dtype=np.uint8)
        recent = self.runtime.identify(
            frame,
            [{"track_id": 30, "bbox_xyxy": [0, 0, 30, 30]}],
            captured_at="2026-08-12T00:00:02Z",
        )
        stale = self.runtime.identify(
            frame,
            [{"track_id": 31, "bbox_xyxy": [0, 0, 30, 30]}],
            captured_at="2026-08-12T00:00:01Z",
        )
        self.assertIsNone(stale[31]["review_id"])
        rows = self.runtime._connection.execute(
            "SELECT review_id FROM identity_reviews"
        ).fetchall()
        self.assertEqual(rows, [(recent[30]["review_id"],)])
        self.assertNotIn(31, self.runtime._last_review_by_track)


if __name__ == "__main__":
    unittest.main()
