from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRY = PROJECT_ROOT / "ml" / "config" / "model-registry.json"
DEFAULT_MODEL_ROOT = PROJECT_ROOT / "ml" / "checkpoints" / "models"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_registry(path: Path = DEFAULT_REGISTRY) -> dict[str, Any]:
    registry = json.loads(path.read_text())
    if registry.get("schema_version") != 1 or not isinstance(
        registry.get("models"), dict
    ):
        raise ValueError("unsupported Wardy model registry")
    return registry


def resolve_version(
    registry: dict[str, Any], model_id: str, version: str | None
) -> tuple[str, dict[str, Any]]:
    try:
        model = registry["models"][model_id]
        selected = version or model["default_version"]
        return selected, model["versions"][selected]
    except KeyError as error:
        raise ValueError(
            f"unknown model/version: {model_id}:{version or 'default'}"
        ) from error


def model_directory(model_root: Path, model_id: str, version: str) -> Path:
    return model_root / model_id / version


def verify_install(destination: Path, specification: dict[str, Any]) -> bool:
    return all(
        (destination / filename).is_file()
        and sha256(destination / filename) == expected
        for filename, expected in specification["files"].items()
    )


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(
        url, headers={"User-Agent": "wardy-model-manager/1"}
    )
    with (
        urllib.request.urlopen(request, timeout=60) as response,
        destination.open("wb") as output,
    ):
        shutil.copyfileobj(response, output)


def _copy_verified(source: Path, destination: Path, expected_sha256: str) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    if sha256(source) != expected_sha256:
        raise RuntimeError(f"SHA-256 mismatch: {source}")
    shutil.copy2(source, destination)


def _install_from_directory(
    source_dir: Path, staging: Path, specification: dict[str, Any]
) -> None:
    remote_files = specification.get("remote_files", {})
    for destination_name, expected_hash in specification["files"].items():
        source_name = remote_files.get(destination_name, destination_name)
        _copy_verified(
            source_dir / source_name, staging / destination_name, expected_hash
        )


def _install_archive(specification: dict[str, Any], staging: Path) -> None:
    archive_path = staging / "model.zip"
    _download(specification["url"], archive_path)
    if sha256(archive_path) != specification["archive_sha256"]:
        raise RuntimeError("model archive SHA-256 mismatch")
    member_name = specification["archive_member"]
    with zipfile.ZipFile(archive_path) as archive:
        try:
            member = archive.getinfo(member_name)
        except KeyError as error:
            raise RuntimeError(
                f"model archive member not found: {member_name}"
            ) from error
        with (
            archive.open(member) as source,
            (staging / "model.onnx").open("wb") as output,
        ):
            shutil.copyfileobj(source, output)
    archive_path.unlink()


def _install_huggingface(specification: dict[str, Any], staging: Path) -> None:
    repo_id = specification["repo_id"]
    revision = specification["revision"]
    remote_files = specification.get("remote_files", {})
    for destination_name in specification["files"]:
        remote_name = remote_files.get(destination_name, destination_name)
        url = f"https://huggingface.co/{repo_id}/resolve/{revision}/{remote_name}?download=true"
        try:
            _download(url, staging / destination_name)
        except urllib.error.HTTPError as error:
            raise RuntimeError(
                f"unable to download {repo_id}@{revision}/{remote_name}; "
                "publish the version or use --source-dir"
            ) from error


def install_model(
    model_id: str,
    version: str | None = None,
    *,
    model_root: Path = DEFAULT_MODEL_ROOT,
    registry_path: Path = DEFAULT_REGISTRY,
    source_dir: Path | None = None,
    force: bool = False,
) -> Path:
    registry = load_registry(registry_path)
    selected, specification = resolve_version(registry, model_id, version)
    destination = model_directory(model_root, model_id, selected)
    if (
        destination.exists()
        and not force
        and verify_install(destination, specification)
    ):
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{selected}-", dir=destination.parent))
    try:
        if source_dir is not None:
            _install_from_directory(source_dir, staging, specification)
        elif specification["source"] == "archive_url":
            _install_archive(specification, staging)
        elif specification["source"] == "huggingface":
            _install_huggingface(specification, staging)
        else:
            raise ValueError(f"unsupported model source: {specification['source']}")
        if not verify_install(staging, specification):
            raise RuntimeError(
                f"installed model files failed verification: {model_id}:{selected}"
            )
        manifest = {
            "model_id": model_id,
            "version": selected,
            "files": specification["files"],
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if destination.exists():
            shutil.rmtree(destination)
        staging.replace(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return destination


def installed_models(
    model_root: Path, registry_path: Path = DEFAULT_REGISTRY
) -> list[dict[str, Any]]:
    registry = load_registry(registry_path)
    installed = []
    for model_id, model in registry["models"].items():
        for version, specification in model["versions"].items():
            path = model_directory(model_root, model_id, version)
            installed.append(
                {
                    "model_id": model_id,
                    "version": version,
                    "path": str(path),
                    "ready": verify_install(path, specification),
                    "default": version == model["default_version"],
                }
            )
    return installed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wardy-models")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument(
        "--model-root",
        type=Path,
        default=Path(os.environ.get("WARDY_MODEL_ROOT", DEFAULT_MODEL_ROOT)),
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    install = subcommands.add_parser("install")
    install.add_argument("model_id", choices=("m03_pose", "m04_fall"))
    install.add_argument("--version")
    install.add_argument("--source-dir", type=Path)
    install.add_argument("--force", action="store_true")
    subcommands.add_parser("list")
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.command == "install":
        path = install_model(
            args.model_id,
            args.version,
            model_root=args.model_root,
            registry_path=args.registry,
            source_dir=args.source_dir,
            force=args.force,
        )
        print(path)
    else:
        print(json.dumps(installed_models(args.model_root, args.registry), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
