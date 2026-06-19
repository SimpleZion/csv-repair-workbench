from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable

import polars as pl


workspace_root = Path(__file__).resolve().parents[1]
engine_project = workspace_root / "engine" / "CsvRepairKit" / "CsvRepairKit.csproj"
engine_dll = workspace_root / "engine" / "CsvRepairKit" / "bin" / "Release" / "net8.0" / "CsvRepairKit.dll"
output_root = workspace_root / "outputs" / "regression_tests"


def run_command(command: list[str], cwd: Path = workspace_root) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"command failed: {' '.join(command)}")
    return result


def run_command_expect_failure(command: list[str], expected_text: str, cwd: Path = workspace_root) -> None:
    result = subprocess.run(command, cwd=cwd, text=True, encoding="utf-8", errors="replace", capture_output=True)
    combined_output = f"{result.stdout}\n{result.stderr}"
    if result.returncode == 0 or expected_text not in combined_output:
        raise AssertionError({"command": command, "returncode": result.returncode, "output": combined_output})


def build_engine() -> None:
    run_command(["dotnet", "build", str(engine_project), "-c", "Release", "--nologo", "-v", "minimal"])


def repair_sample(input_name: str, output_name: str) -> dict[str, object]:
    output_root.mkdir(parents=True, exist_ok=True)
    output_path = output_root / output_name
    report_path = output_root / f"{Path(output_name).stem}_report.json"
    change_log_path = output_root / f"{Path(output_name).stem}_changes.jsonl"
    for path in [output_path, report_path, change_log_path]:
        path.unlink(missing_ok=True)
    result = run_command(
        [
            "dotnet",
            str(engine_dll),
            "repair",
            "--input",
            str(workspace_root / "samples" / input_name),
            "--output",
            str(output_path),
            "--output-dir",
            str(output_root),
            "--report",
            str(report_path),
            "--change-log",
            str(change_log_path),
            "--log-all-changes",
        ]
    )
    payload = json.loads(result.stdout)["Payload"]
    if payload["Validation"]["Status"] != "ok":
        raise AssertionError(f"validation failed for {input_name}")
    return payload


def read_csv_rows(path: Path) -> list[list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        return list(csv.reader(file))


def assert_rows(path: Path, expected_rows: list[list[str]]) -> None:
    rows = read_csv_rows(path)
    if rows != expected_rows:
        raise AssertionError(f"unexpected rows for {path}: {rows!r}")
    pl.read_csv(path, infer_schema_length=None)


def run_sample_regressions() -> None:
    terminal_payload = repair_sample("terminal_quote_malformed.csv", "terminal_quote_malformed_repaired.csv")
    assert_rows(
        Path(str(terminal_payload["OutputPath"])),
        [
            ["A", "B", "C"],
            ["1", 'text ending quote"', "Y"],
            ["2", "x", 'terminal quote"'],
            ["3", "ok", "done"],
        ],
    )

    quoted_payload = repair_sample("quoted_title_delimiter_malformed.csv", "quoted_title_delimiter_malformed_repaired.csv")
    assert_rows(
        Path(str(quoted_payload["OutputPath"])),
        [
            ["Stkcd", "Reptdt", "Resume", "PaidSign", "SharEnd"],
            [
                "002230",
                "2017-12-31",
                'This biography text is deliberately long before "2013 award","2017 award" in one field.',
                "Y",
                "105067220.00",
            ],
        ],
    )

    short_payload = repair_sample("short_quoted_delimiter_valid.csv", "short_quoted_delimiter_valid_repaired.csv")
    assert_rows(
        Path(str(short_payload["OutputPath"])),
        [
            ["A", "B", "C"],
            ["x", 'a","b', "y"],
        ],
    )

    multiline_payload = repair_sample("last_column_multiline_quote_valid.csv", "last_column_multiline_quote_valid_repaired.csv")
    assert_rows(
        Path(str(multiline_payload["OutputPath"])),
        [
            ["A", "B"],
            ["1", 'last column text is long enough and ends with a literal quote"\n"continuation line starts with a literal quote'],
            ["2", "done"],
        ],
    )

    missing_payload = repair_sample("missing_trailing_fields_malformed.csv", "missing_trailing_fields_repaired.csv")
    assert_rows(
        Path(str(missing_payload["OutputPath"])),
        [
            ["A", "B", "C"],
            ["1", "2", ""],
            ["3", "4", ""],
            ["5", "6", "7"],
        ],
    )
    if missing_payload["PaddedMissingTrailingFieldCount"] != 2:
        raise AssertionError("missing trailing fields were not counted")
    run_default_output_protection_regression()


def run_default_output_protection_regression() -> None:
    protection_dir = output_root / "default_protection"
    protection_dir.mkdir(parents=True, exist_ok=True)
    input_path = protection_dir / "default_case.csv"
    output_path = protection_dir / "default_case_repaired.csv"
    change_log_path = protection_dir / "default_case_repaired.changes.jsonl"
    input_path.write_text((workspace_root / "samples" / "terminal_quote_malformed.csv").read_text(encoding="utf-8"), encoding="utf-8")
    output_path.unlink(missing_ok=True)
    change_log_path.unlink(missing_ok=True)

    run_command(
        [
            "dotnet",
            str(engine_dll),
            "repair",
            "--input",
            str(input_path),
            "--output-dir",
            str(protection_dir),
            "--log-all-changes",
        ]
    )
    if not output_path.exists() or not change_log_path.exists():
        raise AssertionError("default output or change log was not created")

    run_command_expect_failure(
        [
            "dotnet",
            str(engine_dll),
            "repair",
            "--input",
            str(input_path),
            "--output-dir",
            str(protection_dir),
        ],
        "default repair output already exists",
    )

    output_path.unlink()
    run_command_expect_failure(
        [
            "dotnet",
            str(engine_dll),
            "repair",
            "--input",
            str(input_path),
            "--output-dir",
            str(protection_dir),
            "--log-all-changes",
        ],
        "default repair change log already exists",
    )


def valid_values(frame: pl.DataFrame, column: str, allowed_values: Iterable[object]) -> None:
    allowed = set(allowed_values)
    values = set(frame.get_column(column).drop_nulls().unique().to_list())
    invalid = values - allowed
    if invalid:
        raise AssertionError(f"{column} has invalid values: {sorted(invalid)!r}")


def assert_no_replacement_character(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if "\ufffd" in text:
        raise AssertionError(f"replacement character found in {path}")


def run_real_csv_regression(real_csv: Path) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    output_path = output_root / f"{real_csv.stem}_repaired_real.csv"
    report_path = output_root / f"{real_csv.stem}_repair_report_real.json"
    change_log_path = output_root / f"{real_csv.stem}_repair_changes_real.jsonl"
    for path in [output_path, report_path, change_log_path]:
        path.unlink(missing_ok=True)
    run_command(
        [
            "dotnet",
            str(engine_dll),
            "repair",
            "--input",
            str(real_csv),
            "--output",
            str(output_path),
            "--output-dir",
            str(output_root),
            "--report",
            str(report_path),
            "--change-log",
            str(change_log_path),
            "--log-all-changes",
        ]
    )
    assert_no_replacement_character(report_path)

    row_count = 0
    mismatch_examples: list[tuple[int, int]] = []
    invalid_examples: dict[str, list[dict[str, object]]] = defaultdict(list)
    checks = {
        "PaidSign": {"", "Y", "N"},
        "IsMTMT": {"", "0", "1"},
        "IsMTB": {"", "0", "1"},
        "IsIdirecotr": {"", "0", "1"},
        "IsDuality": {"", "0", "1"},
        "IsSupervisor": {"", "0", "1"},
        "IsCocurP": {"", "0", "1"},
    }
    with output_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.reader(file)
        header = next(reader)
        indexes = {name: header.index(name) for name in checks}
        for row_number, row in enumerate(reader, start=1):
            row_count += 1
            if len(row) != len(header) and len(mismatch_examples) < 10:
                mismatch_examples.append((row_number, len(row)))
            if len(row) != len(header):
                continue
            for name, allowed in checks.items():
                value = row[indexes[name]]
                if value not in allowed and len(invalid_examples[name]) < 10:
                    invalid_examples[name].append({"row_number": row_number, "value": value})
    if mismatch_examples or any(invalid_examples.values()):
        raise AssertionError({"mismatch_examples": mismatch_examples, "invalid_examples": invalid_examples})
    if row_count != 1_000_000:
        raise AssertionError(f"unexpected real csv row count: {row_count}")

    frame = pl.read_csv(output_path)
    if frame.shape != (1_000_000, 41):
        raise AssertionError(f"unexpected polars shape: {frame.shape}")
    valid_values(frame, "IsSupervisor", {0, 1})
    full_frame = pl.read_csv(output_path, infer_schema_length=None)
    if full_frame.shape != (1_000_000, 41):
        raise AssertionError(f"unexpected full infer shape: {full_frame.shape}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--real-csv", type=Path)
    args = parser.parse_args()
    build_engine()
    run_sample_regressions()
    if args.real_csv:
        run_real_csv_regression(args.real_csv)
    print("csv repair regressions ok")


if __name__ == "__main__":
    main()
