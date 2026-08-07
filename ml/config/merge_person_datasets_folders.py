from __future__ import annotations

import argparse
import hashlib
import os
import random
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}


@dataclass
class Sample:
    dataset_id: int
    source_path: Path
    source_type: str  # 'folder' or 'zip'
    image_ref: str
    output_name: str
    group_key: str
    label_text: str


def normalized_label(text: str) -> tuple[str | None, str | None]:
    """YOLO 탐지 라벨을 검사하고 모든 클래스를 person=0으로 변경합니다."""
    stripped = text.strip()
    if not stripped:
        return None, 'empty_label'

    output_lines: list[str] = []

    for raw_line in stripped.splitlines():
        parts = raw_line.split()
        if len(parts) != 5:
            return None, 'not_yolo_detection_5_columns'

        try:
            class_id = int(parts[0])
            x_center, y_center, width, height = map(float, parts[1:])
        except ValueError:
            return None, 'non_numeric_label'

        if class_id < 0:
            return None, 'negative_class_id'

        if not all(0.0 <= value <= 1.0 for value in (x_center, y_center, width, height)):
            return None, 'coordinate_out_of_range'
        if width <= 0.0 or height <= 0.0:
            return None, 'non_positive_box'

        output_lines.append(
            f'0 {x_center:.10g} {y_center:.10g} {width:.10g} {height:.10g}'
        )

    return '\n'.join(output_lines) + '\n', None


def label_path_from_image(path_text: str) -> str | None:
    """경로 안의 images 폴더를 labels로 바꾸고 확장자를 .txt로 변경합니다."""
    parts = list(PurePosixPath(path_text.replace('\\', '/')).parts)
    try:
        index = parts.index('images')
    except ValueError:
        return None

    parts[index] = 'labels'
    return str(PurePosixPath(*parts).with_suffix('.txt'))


def source_group_key(dataset_id: int, image_ref: str) -> str:
    """같은 원본에서 생성된 Roboflow 증강 이미지를 같은 분할에 둡니다."""
    filename = PurePosixPath(image_ref.replace('\\', '/')).name
    source_name = filename.split('.rf.')[0]
    return f'd{dataset_id}:{source_name}'


def add_sample(
    samples: list[Sample],
    skipped: Counter,
    dataset_id: int,
    source_path: Path,
    source_type: str,
    image_ref: str,
    label_text: str,
) -> None:
    converted, reason = normalized_label(label_text)
    if converted is None:
        skipped[(dataset_id, reason or 'unknown')] += 1
        return

    normalized_ref = image_ref.replace('\\', '/')
    image_path = PurePosixPath(normalized_ref)
    image_suffix = image_path.suffix.lower()
    original_stem = image_path.stem
    image_digest = hashlib.sha256(normalized_ref.encode('utf-8')).hexdigest()[:12]
    output_name = f'd{dataset_id}_{original_stem}_{image_digest}{image_suffix}'

    samples.append(
        Sample(
            dataset_id=dataset_id,
            source_path=source_path,
            source_type=source_type,
            image_ref=image_ref,
            output_name=output_name,
            group_key=source_group_key(dataset_id, image_ref),
            label_text=converted,
        )
    )


def discover_from_folder(
    folder: Path,
    dataset_id: int,
    samples: list[Sample],
    skipped: Counter,
) -> None:
    for image_path in folder.rglob('*'):
        if not image_path.is_file() or image_path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue

        relative = image_path.relative_to(folder).as_posix()
        label_relative = label_path_from_image(relative)
        if label_relative is None:
            continue

        label_path = folder / Path(label_relative)
        if not label_path.is_file():
            skipped[(dataset_id, 'missing_label')] += 1
            continue

        label_text = label_path.read_text(encoding='utf-8', errors='replace')
        add_sample(
            samples,
            skipped,
            dataset_id,
            folder,
            'folder',
            relative,
            label_text,
        )


def discover_from_zip(
    archive_path: Path,
    dataset_id: int,
    samples: list[Sample],
    skipped: Counter,
) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.namelist()
        member_set = set(members)

        for image_member in members:
            suffix = PurePosixPath(image_member).suffix.lower()
            if suffix not in IMAGE_EXTENSIONS:
                continue

            label_member = label_path_from_image(image_member)
            if label_member is None:
                continue
            if label_member not in member_set:
                skipped[(dataset_id, 'missing_label')] += 1
                continue

            label_text = archive.read(label_member).decode('utf-8', errors='replace')
            add_sample(
                samples,
                skipped,
                dataset_id,
                archive_path,
                'zip',
                image_member,
                label_text,
            )


def discover_samples(sources: list[Path]) -> tuple[list[Sample], Counter]:
    samples: list[Sample] = []
    skipped: Counter = Counter()

    for dataset_id, source in enumerate(sources, start=1):
        if source.is_dir():
            discover_from_folder(source, dataset_id, samples, skipped)
        elif source.is_file() and source.suffix.lower() == '.zip':
            discover_from_zip(source, dataset_id, samples, skipped)
        else:
            raise ValueError(f'폴더 또는 ZIP 파일이 아닙니다: {source}')

    return samples, skipped


def assign_splits(samples: list[Sample], seed: int = 42) -> dict[str, str]:
    groups_by_dataset: dict[int, list[str]] = defaultdict(list)
    seen: dict[int, set[str]] = defaultdict(set)

    for sample in samples:
        if sample.group_key not in seen[sample.dataset_id]:
            seen[sample.dataset_id].add(sample.group_key)
            groups_by_dataset[sample.dataset_id].append(sample.group_key)

    assignments: dict[str, str] = {}

    for dataset_id, groups in groups_by_dataset.items():
        rng = random.Random(seed + dataset_id)
        rng.shuffle(groups)
        count = len(groups)

        if count < 3:
            raise ValueError(
                f'dataset {dataset_id}에는 최소 3개의 증강 그룹이 필요합니다. '
                f'현재 그룹 수: {count}'
            )

        train_end = round(count * 0.8)
        val_end = train_end + round(count * 0.1)

        train_end = min(max(train_end, 1), count - 2)
        val_end = min(max(val_end, train_end + 1), count - 1)

        for index, group in enumerate(groups):
            if index < train_end:
                split = 'train'
            elif index < val_end:
                split = 'val'
            else:
                split = 'test'
            assignments[group] = split

    return assignments


def make_readme(samples: list[Sample], skipped: Counter, assignments: dict[str, str]) -> str:
    images_by_split = Counter(assignments[s.group_key] for s in samples)
    boxes_by_split = Counter()
    images_by_dataset = Counter(s.dataset_id for s in samples)

    for sample in samples:
        boxes_by_split[assignments[sample.group_key]] += len(
            sample.label_text.strip().splitlines()
        )

    lines = [
        '# Unified Person Detection Dataset',
        '',
        'YOLO detection datasets were merged into one class:',
        '',
        '- `0: person`',
        '',
        'All original class IDs were remapped to class 0.',
        '',
        '## Counts',
        '',
    ]

    for split in ('train', 'val', 'test'):
        lines.append(f'- {split}: {images_by_split[split]} images, {boxes_by_split[split]} boxes')

    lines.extend(['', '## Included images by source', ''])
    for dataset_id in sorted(images_by_dataset):
        lines.append(f'- dataset {dataset_id}: {images_by_dataset[dataset_id]} images')

    lines.extend(['', '## Excluded items', ''])
    if skipped:
        for (dataset_id, reason), count in sorted(skipped.items()):
            lines.append(f'- dataset {dataset_id}, {reason}: {count}')
    else:
        lines.append('- none')

    return '\n'.join(lines) + '\n'


def read_image_bytes(sample: Sample, zip_handles: dict[Path, zipfile.ZipFile]) -> bytes:
    if sample.source_type == 'folder':
        return (sample.source_path / Path(sample.image_ref)).read_bytes()

    archive = zip_handles.get(sample.source_path)
    if archive is None:
        archive = zipfile.ZipFile(sample.source_path)
        zip_handles[sample.source_path] = archive

    return archive.read(sample.image_ref)


def merge_sources(sources: list[Path], output_zip: Path, seed: int = 42) -> None:
    resolved_output = output_zip.resolve()

    for source in sources:
        if (
            source.is_file()
            and source.suffix.lower() == '.zip'
            and source.resolve() == resolved_output
        ):
            raise ValueError(
                f'출력 ZIP은 입력 ZIP과 같을 수 없습니다: {resolved_output}'
            )

    samples, skipped = discover_samples(sources)

    if not samples:
        raise RuntimeError(
            '사용 가능한 이미지/라벨 쌍을 찾지 못했습니다. '
            '각 데이터 안에 images 폴더와 대응하는 labels 폴더가 있는지 확인하세요.'
        )

    assignments = assign_splits(samples, seed=seed)
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    zip_handles: dict[Path, zipfile.ZipFile] = {}

    try:
        with zipfile.ZipFile(
            output_zip,
            'w',
            compression=zipfile.ZIP_DEFLATED,
            allowZip64=True,
        ) as output:
            data_yaml = (
                'path: .\n'
                'train: images/train\n'
                'val: images/val\n'
                'test: images/test\n\n'
                'names:\n'
                '  0: person\n'
            )
            output.writestr('person_dataset/data.yaml', data_yaml)
            output.writestr(
                'person_dataset/README.md',
                make_readme(samples, skipped, assignments),
            )

            total = len(samples)
            for index, sample in enumerate(samples, start=1):
                split = assignments[sample.group_key]
                image_bytes = read_image_bytes(sample, zip_handles)

                output.writestr(
                    f'person_dataset/images/{split}/{sample.output_name}',
                    image_bytes,
                )
                output.writestr(
                    f'person_dataset/labels/{split}/{Path(sample.output_name).stem}.txt',
                    sample.label_text,
                )

                if index % 1000 == 0 or index == total:
                    print(f'진행: {index}/{total}')
    finally:
        for archive in zip_handles.values():
            archive.close()

    # 완성된 ZIP을 다시 열어 무결성 검사
    with zipfile.ZipFile(output_zip) as test_archive:
        bad_file = test_archive.testzip()
        if bad_file is not None:
            raise RuntimeError(f'ZIP 무결성 검사 실패: {bad_file}')

    print(f'생성 완료: {output_zip.resolve()}')
    print(make_readme(samples, skipped, assignments))


def main() -> None:
    parser = argparse.ArgumentParser(
        description='폴더 또는 ZIP 형태의 YOLO 데이터셋을 person 한 클래스로 통합합니다.'
    )
    parser.add_argument(
        'sources',
        nargs='+',
        type=Path,
        help='입력 폴더 또는 ZIP 파일. 입력 순서대로 dataset 1, 2, ...가 됩니다.',
    )
    parser.add_argument(
        '-o',
        '--output',
        type=Path,
        default=Path('person_dataset_merged.zip'),
        help='생성할 ZIP 파일 이름',
    )
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()

    missing = [str(path) for path in args.sources if not path.exists()]
    if missing:
        raise FileNotFoundError(f'경로를 찾을 수 없습니다: {missing}')

    merge_sources(args.sources, args.output, seed=args.seed)


if __name__ == '__main__':
    main()
