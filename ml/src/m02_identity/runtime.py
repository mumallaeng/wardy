"""YuNet/SFace identity matching backed by Wardy's local SQLite data."""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import cv2
import numpy as np


@dataclass(frozen=True)
class _Subject:
    subject_id: str
    name: str
    role: str


@dataclass(frozen=True)
class _GalleryFeature:
    subject: _Subject
    feature: np.ndarray


class RegisteredSubjectIdentifier:
    """Identify tracked people against references that remain on the Jetson."""

    def __init__(
        self,
        detector_model: Path,
        recognizer_model: Path,
        database_path: Path,
        training_data_path: Path,
        *,
        match_threshold: float = 0.45,
        review_threshold: float = 0.30,
        review_cooldown_seconds: float = 30.0,
        refresh_seconds: float = 2.0,
        max_pending_reviews: int = 200,
    ) -> None:
        if not 0.0 <= review_threshold < match_threshold <= 1.0:
            raise ValueError("identity thresholds must satisfy 0 <= review < match <= 1")
        if max_pending_reviews <= 0:
            raise ValueError("max_pending_reviews must be positive")
        self.database_path = database_path
        self.training_data_path = training_data_path.resolve()
        self.match_threshold = match_threshold
        self.review_threshold = review_threshold
        self.review_cooldown_seconds = review_cooldown_seconds
        self.refresh_seconds = refresh_seconds
        self.max_pending_reviews = max_pending_reviews
        self.detector = cv2.FaceDetectorYN.create(
            str(detector_model), "", (320, 320), 0.8, 0.3, 5000
        )
        self.recognizer = cv2.FaceRecognizerSF.create(str(recognizer_model), "")
        self._connection = sqlite3.connect(database_path, timeout=5.0)
        self._connection.execute("PRAGMA busy_timeout=5000")
        self._gallery: list[_GalleryFeature] = []
        self._feature_cache: dict[Path, tuple[int, int, np.ndarray]] = {}
        self._data_version = -1
        self._last_refresh = 0.0
        self._last_review_by_track: dict[int, float] = {}

    def close(self) -> None:
        self._connection.close()

    def reset(self) -> None:
        self._last_review_by_track.clear()

    def retain_tracks(self, active_track_ids: Iterable[int]) -> None:
        active = set(active_track_ids)
        self._last_review_by_track = {
            track_id: timestamp
            for track_id, timestamp in self._last_review_by_track.items()
            if track_id in active
        }

    def identify(
        self,
        frame_bgr: np.ndarray,
        persons: Iterable[Mapping[str, Any]],
        *,
        captured_at: str,
    ) -> dict[int, dict[str, Any]]:
        self._refresh_gallery_if_needed()
        results: dict[int, dict[str, Any]] = {}
        for person in persons:
            track_id = int(person["track_id"])
            try:
                crop, _offset = self._person_crop(frame_bgr, person["bbox_xyxy"])
                face = self._largest_face(crop)
                if face is None:
                    results[track_id] = {"status": "no_face"}
                    continue
                feature = self._feature(crop, face)
                best = self._best_match(feature)
            except Exception:
                results[track_id] = {"status": "no_face"}
                continue
            confidence = None if best is None else best[1]
            if best is not None and best[1] >= self.match_threshold:
                subject = best[0].subject
                results[track_id] = {
                    "status": "registered",
                    "subject_id": subject.subject_id,
                    "subject_name": subject.name,
                    "subject_role": subject.role,
                    "confidence": best[1],
                }
                continue

            predicted_name = (
                best[0].subject.name
                if best is not None and best[1] >= self.review_threshold
                else None
            )
            review_id = self._create_review_if_due(
                frame_bgr,
                track_id,
                person["bbox_xyxy"],
                captured_at,
                predicted_name,
                confidence,
            )
            results[track_id] = {
                "status": "uncertain" if predicted_name else "unknown",
                "confidence": confidence,
                "review_id": review_id,
            }
        return results

    def _refresh_gallery_if_needed(self) -> None:
        now = time.monotonic()
        if now - self._last_refresh < self.refresh_seconds:
            return
        self._last_refresh = now
        version = int(self._connection.execute("PRAGMA data_version").fetchone()[0])
        if version == self._data_version:
            return
        self._data_version = version
        gallery: list[_GalleryFeature] = []
        current_paths: set[Path] = set()
        rows = self._connection.execute(
            """
            SELECT s.subject_id,s.name,s.role,r.image_path
            FROM subjects s
            JOIN subject_reference_samples r ON r.subject_id=s.subject_id
            UNION ALL
            SELECT s.subject_id,s.name,s.role,i.image_path
            FROM subjects s
            JOIN identity_reviews i ON i.subject_id=s.subject_id
            WHERE i.decision='subject'
            """
        ).fetchall()
        for subject_id, name, role, relative_path in rows:
            image_path = self._stored_path(str(relative_path))
            if image_path is None:
                continue
            current_paths.add(image_path)
            try:
                stat = image_path.stat()
                cached = self._feature_cache.get(image_path)
                if cached is not None and cached[:2] == (
                    stat.st_mtime_ns,
                    stat.st_size,
                ):
                    feature = cached[2]
                else:
                    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
                    if image is None:
                        continue
                    face = self._largest_face(image)
                    if face is None:
                        continue
                    feature = self._feature(image, face)
                    self._feature_cache[image_path] = (
                        stat.st_mtime_ns,
                        stat.st_size,
                        feature,
                    )
            except (OSError, ValueError, cv2.error):
                continue
            gallery.append(
                _GalleryFeature(
                    _Subject(str(subject_id), str(name), str(role)),
                    feature,
                )
            )
        self._feature_cache = {
            path: cached
            for path, cached in self._feature_cache.items()
            if path in current_paths
        }
        self._gallery = gallery

    def _stored_path(self, relative_path: str) -> Path | None:
        candidate = (self.training_data_path / relative_path).resolve()
        if candidate == self.training_data_path or self.training_data_path not in candidate.parents:
            return None
        return candidate if candidate.is_file() else None

    @staticmethod
    def _person_crop(
        frame: np.ndarray, bbox_xyxy: Iterable[float]
    ) -> tuple[np.ndarray, tuple[int, int]]:
        height, width = frame.shape[:2]
        x1, y1, x2, y2 = [float(value) for value in bbox_xyxy]
        padding_x = max(8, int((x2 - x1) * 0.08))
        padding_y = max(8, int((y2 - y1) * 0.08))
        left = max(0, int(x1) - padding_x)
        top = max(0, int(y1) - padding_y)
        right = min(width, int(np.ceil(x2)) + padding_x)
        bottom = min(height, int(np.ceil(y2)) + padding_y)
        if right <= left or bottom <= top:
            raise ValueError("tracked person bbox is outside the frame")
        return frame[top:bottom, left:right], (left, top)

    def _largest_face(self, image: np.ndarray) -> np.ndarray | None:
        if image.size == 0:
            return None
        height, width = image.shape[:2]
        self.detector.setInputSize((width, height))
        _result, faces = self.detector.detect(image)
        if faces is None or len(faces) == 0:
            return None
        return max(faces, key=lambda item: float(item[2] * item[3]))

    def _feature(self, image: np.ndarray, face: np.ndarray) -> np.ndarray:
        aligned = self.recognizer.alignCrop(image, face)
        return self.recognizer.feature(aligned).copy()

    def _best_match(
        self, feature: np.ndarray
    ) -> tuple[_GalleryFeature, float] | None:
        best: tuple[_GalleryFeature, float] | None = None
        for candidate in self._gallery:
            score = float(
                self.recognizer.match(
                    feature, candidate.feature, cv2.FaceRecognizerSF_FR_COSINE
                )
            )
            if best is None or score > best[1]:
                best = (candidate, score)
        return best

    def _create_review_if_due(
        self,
        frame: np.ndarray,
        track_id: int,
        bbox_xyxy: Iterable[float],
        captured_at: str,
        predicted_name: str | None,
        confidence: float | None,
    ) -> str | None:
        now = time.monotonic()
        previous = self._last_review_by_track.get(track_id)
        if previous is not None and now - previous < self.review_cooldown_seconds:
            return None
        crop, _offset = self._person_crop(frame, bbox_xyxy)
        review_id = f"identity-{uuid.uuid4().hex}"
        relative_path = Path("identity") / "reviews" / f"{review_id}.jpg"
        absolute_path = self.training_data_path / relative_path
        absolute_path.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(absolute_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            raise RuntimeError("unable to save identity review image")
        pruned_rows: list[tuple[str, str]] = []
        try:
            with self._connection:
                self._connection.execute(
                    """
                    INSERT INTO identity_reviews(
                      review_id,image_path,captured_at,predicted_name,confidence,
                      decision,subject_id,updated_at
                    ) VALUES(?,?,?,?,?,'pending',NULL,?)
                    """,
                    (
                        review_id,
                        relative_path.as_posix(),
                        captured_at,
                        predicted_name,
                        confidence,
                        captured_at,
                    ),
                )
                pruned_rows = [
                    (str(stored_review_id), str(stored_image_path))
                    for stored_review_id, stored_image_path
                    in self._connection.execute(
                        """
                        SELECT review_id,image_path FROM identity_reviews
                        WHERE decision='pending'
                        ORDER BY julianday(captured_at) DESC,captured_at DESC,
                                 review_id DESC
                        LIMIT -1 OFFSET ?
                        """,
                        (self.max_pending_reviews,),
                    ).fetchall()
                ]
                self._connection.executemany(
                    "DELETE FROM identity_reviews WHERE review_id=?",
                    ((stored_review_id,) for stored_review_id, _path in pruned_rows),
                )
        except Exception:
            absolute_path.unlink(missing_ok=True)
            raise
        for _stored_review_id, stored_image_path in pruned_rows:
            self._delete_stored_image(stored_image_path)
        if any(stored_review_id == review_id for stored_review_id, _path in pruned_rows):
            return None
        self._last_review_by_track[track_id] = now
        return review_id

    def _delete_stored_image(self, relative_path: str) -> None:
        image_path = self._stored_path(relative_path)
        if image_path is None:
            return
        try:
            image_path.unlink(missing_ok=True)
        except OSError:
            pass
