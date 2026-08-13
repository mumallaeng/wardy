from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, patch

from hub_publisher import load_manifest, publish_model, stage_publish_tree
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

    def test_manifest_rejects_non_object_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text("[]")
            with self.assertRaisesRegex(ValueError, "invalid Wardy model manifest"):
                load_manifest(root)

    def test_manifest_rejects_artifact_outside_source_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            outside = root / "outside.onnx"
            outside.write_bytes(b"outside")
            digest = hashlib.sha256(outside.read_bytes()).hexdigest()
            (source / "manifest.json").write_text(
                json.dumps(
                    {
                        "model_id": "m03_pose",
                        "version": "v1",
                        "files": {"../outside.onnx": digest},
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, "unsafe model artifact path"):
                load_manifest(source)

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

    def test_remote_targets_reject_reserved_and_duplicate_paths(self) -> None:
        content = b"wardy-model"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            destination = root / "published"
            source.mkdir()
            (source / "one.onnx").write_bytes(content)
            (source / "two.onnx").write_bytes(content)
            base = {
                "model_id": "m03_pose",
                "version": "v1",
                "files": {"one.onnx": digest, "two.onnx": digest},
            }
            for remote_files in (
                {"one.onnx": "manifest.json", "two.onnx": "two.onnx"},
                {"one.onnx": "same.onnx", "two.onnx": "same.onnx"},
                {"one.onnx": "", "two.onnx": "two.onnx"},
            ):
                (source / "manifest.json").write_text(
                    json.dumps({**base, "remote_files": remote_files})
                )
                with self.subTest(remote_files=remote_files), self.assertRaises(
                    ValueError
                ):
                    stage_publish_tree(source, destination)

    def test_staged_artifact_is_verified_after_copy(self) -> None:
        content = b"wardy-model"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.onnx").write_bytes(content)
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "model_id": "m03_pose",
                        "version": "v1",
                        "files": {"model.onnx": digest},
                    }
                )
            )
            with patch("hub_publisher.sha256", side_effect=[digest, "0" * 64]):
                with self.assertRaisesRegex(RuntimeError, "staged model artifact"):
                    stage_publish_tree(root, root / "published")

    def test_publish_model_uses_authenticated_hub_api_without_network(self) -> None:
        content = b"wardy-model"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "model.onnx").write_bytes(content)
            (source / "manifest.json").write_text(
                json.dumps(
                    {
                        "model_id": "m03_pose",
                        "version": "v1",
                        "files": {"model.onnx": digest},
                    }
                )
            )
            api = MagicMock()
            api.whoami.return_value = {"name": "wardy-user"}
            api.upload_folder.return_value = SimpleNamespace(
                oid="commit-sha", commit_url="https://example.invalid/commit"
            )
            module = ModuleType("huggingface_hub")
            module.HfApi = MagicMock(return_value=api)  # type: ignore[attr-defined]
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                result = publish_model(
                    "wardy-user/model", source, tag="v1", private=True
                )
            self.assertEqual(result, "https://example.invalid/commit")
            api.create_repo.assert_called_once_with(
                "wardy-user/model", repo_type="model", private=True, exist_ok=True
            )
            api.upload_folder.assert_called_once()
            api.create_tag.assert_called_once_with(
                repo_id="wardy-user/model",
                repo_type="model",
                tag="v1",
                revision="commit-sha",
                tag_message="Wardy m03_pose v1",
            )

    def test_publish_model_rejects_missing_authentication(self) -> None:
        api = MagicMock()
        api.whoami.return_value = {}
        module = ModuleType("huggingface_hub")
        module.HfApi = MagicMock(return_value=api)  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, {"huggingface_hub": module}
        ):
            with self.assertRaisesRegex(RuntimeError, "authentication is required"):
                publish_model("wardy-user/model", Path(directory), tag="v1")
        api.create_repo.assert_not_called()


if __name__ == "__main__":
    unittest.main()
