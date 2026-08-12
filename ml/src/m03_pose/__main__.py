from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from model_manager import DEFAULT_MODEL_ROOT, install_model

from .contract import PersonInput
from .inference import PoseEstimator


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m m03_pose")
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument(
        "--bbox", type=float, nargs=4, required=True, metavar=("X1", "Y1", "X2", "Y2")
    )
    parser.add_argument("--track-id", type=int, default=1)
    parser.add_argument("--timestamp-ms", type=int, default=0)
    parser.add_argument("--model-root", type=Path, default=DEFAULT_MODEL_ROOT)
    args = parser.parse_args()
    model_dir = install_model("m03_pose", model_root=args.model_root)
    frame = cv2.imread(str(args.image))
    if frame is None:
        raise RuntimeError(f"unable to read image: {args.image}")
    result = PoseEstimator(model_dir / "model.onnx").infer(
        frame,
        PersonInput(
            frame_id=args.image.name,
            timestamp_ms=args.timestamp_ms,
            track_id=args.track_id,
            bbox_xyxy=np.asarray(args.bbox, dtype=np.float32),
        ),
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
