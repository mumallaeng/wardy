from __future__ import annotations

import argparse
import base64
import json
import socket
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--bbox", type=float, nargs=4, required=True)
    parser.add_argument("--confidence", type=float, default=0.9)
    parser.add_argument("--track-id", type=int)
    parser.add_argument("--timestamp-ms", type=int, default=0)
    parser.add_argument("--reset-tracking", action="store_true")
    args = parser.parse_args()
    request: dict = {
        "frame_id": args.image.name,
        "timestamp_ms": args.timestamp_ms,
        "frame_jpeg_base64": base64.b64encode(args.image.read_bytes()).decode(),
    }
    if args.track_id is None:
        request["person_detections"] = [
            {"bbox_xyxy": args.bbox, "confidence": args.confidence}
        ]
        request["reset_tracking"] = args.reset_tracking
    else:
        # Temporary compatibility path for already-tracked M-01/M-02 callers.
        request["track_id"] = args.track_id
        request["bbox_xyxy"] = args.bbox
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(args.socket))
        client.sendall((json.dumps(request) + "\n").encode())
        response = b""
        while not response.endswith(b"\n"):
            chunk = client.recv(65536)
            if not chunk:
                break
            response += chunk
    result = json.loads(response)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
