from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dataset_manager import install_dataset, verify_install


class DatasetManagerTest(unittest.TestCase):
    def test_huggingface_dataset_is_downloaded_and_verified(self) -> None:
        content = b"wardy-dataset"
        digest = hashlib.sha256(content).hexdigest()
        registry = {
            "schema_version": 1,
            "datasets": {
                "m05_hazard": {
                    "default_version": "commit-1",
                    "versions": {
                        "commit-1": {
                            "source": "huggingface",
                            "repo_id": "example/hazard",
                            "revision": "commit-1",
                            "files": {"dataset.zip": digest},
                            "remote_files": {"dataset.zip": "archive.zip"},
                        }
                    },
                }
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry_path = root / "registry.json"
            registry_path.write_text(json.dumps(registry))

            def download(url: str, destination: Path, **_: object) -> None:
                self.assertEqual(
                    url,
                    "https://huggingface.co/datasets/example/hazard/resolve/"
                    "commit-1/archive.zip?download=true",
                )
                destination.write_bytes(content)

            with patch("dataset_manager.download_file", side_effect=download):
                installed = install_dataset(
                    "m05_hazard",
                    dataset_root=root / "datasets",
                    registry_path=registry_path,
                )
            specification = registry["datasets"]["m05_hazard"]["versions"][
                "commit-1"
            ]
            self.assertTrue(verify_install(installed, specification))
            manifest = json.loads((installed / "manifest.json").read_text())
            self.assertEqual(manifest["revision"], "commit-1")

    def test_hash_mismatch_does_not_promote_staging_directory(self) -> None:
        registry = {
            "schema_version": 1,
            "datasets": {
                "m05_hazard": {
                    "default_version": "commit-1",
                    "versions": {
                        "commit-1": {
                            "source": "huggingface",
                            "repo_id": "example/hazard",
                            "revision": "commit-1",
                            "files": {"dataset.zip": "0" * 64},
                        }
                    },
                }
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry_path = root / "registry.json"
            registry_path.write_text(json.dumps(registry))
            with patch(
                "dataset_manager.download_file",
                side_effect=lambda _url, destination: destination.write_bytes(b"bad"),
            ), self.assertRaises(RuntimeError):
                install_dataset(
                    "m05_hazard",
                    dataset_root=root / "datasets",
                    registry_path=registry_path,
                )
            self.assertFalse((root / "datasets" / "m05_hazard" / "commit-1").exists())


if __name__ == "__main__":
    unittest.main()
