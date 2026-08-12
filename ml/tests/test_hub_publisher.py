from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from hub_publisher import load_manifest, stage_publish_tree
from model_manager import install_model


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

    def test_staged_publish_layout_can_be_installed_and_verified(self) -> None:
        content = b"wardy-published-model"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            published = root / "published"
            source.mkdir()
            published.mkdir()
            (source / "model.onnx").write_bytes(content)
            (source / "manifest.json").write_text(
                json.dumps(
                    {
                        "model_id": "m03_pose",
                        "version": "v1",
                        "files": {"model.onnx": digest},
                        "remote_files": {"model.onnx": "artifacts/model.onnx"},
                    }
                )
            )
            stage_publish_tree(source, published)
            self.assertEqual(
                (published / "artifacts/model.onnx").read_bytes(), content
            )

            registry = root / "registry.json"
            registry.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "models": {
                            "m03_pose": {
                                "default_version": "v1",
                                "versions": {
                                    "v1": {
                                        "source": "huggingface",
                                        "repo_id": "example/model",
                                        "revision": "v1",
                                        "files": {"model.onnx": digest},
                                        "remote_files": {
                                            "model.onnx": "artifacts/model.onnx"
                                        },
                                    }
                                },
                            }
                        },
                    }
                )
            )
            installed = install_model(
                "m03_pose",
                model_root=root / "models",
                registry_path=registry,
                source_dir=published,
            )
            self.assertEqual((installed / "model.onnx").read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
