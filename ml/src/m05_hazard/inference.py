from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort


CLASS_NAMES = ("scissors", "knife", "cutter", "syringe")


@dataclass(frozen=True)
class HazardResult:
    detection_id: str
    class_name: str
    confidence: float
    bbox_xyxy: tuple[float, float, float, float]

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["bbox_xyxy"] = list(self.bbox_xyxy)
        return result


class HazardDetector:
    """Run the promoted M-05 YOLO11 ONNX artifact without training packages."""

    def __init__(
        self, model_path: Path, confidence: float = 0.5, nms_iou: float = 0.45
    ) -> None:
        if not model_path.is_file():
            raise FileNotFoundError(f"M-05 model not found: {model_path}")
        if not 0.0 <= confidence <= 1.0 or not 0.0 <= nms_iou <= 1.0:
            raise ValueError("M-05 thresholds must be inside [0,1]")
        self.session = ort.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        model_input = self.session.get_inputs()[0]
        if len(model_input.shape) != 4:
            raise ValueError("M-05 model input must be NCHW")
        self.input_name = model_input.name
        self.input_height = int(model_input.shape[2])
        self.input_width = int(model_input.shape[3])
        self.confidence = confidence
        self.nms_iou = nms_iou

    def infer(self, frame_bgr: np.ndarray, frame_id: str) -> list[HazardResult]:
        if frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3 or not frame_id:
            raise ValueError("M-05 requires one HWC BGR frame and frame ID")
        tensor, scale, pad_x, pad_y = self._preprocess(frame_bgr)
        raw = np.asarray(self.session.run(None, {self.input_name: tensor})[0])
        if raw.ndim != 3 or raw.shape[0] != 1:
            raise ValueError("M-05 model returned an unsupported output shape")
        predictions = raw[0].T if raw.shape[1] == 4 + len(CLASS_NAMES) else raw[0]
        if predictions.ndim != 2 or predictions.shape[1] != 4 + len(CLASS_NAMES):
            raise ValueError("M-05 model output does not match four hazard classes")

        boxes_xywh: list[list[float]] = []
        scores: list[float] = []
        classes: list[int] = []
        for prediction in predictions:
            class_index = int(np.argmax(prediction[4:]))
            score = float(prediction[4 + class_index])
            if score < self.confidence:
                continue
            center_x, center_y, width, height = map(float, prediction[:4])
            boxes_xywh.append(
                [center_x - width / 2.0, center_y - height / 2.0, width, height]
            )
            scores.append(score)
            classes.append(class_index)

        selected: list[int] = []
        for class_index in range(len(CLASS_NAMES)):
            candidates = [i for i, value in enumerate(classes) if value == class_index]
            if not candidates:
                continue
            retained = cv2.dnn.NMSBoxes(
                [boxes_xywh[i] for i in candidates],
                [scores[i] for i in candidates],
                self.confidence,
                self.nms_iou,
            )
            selected.extend(candidates[int(index)] for index in np.asarray(retained).reshape(-1))

        frame_height, frame_width = frame_bgr.shape[:2]
        results: list[HazardResult] = []
        for output_index, index in enumerate(selected):
            x, y, width, height = boxes_xywh[index]
            x1 = float(np.clip((x - pad_x) / scale, 0, frame_width))
            y1 = float(np.clip((y - pad_y) / scale, 0, frame_height))
            x2 = float(np.clip((x + width - pad_x) / scale, 0, frame_width))
            y2 = float(np.clip((y + height - pad_y) / scale, 0, frame_height))
            if x2 <= x1 or y2 <= y1:
                continue
            results.append(
                HazardResult(
                    detection_id=f"{frame_id}:hazard:{output_index}",
                    class_name=CLASS_NAMES[classes[index]],
                    confidence=scores[index],
                    bbox_xyxy=(x1, y1, x2, y2),
                )
            )
        return results

    def _preprocess(
        self, frame_bgr: np.ndarray
    ) -> tuple[np.ndarray, float, int, int]:
        frame_height, frame_width = frame_bgr.shape[:2]
        scale = min(self.input_width / frame_width, self.input_height / frame_height)
        resized_width = max(1, int(round(frame_width * scale)))
        resized_height = max(1, int(round(frame_height * scale)))
        resized = cv2.resize(frame_bgr, (resized_width, resized_height))
        pad_x = (self.input_width - resized_width) // 2
        pad_y = (self.input_height - resized_height) // 2
        canvas = np.full((self.input_height, self.input_width, 3), 114, dtype=np.uint8)
        canvas[pad_y : pad_y + resized_height, pad_x : pad_x + resized_width] = resized
        tensor = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        return tensor.transpose(2, 0, 1)[None], scale, pad_x, pad_y
