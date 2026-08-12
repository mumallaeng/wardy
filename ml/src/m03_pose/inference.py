from __future__ import annotations

from pathlib import Path
from typing import Sequence

import numpy as np
import onnxruntime as ort

from .contract import PersonInput, PoseResult
from .preprocess import decode_simcc, preprocess_pose


def default_providers() -> list[str]:
    available = set(ort.get_available_providers())
    for accelerated in (
        "TensorrtExecutionProvider",
        "CUDAExecutionProvider",
        "CoreMLExecutionProvider",
    ):
        if accelerated in available:
            return [accelerated, "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


class PoseEstimator:
    def __init__(self, model_path: Path, providers: Sequence[str] | None = None):
        if not model_path.is_file():
            raise FileNotFoundError(model_path)
        self.session = ort.InferenceSession(
            str(model_path), providers=list(providers or default_providers())
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_names = [output.name for output in self.session.get_outputs()]
        if len(self.output_names) != 2:
            raise ValueError("RTMPose model must expose SimCC x and y outputs")

    def infer(self, frame_bgr: np.ndarray, person: PersonInput) -> PoseResult:
        tensor, center, scale = preprocess_pose(frame_bgr, person.bbox_xyxy)
        simcc_x, simcc_y = self.session.run(
            self.output_names, {self.input_name: tensor}
        )
        keypoints = decode_simcc(simcc_x, simcc_y, center, scale)[0]
        return PoseResult(
            frame_id=person.frame_id,
            timestamp_ms=person.timestamp_ms,
            track_id=person.track_id,
            bbox_xyxy=person.bbox_xyxy,
            keypoints_xyc=keypoints,
            pose_quality=float(keypoints[:, 2].mean()),
        )
