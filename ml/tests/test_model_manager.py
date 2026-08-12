from __future__ import annotations

import os
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

from model_manager import (
    _SameHostAuthorizationRedirectHandler,
    _install_direct_files,
    _install_huggingface,
)


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

    def test_direct_files_download_each_pinned_destination(self) -> None:
        specification = {
            "files": {"model.onnx": "unused-in-this-test"},
            "urls": {"model.onnx": "https://example.test/model.onnx"},
        }
        with tempfile.TemporaryDirectory() as directory, patch(
            "model_manager._download"
        ) as download:
            _install_direct_files(specification, Path(directory))
        download.assert_called_once_with(
            "https://example.test/model.onnx", Path(directory) / "model.onnx"
        )

    def test_cross_host_redirect_removes_authorization_only(self) -> None:
        request = urllib.request.Request(
            "https://huggingface.co/example/model",
            headers={
                "Authorization": "Bearer test-token",
                "User-Agent": "wardy-model-manager/1",
            },
        )
        redirected = _SameHostAuthorizationRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://cdn.example.test/model",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertIsNone(redirected.get_header("Authorization"))
        self.assertEqual(
            redirected.get_header("User-agent"), "wardy-model-manager/1"
        )

    def test_same_host_redirect_preserves_authorization(self) -> None:
        request = urllib.request.Request(
            "https://huggingface.co/example/model",
            headers={"Authorization": "Bearer test-token"},
        )
        redirected = _SameHostAuthorizationRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://huggingface.co/example/model?download=true",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertEqual(
            redirected.get_header("Authorization"), "Bearer test-token"
        )

    def test_https_to_http_redirect_removes_authorization(self) -> None:
        request = urllib.request.Request(
            "https://huggingface.co/example/model",
            headers={"Authorization": "Bearer test-token"},
        )
        redirected = _SameHostAuthorizationRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "http://huggingface.co/example/model",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertIsNone(redirected.get_header("Authorization"))

    def test_same_host_port_change_removes_authorization(self) -> None:
        request = urllib.request.Request(
            "https://huggingface.co/example/model",
            headers={"Authorization": "Bearer test-token"},
        )
        redirected = _SameHostAuthorizationRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://huggingface.co:8443/example/model",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertIsNone(redirected.get_header("Authorization"))

    def test_explicit_port_zero_removes_authorization(self) -> None:
        request = urllib.request.Request(
            "https://huggingface.co/example/model",
            headers={"Authorization": "Bearer test-token"},
        )
        redirected = _SameHostAuthorizationRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://huggingface.co:0/example/model",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertIsNone(redirected.get_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
