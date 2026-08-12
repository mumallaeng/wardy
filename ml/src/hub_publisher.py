"""Publish one verified Wardy model version to Hugging Face Hub."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from model_manager import sha256


def load_manifest(source_dir: Path) -> dict[str, Any]:
    manifest_path = source_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if (
        not isinstance(manifest.get("model_id"), str)
        or not isinstance(manifest.get("version"), str)
        or not isinstance(manifest.get("files"), dict)
        or not manifest["files"]
    ):
        raise ValueError("invalid Wardy model manifest")
    for filename, expected in manifest["files"].items():
        path = source_dir / filename
        if not path.is_file() or sha256(path) != expected:
            raise RuntimeError(f"model artifact verification failed: {filename}")
    return manifest


def publish_model(
    repo_id: str,
    source_dir: Path,
    *,
    tag: str,
    private: bool = False,
) -> str:
    from huggingface_hub import HfApi

    manifest = load_manifest(source_dir)
    destination = f"{manifest['model_id']}/{manifest['version']}"
    api = HfApi()
    identity = api.whoami()
    if not identity.get("name"):
        raise RuntimeError("Hugging Face CLI authentication is required")
    api.create_repo(repo_id, repo_type="model", private=private, exist_ok=True)
    commit = api.upload_folder(
        repo_id=repo_id,
        repo_type="model",
        folder_path=source_dir,
        path_in_repo=destination,
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
