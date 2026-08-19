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
    def setInputSize(self, _size: tuple[int, int]) -> None:
        pass

    def detect(self, _image: np.ndarray) -> tuple[None, np.ndarray]:
        return None, np.array([[2, 2, 12, 12, 3, 5, 10, 5, 6, 9, 4, 12, 10, 12, 0.99]])


class _Recognizer:
    def alignCrop(self, image: np.ndarray, _face: np.ndarray) -> np.ndarray:
        return image

    def feature(self, image: np.ndarray) -> np.ndarray:
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


if __name__ == "__main__":
    unittest.main()
