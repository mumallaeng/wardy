from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import socketserver
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from m02_tracking import M02TrackingAdapter, TrackingPoseFallRuntime
from m03_pose import PersonInput, PoseEstimator
from m04_fall import FallInferenceSession, PoseFallRuntime
from m05_hazard import HazardDetector
from model_manager import DEFAULT_MODEL_ROOT, install_model


MAX_REQUEST_BYTES = 2 * 1024 * 1024


def decode_frame(payload: dict[str, Any]) -> np.ndarray:
    required = ("frame_id", "timestamp_ms", "frame_jpeg_base64")
    if any(key not in payload for key in required):
        raise ValueError(
            "request requires frame_id, timestamp_ms, and frame_jpeg_base64"
        )
    image_bytes = base64.b64decode(payload["frame_jpeg_base64"], validate=True)
    frame = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("unable to decode frame JPEG")
    return frame


def decode_tracked_person(payload: dict[str, Any]) -> PersonInput:
    if "track_id" not in payload or "bbox_xyxy" not in payload:
        raise ValueError("tracked request requires track_id and bbox_xyxy")
    return PersonInput(
        frame_id=str(payload["frame_id"]),
        timestamp_ms=int(payload["timestamp_ms"]),
        track_id=int(payload["track_id"]),
        bbox_xyxy=np.asarray(payload["bbox_xyxy"], dtype=np.float32),
    )


def process_request(
    payload: dict[str, Any], runtime: TrackingPoseFallRuntime,
    hazard_detector: HazardDetector | None = None,
) -> dict[str, Any]:
    frame = decode_frame(payload)
    if "person_detections" in payload:
        person_detections = payload["person_detections"]
        if not isinstance(person_detections, list):
            raise ValueError("person_detections must be a list")
        reset_tracking = payload.get("reset_tracking", False)
        if not isinstance(reset_tracking, bool):
            raise ValueError("reset_tracking must be a boolean")
        if reset_tracking:
            runtime.reset()
        result = runtime.process_frame(
            frame,
            frame_id=str(payload["frame_id"]),
            timestamp_ms=int(payload["timestamp_ms"]),
            person_detections=person_detections,
        )
        hazards = [] if hazard_detector is None else [
            detection.to_dict()
            for detection in hazard_detector.infer(frame, str(payload["frame_id"]))
        ]
        return {"ok": True, **result, "hazards": hazards}

    # Keep the already-tracked request contract during the M-01 transition.
    person = decode_tracked_person(payload)
    return {"ok": True, **runtime.process_tracked_person(frame, person).to_dict()}


class PoseFallRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        line = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if len(line) > MAX_REQUEST_BYTES:
            response = {"ok": False, "error": "request too large"}
        else:
            try:
                payload = json.loads(line)
                response = process_request(
                    payload,
                    self.server.runtime,  # type: ignore[attr-defined]
                    self.server.hazard_detector,  # type: ignore[attr-defined]
                )
            except Exception as error:
                response = {"ok": False, "error": str(error)}
        self.wfile.write(
            (json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n").encode()
        )


class PoseFallServer(socketserver.UnixStreamServer):
    allow_reuse_address = True

    def __init__(self, socket_path: Path, runtime: TrackingPoseFallRuntime,
                 hazard_detector: HazardDetector | None = None):
        self.runtime = runtime
        self.hazard_detector = hazard_detector
        super().__init__(str(socket_path), PoseFallRequestHandler)
        os.chmod(socket_path, 0o600)


def build_runtime(model_root: Path) -> TrackingPoseFallRuntime:
    m03 = install_model("m03_pose", model_root=model_root)
    m04 = install_model("m04_fall", model_root=model_root)
    pose_fall = PoseFallRuntime(
        PoseEstimator(m03 / "model.onnx"),
        FallInferenceSession(m04 / "model.onnx", m04 / "metadata.json"),
    )
    return TrackingPoseFallRuntime(M02TrackingAdapter(), pose_fall)


def main() -> int:
    parser = argparse.ArgumentParser(prog="wardy-pose-fall-worker")
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument(
        "--model-root",
        type=Path,
        default=Path(os.environ.get("WARDY_MODEL_ROOT", DEFAULT_MODEL_ROOT)),
    )
    parser.add_argument("--hazard-model", type=Path)
    parser.add_argument("--hazard-confidence", type=float, default=0.5)
    args = parser.parse_args()
    if args.socket.parent.exists():
        if not args.socket.parent.is_dir():
            raise NotADirectoryError(args.socket.parent)
    else:
        args.socket.parent.mkdir(parents=True, mode=0o700)
    args.socket.unlink(missing_ok=True)
    runtime = build_runtime(args.model_root)
    hazard_detector = None if args.hazard_model is None else HazardDetector(
        args.hazard_model, args.hazard_confidence
    )
    with PoseFallServer(args.socket, runtime, hazard_detector) as server:

        def stop_server(_signal: int, _frame: object) -> None:
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop_server)
        signal.signal(signal.SIGINT, stop_server)
        print(json.dumps({"ready": True, "socket": str(args.socket)}), flush=True)
        server.serve_forever(poll_interval=0.2)
    args.socket.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
