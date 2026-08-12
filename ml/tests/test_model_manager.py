from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from model_manager import _install_huggingface


class HuggingFaceInstallTest(unittest.TestCase):
    def setUp(self) -> None:
        self.specification = {
            "repo_id": "example/private-model",
            "revision": "v1",
            "files": {"model.onnx": "unused-in-this-test"},
            "remote_files": {"model.onnx": "remote.onnx"},
        }

    def test_private_repository_uses_read_only_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"HF_TOKEN": "test-token"}, clear=True
        ), patch("model_manager._download") as download:
            _install_huggingface(self.specification, Path(directory))

        download.assert_called_once_with(
            "https://huggingface.co/example/private-model/resolve/v1/remote.onnx?download=true",
            Path(directory) / "model.onnx",
            headers={"Authorization": "Bearer test-token"},
        )

    def test_public_repository_uses_no_authorization_header(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {}, clear=True
        ), patch("model_manager._download") as download:
            _install_huggingface(self.specification, Path(directory))

        download.assert_called_once_with(
            "https://huggingface.co/example/private-model/resolve/v1/remote.onnx?download=true",
            Path(directory) / "model.onnx",
            headers={},
        )


if __name__ == "__main__":
    unittest.main()
