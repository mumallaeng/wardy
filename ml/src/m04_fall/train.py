from __future__ import annotations

import argparse
import json
import random
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from .model import TemporalFallGRU


class WindowDataset(Dataset):
    def __init__(self, features: np.ndarray, targets: np.ndarray):
        self.features = torch.from_numpy(features.astype(np.float32, copy=False))
        self.targets = torch.from_numpy(targets.astype(np.float32, copy=False))

    def __len__(self) -> int:
        return len(self.targets)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        return self.features[index], self.targets[index]


def _download_dataset(url: str, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / "dataset.zip"
    with (
        urllib.request.urlopen(url, timeout=120) as response,
        archive.open("wb") as output,
    ):
        shutil.copyfileobj(response, output)
    with zipfile.ZipFile(archive) as source:
        root = destination.resolve()
        for member in source.infolist():
            candidate = (destination / member.filename).resolve()
            if candidate != root and root not in candidate.parents:
                raise ValueError(f"unsafe dataset archive path: {member.filename}")
        source.extractall(destination)
    archive.unlink()
    return destination


def _load_split(directory: Path, split: str) -> dict[str, np.ndarray]:
    candidates = list(directory.rglob(f"urfd_{split}_2s_transition_windows.npz"))
    if len(candidates) != 1:
        raise FileNotFoundError(
            f"expected one {split} window artifact under {directory}"
        )
    with np.load(candidates[0], allow_pickle=False) as bundle:
        return {key: bundle[key] for key in bundle.files}


def _metrics(
    targets: np.ndarray, probabilities: np.ndarray, threshold: float
) -> dict[str, float | int]:
    prediction = probabilities >= threshold
    truth = targets.astype(bool)
    tp = int(np.sum(prediction & truth))
    fp = int(np.sum(prediction & ~truth))
    fn = int(np.sum(~prediction & truth))
    tn = int(np.sum(~prediction & ~truth))
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    return {
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / max(precision + recall, 1e-12),
        "accuracy": (tp + tn) / max(len(targets), 1),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "threshold": threshold,
    }


@torch.inference_mode()
def _predict(
    model: nn.Module, loader: DataLoader, device: torch.device
) -> tuple[np.ndarray, np.ndarray]:
    model.eval()
    targets = []
    probabilities = []
    for features, batch_targets in loader:
        logits = model(features.to(device))
        targets.append(batch_targets.numpy())
        probabilities.append(torch.sigmoid(logits).cpu().numpy())
    return np.concatenate(targets), np.concatenate(probabilities)


def train(dataset_dir: Path, output_dir: Path, epochs: int, seed: int) -> Path:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    bundles = {
        split: _load_split(dataset_dir, split)
        for split in ("train", "validation", "test")
    }
    feature_names = [str(value) for value in bundles["train"]["feature_names"]]
    train_features = bundles["train"]["features"].astype(np.float32)
    mean = train_features.mean(axis=(0, 1))
    std = train_features.std(axis=(0, 1))
    std[std < 1e-6] = 1.0
    loaders = {}
    generator = torch.Generator().manual_seed(seed)
    for split, bundle in bundles.items():
        standardized = ((bundle["features"].astype(np.float32) - mean) / std).astype(
            np.float32
        )
        loaders[split] = DataLoader(
            WindowDataset(standardized, bundle["targets"]),
            batch_size=64,
            shuffle=split == "train",
            generator=generator if split == "train" else None,
        )
    model = TemporalFallGRU(len(feature_names)).to(device)
    train_targets = bundles["train"]["targets"]
    positive = float(train_targets.sum())
    negative = float(len(train_targets) - positive)
    criterion = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor(negative / max(positive, 1.0), device=device)
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    best_state = None
    best_f1 = -1.0
    patience = 0
    for epoch in range(1, epochs + 1):
        model.train()
        for features, targets in loaders["train"]:
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(features.to(device)), targets.to(device))
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
        val_targets, val_probabilities = _predict(model, loaders["validation"], device)
        val_metrics = _metrics(val_targets, val_probabilities, 0.5)
        print(f"epoch={epoch:02d} validation_f1={val_metrics['f1']:.4f}")
        if float(val_metrics["f1"]) > best_f1:
            best_f1 = float(val_metrics["f1"])
            patience = 0
            best_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
        else:
            patience += 1
            if patience >= 8:
                break
    if best_state is None:
        raise RuntimeError("training did not produce a checkpoint")
    model = TemporalFallGRU(len(feature_names)).cpu().eval()
    model.load_state_dict(best_state)
    validation_targets, validation_probabilities = _predict(
        model, loaders["validation"], torch.device("cpu")
    )
    candidates = np.linspace(0.1, 0.9, 161)
    validation_metrics = max(
        (
            _metrics(validation_targets, validation_probabilities, float(value))
            for value in candidates
        ),
        key=lambda value: (value["f1"], value["recall"]),
    )
    threshold = float(validation_metrics["threshold"])
    test_targets, test_probabilities = _predict(
        model, loaders["test"], torch.device("cpu")
    )
    test_metrics = _metrics(test_targets, test_probabilities, threshold)

    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / "m04_temporal_gru.pt"
    torch.save(
        {
            "model_state_dict": best_state,
            "feature_names": feature_names,
            "feature_mean": mean,
            "feature_std": std,
        },
        checkpoint_path,
    )
    onnx_path = output_dir / "m04_temporal_gru.onnx"
    window_frames = int(train_features.shape[1])
    torch.onnx.export(
        model,
        torch.zeros(2, window_frames, len(feature_names)),
        onnx_path,
        input_names=["features"],
        output_names=["logits"],
        dynamic_axes={"features": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    onnx.checker.check_model(onnx.load(onnx_path))
    metadata = {
        "schema_version": 1,
        "model_name": "TemporalFallGRU",
        "input_name": "features",
        "output_name": "logits",
        "input_shape": ["batch", window_frames, len(feature_names)],
        "feature_names": feature_names,
        "feature_mean": mean.tolist(),
        "feature_std": std.tolist(),
        "target_name": "fall_transition",
        "target_fps": 10.0,
        "window_seconds": window_frames / 10.0,
        "decision_threshold": threshold,
        "bbox_provider": "M-01/M-02 contract",
    }
    (output_dir / "m04_temporal_gru.metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n"
    )
    (output_dir / "m04_temporal_gru.metrics.json").write_text(
        json.dumps({"validation": validation_metrics, "test": test_metrics}, indent=2)
        + "\n"
    )
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    parity_input = next(iter(loaders["test"]))[0][:4].numpy()
    with torch.inference_mode():
        expected = model(torch.from_numpy(parity_input)).numpy()
    actual = session.run(["logits"], {"features": parity_input})[0]
    if np.max(np.abs(expected - actual)) >= 1e-4:
        raise RuntimeError("ONNX parity failed")
    return output_dir


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m m04_fall.train")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dataset-dir", type=Path)
    source.add_argument("--dataset-url")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    temporary = None
    dataset_dir = args.dataset_dir
    if args.dataset_url:
        temporary = tempfile.TemporaryDirectory(prefix="wardy-m04-dataset-")
        dataset_dir = _download_dataset(args.dataset_url, Path(temporary.name))
    try:
        print(train(dataset_dir, args.output_dir, args.epochs, args.seed))
    finally:
        if temporary:
            temporary.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
