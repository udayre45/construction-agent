"""Audit the invoice ZIP and extract deterministic annotated samples.

This is an offline data-preparation utility. It does not upload data or call APIs.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import random
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any


DEFAULT_ZIP = Path.home() / "Downloads" / "High Quality Invoice Images for OCR.zip"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "data" / "invoice-sample"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit invoice annotations and extract a reproducible sample."
    )
    parser.add_argument("--zip", type=Path, default=DEFAULT_ZIP, dest="zip_path")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--sample-size", type=int, default=20)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--audit-only", action="store_true")
    return parser.parse_args()


def safe_json(raw: str) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def main() -> None:
    args = parse_args()
    if args.sample_size < 1:
        raise ValueError("--sample-size must be at least 1")
    if not args.zip_path.is_file():
        raise FileNotFoundError(f"Invoice ZIP not found: {args.zip_path}")

    csv.field_size_limit(sys.maxsize)

    with zipfile.ZipFile(args.zip_path) as archive:
        image_entries = [
            name for name in archive.namelist() if name.lower().endswith(".jpg")
        ]
        batch_1_images = [name for name in image_entries if name.startswith("batch_1/")]
        csv_entries = [
            name for name in archive.namelist() if name.lower().endswith(".csv")
        ]

        images_by_name: dict[str, list[str]] = defaultdict(list)
        for entry in batch_1_images:
            images_by_name[PurePosixPath(entry).name].append(entry)

        records: list[dict[str, Any]] = []
        csv_counts: Counter[str] = Counter()
        invalid_json = 0
        missing_filename = 0

        for csv_entry in csv_entries:
            with archive.open(csv_entry) as raw_stream:
                text_stream = io.TextIOWrapper(raw_stream, encoding="utf-8-sig", newline="")
                reader = csv.DictReader(text_stream)
                expected = {"File Name", "Json Data", "OCRed Text"}
                if not expected.issubset(reader.fieldnames or []):
                    raise ValueError(
                        f"Unexpected columns in {csv_entry}: {reader.fieldnames}"
                    )

                for row in reader:
                    filename = (row.get("File Name") or "").strip()
                    annotation = safe_json(row.get("Json Data") or "")
                    if not filename:
                        missing_filename += 1
                        continue
                    if annotation is None:
                        invalid_json += 1
                        continue

                    matches = images_by_name.get(filename, [])
                    records.append(
                        {
                            "annotation_file": csv_entry,
                            "filename": filename,
                            "image_matches": matches,
                            "annotation": annotation,
                            "ocr_text": row.get("OCRed Text") or "",
                        }
                    )
                    csv_counts[PurePosixPath(csv_entry).name] += 1

        matched = [record for record in records if len(record["image_matches"]) == 1]
        unmatched = [record for record in records if len(record["image_matches"]) == 0]
        ambiguous = [record for record in records if len(record["image_matches"]) > 1]
        annotated_names = {record["filename"] for record in matched}
        unannotated_batch_1 = [
            entry
            for entry in batch_1_images
            if PurePosixPath(entry).name not in annotated_names
        ]

        item_fields: set[str] = set()
        invoices_with_items = 0
        for record in matched:
            items = record["annotation"].get("items")
            if isinstance(items, list) and items:
                invoices_with_items += 1
                for item in items:
                    if isinstance(item, dict):
                        item_fields.update(item.keys())

        report = {
            "zip": str(args.zip_path),
            "total_images": len(image_entries),
            "batch_1_images": len(batch_1_images),
            "csv_files": len(csv_entries),
            "valid_annotation_rows": len(records),
            "matched_annotation_rows": len(matched),
            "unmatched_annotation_rows": len(unmatched),
            "ambiguous_annotation_rows": len(ambiguous),
            "invalid_json_rows": invalid_json,
            "missing_filename_rows": missing_filename,
            "unannotated_batch_1_images": len(unannotated_batch_1),
            "invoices_with_items": invoices_with_items,
            "item_fields": sorted(item_fields),
            "annotations_by_csv": dict(sorted(csv_counts.items())),
        }

        print(json.dumps(report, indent=2))

        if args.audit_only:
            return
        if len(matched) < args.sample_size:
            raise ValueError(
                f"Requested {args.sample_size} samples but only {len(matched)} matched rows exist"
            )

        rng = random.Random(args.seed)
        selected = sorted(
            rng.sample(matched, args.sample_size),
            key=lambda record: (record["annotation_file"], record["filename"]),
        )
        args.output.mkdir(parents=True, exist_ok=True)

        manifest: list[dict[str, Any]] = []
        for record in selected:
            source_entry = record["image_matches"][0]
            annotation_stem = PurePosixPath(record["annotation_file"]).stem
            output_name = f"{annotation_stem}__{record['filename']}"
            output_path = args.output / output_name
            with archive.open(source_entry) as source, output_path.open("wb") as target:
                target.write(source.read())

            manifest.append(
                {
                    "sample_id": output_path.stem,
                    "image": output_name,
                    "source_entry": source_entry,
                    "ground_truth": record["annotation"],
                    "ground_truth_ocr_text": record["ocr_text"],
                }
            )

        (args.output / "ground-truth.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        (args.output / "audit-report.json").write_text(
            json.dumps(report, indent=2), encoding="utf-8"
        )
        print(f"Extracted {len(manifest)} samples to {args.output}")


if __name__ == "__main__":
    main()
