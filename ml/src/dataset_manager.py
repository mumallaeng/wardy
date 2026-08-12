"""Install versioned Wardy datasets from verified Hugging Face revisions."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from model_manager import download_file, sha256


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRY = PROJECT_ROOT / "ml" / "config" / "dataset-registry.json"
DEFAULT_DATASET_ROOT = PROJECT_ROOT / "ml" / "datasets"


def load_registry(path: Path = DEFAULT_REGISTRY) -> dict[str, Any]:
    registry = json.loads(path.read_text())
    if registry.get("schema_version") != 1 or not isinstance(
        registry.get("datasets"), dict
    ):
        raise ValueError("unsupported Wardy dataset registry")
    return registry


def resolve_version(
    registry: dict[str, Any], dataset_id: str, version: str | None
) -> tuple[str, dict[str, Any]]:
    try:
        dataset = registry["datasets"][dataset_id]
        selected = version or dataset["default_version"]
        return selected, dataset["versions"][selected]
    except KeyError as error:
        raise ValueError(
            f"unknown dataset/version: {dataset_id}:{version or 'default'}"
        ) from error


def dataset_directory(dataset_root: Path, dataset_id: str, version: str) -> Path:
    return dataset_root / dataset_id / version


def verify_install(destination: Path, specification: dict[str, Any]) -> bool:
    return all(
        (destination / filename).is_file()
        and sha256(destination / filename) == expected
        for filename, expected in specification["files"].items()
    )


def install_dataset(
    dataset_id: str,
    version: str | None = None,
    *,
    dataset_root: Path = DEFAULT_DATASET_ROOT,
    registry_path: Path = DEFAULT_REGISTRY,
    force: bool = False,
) -> Path:
    registry = load_registry(registry_path)
    selected, specification = resolve_version(registry, dataset_id, version)
    destination = dataset_directory(dataset_root, dataset_id, selected)
    if (
        destination.exists()
        and not force
        and verify_install(destination, specification)
    ):
        return destination
    if specification.get("source") != "huggingface":
        raise ValueError(f"unsupported dataset source: {specification.get('source')}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{selected}-", dir=destination.parent))
    try:
        repo_id = specification["repo_id"]
        revision = specification["revision"]
        remote_files = specification.get("remote_files", {})
        for destination_name in specification["files"]:
            remote_name = remote_files.get(destination_name, destination_name)
            url = (
                f"https://huggingface.co/datasets/{repo_id}/resolve/"
                f"{revision}/{remote_name}?download=true"
            )
            download_file(url, staging / destination_name)
        if not verify_install(staging, specification):
            raise RuntimeError(
                f"installed dataset files failed verification: {dataset_id}:{selected}"
            )
        manifest = {
            "dataset_id": dataset_id,
            "version": selected,
            "repo_id": specification["repo_id"],
            "revision": specification["revision"],
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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wardy-datasets")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--dataset-root", type=Path, default=DEFAULT_DATASET_ROOT)
    subcommands = parser.add_subparsers(dest="command", required=True)
    install = subcommands.add_parser("install")
    install.add_argument("dataset_id")
    install.add_argument("--version")
    install.add_argument("--force", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    destination = install_dataset(
        args.dataset_id,
        args.version,
        dataset_root=args.dataset_root.resolve(),
        registry_path=args.registry.resolve(),
        force=args.force,
    )
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
