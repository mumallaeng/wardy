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
    parser.add_argument("--track-id", type=int, default=1)
    parser.add_argument("--timestamp-ms", type=int, default=0)
    args = parser.parse_args()
    request = {
        "frame_id": args.image.name,
        "timestamp_ms": args.timestamp_ms,
        "track_id": args.track_id,
        "bbox_xyxy": args.bbox,
        "frame_jpeg_base64": base64.b64encode(args.image.read_bytes()).decode(),
    }
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
