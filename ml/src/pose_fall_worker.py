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

from m03_pose import PersonInput, PoseEstimator
from m04_fall import FallInferenceSession, PoseFallRuntime
from model_manager import DEFAULT_MODEL_ROOT, install_model


MAX_REQUEST_BYTES = 2 * 1024 * 1024


def decode_request(payload: dict[str, Any]) -> tuple[np.ndarray, PersonInput]:
    required = (
        "frame_id",
        "timestamp_ms",
        "track_id",
        "bbox_xyxy",
        "frame_jpeg_base64",
    )
    if any(key not in payload for key in required):
        raise ValueError(
            "request requires frame_id, timestamp_ms, track_id, bbox_xyxy, and frame_jpeg_base64"
        )
    image_bytes = base64.b64decode(payload["frame_jpeg_base64"], validate=True)
    frame = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("unable to decode frame JPEG")
    return frame, PersonInput(
        frame_id=str(payload["frame_id"]),
        timestamp_ms=int(payload["timestamp_ms"]),
        track_id=int(payload["track_id"]),
        bbox_xyxy=np.asarray(payload["bbox_xyxy"], dtype=np.float32),
    )


class PoseFallRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        line = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if len(line) > MAX_REQUEST_BYTES:
            response = {"ok": False, "error": "request too large"}
        else:
            try:
                frame, person = decode_request(json.loads(line))
                result = self.server.runtime.process(frame, person)  # type: ignore[attr-defined]
                response = {"ok": True, **result.to_dict()}
            except Exception as error:
                response = {"ok": False, "error": str(error)}
        self.wfile.write(
            (json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n").encode()
        )


class PoseFallServer(socketserver.UnixStreamServer):
    allow_reuse_address = True

    def __init__(self, socket_path: Path, runtime: PoseFallRuntime):
        self.runtime = runtime
        super().__init__(str(socket_path), PoseFallRequestHandler)
        os.chmod(socket_path, 0o600)


def build_runtime(model_root: Path) -> PoseFallRuntime:
    m03 = install_model("m03_pose", model_root=model_root)
    m04 = install_model("m04_fall", model_root=model_root)
    return PoseFallRuntime(
        PoseEstimator(m03 / "model.onnx"),
        FallInferenceSession(m04 / "model.onnx", m04 / "metadata.json"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(prog="wardy-pose-fall-worker")
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument(
        "--model-root",
        type=Path,
        default=Path(os.environ.get("WARDY_MODEL_ROOT", DEFAULT_MODEL_ROOT)),
    )
    args = parser.parse_args()
    if args.socket.parent.exists():
        if not args.socket.parent.is_dir():
            raise NotADirectoryError(args.socket.parent)
    else:
        args.socket.parent.mkdir(parents=True, mode=0o700)
    args.socket.unlink(missing_ok=True)
    runtime = build_runtime(args.model_root)
    with PoseFallServer(args.socket, runtime) as server:

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
