"""Publish one verified Wardy model version to Hugging Face Hub."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any

from model_manager import sha256


def _artifact_path(source_dir: Path, filename: str) -> Path:
    if not isinstance(filename, str):
        raise ValueError("model artifact path must be a string")
    logical_path = PurePosixPath(filename)
    if (
        not logical_path.parts
        or logical_path.is_absolute()
        or ".." in logical_path.parts
    ):
        raise ValueError(f"unsafe model artifact path: {filename}")
    source_root = source_dir.resolve()
    path = source_root.joinpath(*logical_path.parts).resolve()
    if path == source_root or source_root not in path.parents:
        raise ValueError(f"unsafe model artifact path: {filename}")
    return path


def load_manifest(source_dir: Path) -> dict[str, Any]:
    manifest_path = source_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if (
        not isinstance(manifest, dict)
        or not isinstance(manifest.get("model_id"), str)
        or not isinstance(manifest.get("version"), str)
        or not isinstance(manifest.get("files"), dict)
        or not manifest["files"]
    ):
        raise ValueError("invalid Wardy model manifest")
    for filename, expected in manifest["files"].items():
        path = _artifact_path(source_dir, filename)
        if not path.is_file() or sha256(path) != expected:
            raise RuntimeError(f"model artifact verification failed: {filename}")
    return manifest


def stage_publish_tree(source_dir: Path, destination: Path) -> dict[str, Any]:
    """Stage verified artifacts at the exact repository paths installers use."""
    manifest = load_manifest(source_dir)
    remote_files = manifest.get("remote_files", {})
    if not isinstance(remote_files, dict):
        raise ValueError("invalid remote_files metadata")
    seen_remote_names: set[str] = set()
    for filename in manifest["files"]:
        remote_name = remote_files.get(filename, filename)
        if not isinstance(remote_name, str):
            raise ValueError(f"invalid remote artifact path: {remote_name}")
        remote_path = PurePosixPath(remote_name)
        normalized_remote_name = remote_path.as_posix()
        if (
            not remote_path.parts
            or remote_path.is_absolute()
            or ".." in remote_path.parts
            or normalized_remote_name == "manifest.json"
            or normalized_remote_name in seen_remote_names
        ):
            raise ValueError(f"unsafe remote artifact path: {remote_name}")
        seen_remote_names.add(normalized_remote_name)
        target = destination.joinpath(*remote_path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_artifact_path(source_dir, filename), target)
        if sha256(target) != manifest["files"][filename]:
            raise RuntimeError(f"staged model artifact verification failed: {filename}")
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    return manifest


def publish_model(
    repo_id: str,
    source_dir: Path,
    *,
    tag: str,
    private: bool = False,
) -> str:
    from huggingface_hub import HfApi

    api = HfApi()
    identity = api.whoami()
    if not identity.get("name"):
        raise RuntimeError("Hugging Face CLI authentication is required")
    api.create_repo(repo_id, repo_type="model", private=private, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="wardy-hub-publish-") as directory:
        publish_root = Path(directory)
        manifest = stage_publish_tree(source_dir, publish_root)
        commit = api.upload_folder(
            repo_id=repo_id,
            repo_type="model",
            folder_path=publish_root,
            commit_message=f"Release {manifest['model_id']} {manifest['version']}",
        )
    api.create_tag(
        repo_id=repo_id,
        repo_type="model",
        tag=tag,
        revision=commit.oid,
        tag_message=f"Wardy {manifest['model_id']} {manifest['version']}",
    )
    return commit.commit_url


def main() -> int:
    parser = argparse.ArgumentParser(prog="wardy-hub-publish")
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--private", action="store_true")
    args = parser.parse_args()
    print(
        publish_model(
            args.repo_id,
            args.source_dir.resolve(),
            tag=args.tag,
            private=args.private,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
