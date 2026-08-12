from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from hub_publisher import load_manifest


class HubPublisherTest(unittest.TestCase):
    def test_manifest_artifacts_are_verified_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "model.onnx"
            artifact.write_bytes(b"wardy-model")
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "model_id": "m04_fall",
                        "version": "v1",
                        "files": {"model.onnx": digest},
                    }
                )
            )
            manifest = load_manifest(root)
            self.assertEqual(manifest["version"], "v1")

    def test_manifest_rejects_changed_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.onnx").write_bytes(b"changed")
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "model_id": "m04_fall",
                        "version": "v1",
                        "files": {"model.onnx": "0" * 64},
                    }
                )
            )
            with self.assertRaises(RuntimeError):
                load_manifest(root)


if __name__ == "__main__":
    unittest.main()
