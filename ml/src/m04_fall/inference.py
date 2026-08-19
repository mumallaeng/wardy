from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import onnxruntime as ort

from .features import FEATURE_NAMES


@dataclass(frozen=True)
class FallResult:
    track_id: int
    timestamp_ms: int
    fall_suspected: bool
    confidence: float
    threshold: float
    model_name: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "track_id": self.track_id,
            "timestamp_ms": self.timestamp_ms,
            "fall_suspected": self.fall_suspected,
            "confidence": self.confidence,
            "threshold": self.threshold,
            "model": self.model_name,
        }


class FallInferenceSession:
    def __init__(
        self,
        model_path: Path,
        metadata_path: Path,
        providers: Sequence[str] | None = None,
    ):
        if not model_path.is_file() or not metadata_path.is_file():
            raise FileNotFoundError(f"M-04 artifact is incomplete: {model_path.parent}")
        self.metadata = json.loads(metadata_path.read_text())
        self.expected_shape = tuple(
            int(value) for value in self.metadata["input_shape"][1:]
        )
        if tuple(self.metadata["feature_names"]) != FEATURE_NAMES:
            raise ValueError("M-04 metadata feature order differs from runtime")
        self.mean = np.asarray(self.metadata["feature_mean"], dtype=np.float32)[
            None, None, :
        ]
        self.std = np.asarray(self.metadata["feature_std"], dtype=np.float32)[
            None, None, :
        ]
        if np.any(self.std <= 0) or self.mean.shape[-1] != self.expected_shape[1]:
            raise ValueError("invalid M-04 standardization metadata")
        selected = list(
            providers
            or (
                ["CUDAExecutionProvider", "CPUExecutionProvider"]
                if "CUDAExecutionProvider" in ort.get_available_providers()
                else ["CPUExecutionProvider"]
            )
        )
        self.session = ort.InferenceSession(str(model_path), providers=selected)
        self.input_name = self.metadata["input_name"]
        self.output_name = self.metadata["output_name"]
        self.threshold = float(self.metadata["decision_threshold"])

    @property
    def window_frames(self) -> int:
        return self.expected_shape[0]

    @property
    def target_fps(self) -> float:
        return float(self.metadata["target_fps"])

    def predict(
        self, raw_features: np.ndarray, track_id: int, timestamp_ms: int
    ) -> FallResult:
        if raw_features.shape != self.expected_shape:
            raise ValueError(
                f"expected M-04 features {self.expected_shape}, received {raw_features.shape}"
            )
        standardized = (
            (raw_features[None].astype(np.float32) - self.mean) / self.std
        ).astype(np.float32)
        logit = float(
            self.session.run([self.output_name], {self.input_name: standardized})[0][0]
        )
        confidence = float(1.0 / (1.0 + np.exp(-np.clip(logit, -80.0, 80.0))))
        return FallResult(
            track_id=track_id,
            timestamp_ms=timestamp_ms,
            fall_suspected=confidence >= self.threshold,
            confidence=confidence,
            threshold=self.threshold,
            model_name=str(self.metadata["model_name"]),
        )
