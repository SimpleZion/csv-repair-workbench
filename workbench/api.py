from __future__ import annotations

import json
import csv
import hashlib
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


def find_workspace_root() -> Path:
    configured_root = os.environ.get("CSV_REPAIR_WORKSPACE_ROOT")
    if configured_root:
        return Path(configured_root).resolve()
    current_path = Path(__file__).resolve()
    for directory in [current_path.parent, *current_path.parents]:
        if (directory / "tools" / "CsvRepairKit" / "CsvRepairKit.csproj").exists():
            return directory
        if (directory / "engine" / "CsvRepairKit" / "CsvRepairKit.csproj").exists():
            return directory
    return current_path.parents[2]


def find_engine_project(root: Path) -> Path:
    candidates = [
        root / "tools" / "CsvRepairKit" / "CsvRepairKit.csproj",
        root / "engine" / "CsvRepairKit" / "CsvRepairKit.csproj",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def allowed_origins() -> list[str]:
    configured_origins = os.environ.get("CSV_REPAIR_ALLOWED_ORIGINS", "")
    values = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "https://csv-repair.simplezion.com",
    ]
    values.extend(origin.strip() for origin in configured_origins.split(",") if origin.strip())
    return sorted(set(values))


workspace_root = find_workspace_root()
engine_project = find_engine_project(workspace_root)
engine_dll = engine_project.parent / "bin" / "Release" / "net8.0" / "CsvRepairKit.dll"
workbench_output_dir = Path(os.environ.get("CSV_REPAIR_OUTPUT_DIR", workspace_root / "outputs" / "csv_repair_workbench")).resolve()
jobs_dir = workbench_output_dir / "jobs"
locks_dir = workbench_output_dir / "locks"
allowed_read_roots = (
    workspace_root.resolve(),
    workbench_output_dir.resolve(),
)

app = FastAPI(title="CsvRepairWorkbench API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_private_network_access_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
reserved_output_paths: dict[str, str] = {}
reserved_output_paths_lock = threading.Lock()


class RunRequest(BaseModel):
    command: Literal["scan", "repair", "validate", "audit", "benchmark"] = "scan"
    input_path: str = ""
    root_path: str = ""
    output_path: str = ""
    output_dir: str = ""
    report_path: str = ""
    issue_log_path: str = ""
    change_log_path: str = ""
    exclude: list[str] = Field(default_factory=list)
    exclude_dir: list[str] = Field(default_factory=list)
    expected_columns: int | None = None
    all_quoted: Literal["auto", "true", "false"] = "auto"
    workers: int = 4
    max_examples: int = 20
    progress_every: int = 25
    iterations: int = 1
    log_all_issues: bool = True
    log_all_changes: bool = False
    validate_after_repair: bool = True
    write_bom: bool = False


class RepairPreviewRequest(BaseModel):
    input_path: str
    expected_columns: int | None = None
    all_quoted: Literal["auto", "true", "false"] = "auto"
    max_examples: int = 20
    write_bom: bool = False
    limit: int = Field(default=200, ge=1, le=1000)


@app.on_event("startup")
def load_existing_jobs() -> None:
    jobs_dir.mkdir(parents=True, exist_ok=True)
    locks_dir.mkdir(parents=True, exist_ok=True)
    for path in jobs_dir.glob("*.json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if job.get("status") in {"queued", "running"}:
            job["status"] = "interrupted"
            job["finished_at"] = now_text()
            job["return_code"] = -1
            job["stderr"] = (str(job.get("stderr") or "") + "\nWorkbench restarted before this job finished.").strip()
            persist_job(job)
            release_output_paths(str(job["job_id"]))
        jobs[str(job["job_id"])] = job
    cleanup_orphan_locks()


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "engine_exists": engine_dll.exists(),
        "engine_path": str(engine_dll),
        "workspace_root": str(workspace_root),
    }


@app.post("/api/runs")
def create_run(request: RunRequest) -> dict[str, Any]:
    ensure_engine()
    job_id = uuid.uuid4().hex
    command, output_base = build_engine_command(request, job_id)
    validate_output_safety(request, command, output_base)
    reserved_paths = writable_output_paths(request, command)
    try:
        reserve_output_paths(job_id, reserved_paths)
        job = {
            "job_id": job_id,
            "status": "queued",
            "request": request.model_dump(),
            "command": command,
            "workbench_output_base": str(output_base) if output_base else None,
            "reserved_output_paths": [str(path) for path in reserved_paths],
            "stdout": "",
            "stderr": "",
            "return_code": None,
            "started_at": now_text(),
            "finished_at": None,
            "elapsed_seconds": None,
            "payload": None,
        }
        with jobs_lock:
            jobs[job_id] = job
        persist_job(job)
        threading.Thread(target=run_engine_job, args=(job_id,), daemon=True).start()
        return {"ok": True, "job": public_job(job)}
    except Exception:
        release_output_paths(job_id)
        raise


@app.get("/api/runs")
def list_runs() -> dict[str, Any]:
    with jobs_lock:
        values = [public_job(job) for job in jobs.values()]
    values.sort(key=lambda item: str(item.get("started_at", "")), reverse=True)
    return {"runs": values}


@app.get("/api/runs/{job_id}")
def get_run(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="run not found")
    return {"job": public_job(job)}


@app.post("/api/uploads/csv")
async def upload_csv(request: Request, filename: str = Query(..., min_length=1)) -> dict[str, Any]:
    safe_name = safe_upload_filename(filename)
    if Path(safe_name).suffix.casefold() != ".csv":
        raise HTTPException(status_code=400, detail="only .csv files can be uploaded here")
    upload_id = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:12]}"
    upload_directory = workbench_output_dir / "uploads" / upload_id
    upload_directory.mkdir(parents=True, exist_ok=False)
    output_path = upload_directory / safe_name
    size_bytes = 0
    try:
        with output_path.open("xb") as target:
            async for chunk in request.stream():
                if not chunk:
                    continue
                target.write(chunk)
                size_bytes += len(chunk)
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    if size_bytes == 0:
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="uploaded file is empty")
    return {
        "ok": True,
        "path": str(output_path),
        "filename": Path(filename).name,
        "size_bytes": size_bytes,
    }


@app.post("/api/repair-preview")
def create_repair_preview(request: RepairPreviewRequest) -> dict[str, Any]:
    ensure_engine()
    input_path = resolve_for_compare(request.input_path)
    if not input_path.exists() or not input_path.is_file():
        raise HTTPException(status_code=404, detail="input CSV not found")
    preview_id = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:12]}"
    preview_dir = workbench_output_dir / "repair_preview" / preview_id
    preview_dir.mkdir(parents=True, exist_ok=False)
    suffix = input_path.suffix or ".csv"
    output_path = preview_dir / f"{safe_output_stem(input_path.stem)}_preview_repaired{suffix}"
    report_path = preview_dir / "repair_preview_report.json"
    change_log_path = preview_dir / "repair_preview_changes.jsonl"
    command = [
        "dotnet",
        str(engine_dll),
        "repair",
        "--input",
        str(input_path),
        "--output",
        str(output_path),
        "--report",
        str(report_path),
        "--change-log",
        str(change_log_path),
        "--log-all-changes",
        "--all-quoted",
        request.all_quoted,
        "--max-examples",
        str(max(1, request.max_examples)),
        "--no-validate",
    ]
    if request.expected_columns is not None:
        command.extend(["--expected-columns", str(request.expected_columns)])
    if request.write_bom:
        command.append("--write-bom")
    started = time.perf_counter()
    process = subprocess.run(
        command,
        cwd=workspace_root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    elapsed_seconds = round(time.perf_counter() - started, 3)
    payload = parse_engine_payload(process.stdout)
    rows, next_offset, has_more = read_jsonl_rows(change_log_path, limit=request.limit, offset=0)
    return {
        "ok": process.returncode == 0,
        "status": "ok" if process.returncode == 0 else "issue",
        "input_path": str(input_path),
        "output_path": str(output_path),
        "report_path": str(report_path),
        "change_log_path": str(change_log_path),
        "return_code": process.returncode,
        "elapsed_seconds": elapsed_seconds,
        "payload": payload,
        "rows": rows,
        "offset": 0,
        "next_offset": next_offset,
        "has_more": has_more,
        "stdout": process.stdout[:8000],
        "stderr": process.stderr[:8000],
    }


@app.get("/api/jsonl")
def read_jsonl(
    path: str,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    path_filter: str = "",
) -> dict[str, Any]:
    file_path = safe_existing_file(path)
    rows, next_offset, has_more = read_jsonl_rows(file_path, limit=limit, offset=offset, path_filter=path_filter)
    return {"path": str(file_path), "offset": offset, "limit": limit, "rows": rows, "next_offset": next_offset, "has_more": has_more}


@app.get("/api/jsonl/groups")
def read_jsonl_groups(path: str, limit: int = Query(2000, ge=1, le=20000)) -> dict[str, Any]:
    file_path = safe_existing_file(path)
    groups: dict[str, dict[str, Any]] = {}
    total_rows = 0
    grouped_rows = 0
    truncated = False
    with file_path.open("r", encoding="utf-8-sig", errors="replace") as file:
        for line in file:
            line = line.strip()
            if not line:
                continue
            total_rows += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            row_path = str(row.get("Path") or "")
            if not row_path:
                continue
            grouped_rows += 1
            group = groups.setdefault(row_path, {"path": row_path, "count": 0, "issue_types": {}})
            group["count"] += 1
            issue_type = str(row.get("IssueType") or row.get("issue_type") or "unknown")
            group["issue_types"][issue_type] = group["issue_types"].get(issue_type, 0) + 1
            if len(groups) > limit:
                truncated = True
                break
    values = sorted(groups.values(), key=lambda item: (-int(item["count"]), str(item["path"]).casefold()))
    return {
        "path": str(file_path),
        "groups": values[:limit],
        "total_rows": total_rows,
        "grouped_rows": grouped_rows,
        "truncated": truncated,
    }


@app.get("/api/report")
def read_report(path: str) -> dict[str, Any]:
    file_path = safe_existing_file(path)
    return json.loads(file_path.read_text(encoding="utf-8"))


@app.get("/api/text")
def read_text(path: str, limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    file_path = safe_existing_file(path)
    lines: list[dict[str, Any]] = []
    next_offset = offset
    has_more = False
    with file_path.open("r", encoding="utf-8-sig", errors="replace") as file:
        for line_number, line in enumerate(file):
            if line_number < offset:
                continue
            if len(lines) >= limit:
                has_more = True
                next_offset = line_number
                break
            lines.append({"line": line_number + 1, "text": line.rstrip("\r\n")})
            next_offset = line_number + 1
    return {"path": str(file_path), "offset": offset, "limit": limit, "rows": lines, "next_offset": next_offset, "has_more": has_more}


@app.get("/api/csv")
def read_csv_preview(path: str, limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    file_path = safe_existing_file(path)
    rows: list[dict[str, Any]] = []
    next_offset = offset
    has_more = False
    with file_path.open("r", encoding="utf-8-sig", errors="replace", newline="") as file:
        reader = csv.reader(file)
        try:
            columns = next(reader)
        except StopIteration:
            return {"path": str(file_path), "offset": offset, "limit": limit, "columns": [], "rows": [], "next_offset": offset, "has_more": False}
        for row_index, row in enumerate(reader):
            if row_index < offset:
                continue
            if len(rows) >= limit:
                has_more = True
                next_offset = row_index
                break
            item = {"__row_number": row_index + 2}
            for column_index, column_name in enumerate(columns):
                item[column_name or f"column_{column_index + 1}"] = row[column_index] if column_index < len(row) else ""
            if len(row) > len(columns):
                item["__extra_fields"] = row[len(columns):]
            rows.append(item)
            next_offset = row_index + 1
    return {
        "path": str(file_path),
        "offset": offset,
        "limit": limit,
        "columns": ["__row_number", *columns],
        "rows": rows,
        "next_offset": next_offset,
        "has_more": has_more,
    }


def ensure_engine() -> None:
    if engine_dll.exists():
        return
    subprocess.run(
        ["dotnet", "build", str(engine_project), "-c", "Release"],
        cwd=workspace_root,
        check=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def build_engine_command(request: RunRequest, job_id: str) -> tuple[list[str], Path | None]:
    command = ["dotnet", str(engine_dll), request.command]
    output_base = resolve_output_base(request, job_id)
    default_repair_output = default_single_repair_output(request, output_base)
    if request.input_path:
        command.extend(["--input", request.input_path])
    if request.root_path:
        command.extend(["--root", request.root_path])
    if request.output_path:
        command.extend(["--output", request.output_path])
    elif default_repair_output:
        command.extend(["--output", str(default_repair_output)])
    if output_base:
        command.extend(["--output-dir", str(output_base)])
    if request.report_path and request.command == "repair":
        command.extend(["--report", request.report_path])
    elif default_repair_output:
        command.extend(["--report", str(default_repair_output.with_name(f"{default_repair_output.stem}_report.json"))])
    if request.issue_log_path and request.command in {"scan", "audit"}:
        command.extend(["--issue-log", request.issue_log_path])
    if request.change_log_path and request.command in {"repair", "audit"}:
        command.extend(["--change-log", request.change_log_path])
    if request.command in {"scan", "repair"}:
        for pattern in request.exclude:
            command.extend(["--exclude", pattern])
        for pattern in request.exclude_dir:
            command.extend(["--exclude-dir", pattern])
    if request.expected_columns is not None and request.command in {"scan", "repair", "validate", "benchmark"}:
        command.extend(["--expected-columns", str(request.expected_columns)])
    if request.command in {"scan", "repair", "validate", "benchmark"}:
        command.extend(["--all-quoted", request.all_quoted])
        command.extend(["--max-examples", str(max(1, request.max_examples))])
    if request.command in {"scan", "repair"}:
        command.extend(["--workers", str(max(1, request.workers))])
        command.extend(["--progress-every", str(max(1, request.progress_every))])
    if request.command == "benchmark":
        command.extend(["--iterations", str(max(1, request.iterations))])
    if request.log_all_issues and request.command == "scan":
        command.append("--log-all-issues")
    if request.log_all_changes and request.command == "repair":
        command.append("--log-all-changes")
    if not request.validate_after_repair and request.command == "repair":
        command.append("--no-validate")
    if request.write_bom and request.command == "repair":
        command.append("--write-bom")
    return command, output_base


def resolve_output_base(request: RunRequest, job_id: str) -> Path | None:
    if request.command not in {"scan", "repair", "audit", "benchmark"}:
        return None
    base_directory = Path(request.output_dir) if request.output_dir else workbench_output_dir / request.command
    if not base_directory.is_absolute():
        base_directory = workspace_root / base_directory
    return base_directory / "runs" / job_id


def default_single_repair_output(request: RunRequest, output_base: Path | None) -> Path | None:
    if request.command != "repair" or request.root_path or not request.input_path or not output_base:
        return None
    input_path = Path(request.input_path)
    suffix = input_path.suffix or ".csv"
    return output_base / "single_file" / f"{input_path.stem}_repaired{suffix}"


def validate_output_safety(request: RunRequest, command: list[str], output_base: Path | None) -> None:
    if request.command == "repair" and request.input_path:
        input_path = resolve_for_compare(request.input_path)
        output_path = command_option_path(command, "--output")
        if output_path and output_path == input_path:
            raise HTTPException(status_code=400, detail="repair output path must not be the same as the input CSV")
    protected_options = ["--output", "--report"]
    if request.command == "scan":
        protected_options.append("--issue-log")
    if request.command == "repair":
        protected_options.append("--change-log")
    for option in protected_options:
        path = command_option_path(command, option)
        if not path or not path.exists():
            continue
        if output_base and is_path_inside(path, output_base.resolve()):
            continue
        raise HTTPException(status_code=400, detail=f"{option} target already exists; choose a new path to avoid overwriting files")


def writable_output_paths(request: RunRequest, command: list[str]) -> list[Path]:
    options = ["--output", "--report"]
    if request.command == "scan":
        options.append("--issue-log")
    if request.command == "repair":
        options.append("--change-log")
    paths: list[Path] = []
    for option in options:
        path = command_option_path(command, option)
        if path:
            paths.append(path)
    return unique_paths(paths)


def unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    values: list[Path] = []
    for path in paths:
        key = str(path).casefold()
        if key in seen:
            continue
        seen.add(key)
        values.append(path)
    return values


def reserve_output_paths(job_id: str, paths: list[Path]) -> None:
    with reserved_output_paths_lock:
        for path in paths:
            key = str(path).casefold()
            existing_job_id = reserved_output_paths.get(key)
            if existing_job_id and existing_job_id != job_id:
                raise HTTPException(status_code=409, detail=f"output path is already reserved by another running job: {path}")
            existing_lock = read_lock_file(path)
            if existing_lock and existing_lock.get("job_id") != job_id:
                raise HTTPException(status_code=409, detail=f"output path is locked by another job: {path}")
        created_keys: list[str] = []
        created_lock_paths: list[Path] = []
        try:
            for path in paths:
                key = str(path).casefold()
                created_lock_paths.append(write_lock_file(job_id, path))
                reserved_output_paths[key] = job_id
                created_keys.append(key)
        except FileExistsError as error:
            rollback_reserved_paths(job_id, created_keys, created_lock_paths)
            raise HTTPException(status_code=409, detail=f"output path is locked by another job: {error.filename}") from error
        except Exception:
            rollback_reserved_paths(job_id, created_keys, created_lock_paths)
            raise


def release_output_paths(job_id: str) -> None:
    with reserved_output_paths_lock:
        for key, value in list(reserved_output_paths.items()):
            if value == job_id:
                del reserved_output_paths[key]
        for path in locks_dir.glob("*.json"):
            try:
                lock = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if lock.get("job_id") == job_id:
                path.unlink(missing_ok=True)


def rollback_reserved_paths(job_id: str, keys: list[str], lock_paths: list[Path]) -> None:
    for key in keys:
        if reserved_output_paths.get(key) == job_id:
            del reserved_output_paths[key]
    for path in lock_paths:
        try:
            lock = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if lock.get("job_id") == job_id:
            path.unlink(missing_ok=True)


def write_lock_file(job_id: str, path: Path) -> Path:
    locks_dir.mkdir(parents=True, exist_ok=True)
    file_path = lock_path(path)
    payload = json.dumps({"job_id": job_id, "path": str(path), "created_at": now_text()}, ensure_ascii=False, indent=2)
    with file_path.open("x", encoding="utf-8") as file:
        file.write(payload)
    return file_path


def read_lock_file(path: Path) -> dict[str, Any] | None:
    file_path = lock_path(path)
    if not file_path.exists():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def lock_path(path: Path) -> Path:
    digest = hashlib.sha256(str(path).casefold().encode("utf-8")).hexdigest()
    return locks_dir / f"{digest}.json"


def cleanup_orphan_locks() -> None:
    active_job_ids = {job_id for job_id, job in jobs.items() if job.get("status") in {"queued", "running"}}
    for path in locks_dir.glob("*.json"):
        try:
            lock = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            path.unlink(missing_ok=True)
            continue
        if lock.get("job_id") not in active_job_ids:
            path.unlink(missing_ok=True)


def command_option_path(command: list[str], option: str) -> Path | None:
    if option not in command:
        return None
    index = command.index(option)
    if index + 1 >= len(command):
        return None
    return resolve_for_compare(command[index + 1])


def resolve_for_compare(path: str) -> Path:
    value = Path(path)
    if not value.is_absolute():
        value = workspace_root / value
    return value.resolve()


def safe_upload_filename(filename: str) -> str:
    name = Path(filename).name.replace("\x00", "").strip()
    if not name:
        name = "upload.csv"
    safe = "".join(character if character.isalnum() or character in ".-_ ()[]{}+" else "_" for character in name)
    if not safe or safe in {".", ".."}:
        safe = "upload.csv"
    return safe


def safe_output_stem(stem: str) -> str:
    safe = "".join(character if character.isalnum() or character in ".-_ ()[]{}+" else "_" for character in stem).strip()
    if not safe or safe in {".", ".."}:
        return "csv"
    return safe[:120]


def read_jsonl_rows(
    file_path: Path,
    *,
    limit: int,
    offset: int,
    path_filter: str = "",
) -> tuple[list[Any], int, bool]:
    rows: list[Any] = []
    next_offset = offset
    has_more = False
    matched_index = 0
    if not file_path.exists():
        return rows, next_offset, has_more
    with file_path.open("r", encoding="utf-8-sig", errors="replace") as file:
        for line in file:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                row = {"raw": line}
            if path_filter and (not isinstance(row, dict) or str(row.get("Path") or "") != path_filter):
                continue
            if matched_index < offset:
                matched_index += 1
                continue
            if len(rows) >= limit:
                has_more = True
                next_offset = matched_index
                break
            rows.append(row)
            matched_index += 1
            next_offset = matched_index
    return rows, next_offset, has_more


def run_engine_job(job_id: str) -> None:
    try:
        update_job(job_id, status="running")
        started = time.perf_counter()
        with jobs_lock:
            command = list(jobs[job_id]["command"])
        process = subprocess.run(
            command,
            cwd=workspace_root,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
        )
        elapsed = round(time.perf_counter() - started, 3)
        payload = parse_engine_payload(process.stdout)
        status = "ok" if process.returncode == 0 else "issue"
        update_job(
            job_id,
            status=status,
            return_code=process.returncode,
            stdout=process.stdout,
            stderr=process.stderr,
            payload=payload,
            elapsed_seconds=elapsed,
            finished_at=now_text(),
        )
    except Exception as error:
        update_job(
            job_id,
            status="issue",
            return_code=-1,
            stderr=str(error),
            finished_at=now_text(),
        )
    finally:
        release_output_paths(job_id)


def parse_engine_payload(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return None
    try:
        return json.loads(text).get("Payload")
    except Exception:
        return {"raw": text}


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    visible = dict(job)
    visible["progress"] = read_job_progress(visible)
    if len(str(visible.get("stdout", ""))) > 8000:
        visible["stdout"] = str(visible["stdout"])[:8000] + "\n...<truncated>"
    if len(str(visible.get("stderr", ""))) > 8000:
        visible["stderr"] = str(visible["stderr"])[:8000] + "\n...<truncated>"
    return visible


def read_job_progress(job: dict[str, Any]) -> dict[str, Any] | None:
    progress_path = find_progress_path(job)
    if not progress_path:
        return None
    progress = read_best_progress_line(progress_path)
    if progress is None:
        return {"path": str(progress_path), "status": "waiting"}
    return normalize_progress(progress, progress_path)


def find_progress_path(job: dict[str, Any]) -> Path | None:
    payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
    payload_path = payload.get("ProgressPath") if payload else None
    if payload_path:
        path = Path(str(payload_path))
        if path.exists():
            return path

    base_value = job.get("workbench_output_base")
    if not base_value:
        return None
    base_path = Path(str(base_value))
    if not base_path.exists():
        return None
    progress_files = sorted(
        base_path.glob("*/progress.jsonl"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    return progress_files[0] if progress_files else None


def read_best_progress_line(path: Path) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_score: tuple[int, float, int] = (-1, -1.0, -1)
    try:
        with path.open("r", encoding="utf-8", errors="replace") as file:
            for index, line in enumerate(file):
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                score = progress_score(item, index)
                if score >= best_score:
                    best = item
                    best_score = score
    except Exception:
        return None
    return best


def progress_score(progress: dict[str, Any], index: int) -> tuple[int, float, int]:
    status = str(progress.get("status") or "")
    status_score = 2 if status == "finished" else 1 if status == "running" else 0
    total = numeric_value(progress.get("csv_count")) or 0
    done = numeric_value(progress.get("scanned_count"))
    if done is None:
        done = numeric_value(progress.get("repaired_count"))
    if done is None and status == "finished":
        done = total
    return status_score, done or 0, index


def normalize_progress(progress: dict[str, Any], path: Path) -> dict[str, Any]:
    visible = dict(progress)
    visible["path"] = str(path)
    total = numeric_value(visible.get("csv_count"))
    done = numeric_value(visible.get("scanned_count"))
    if done is None:
        done = numeric_value(visible.get("repaired_count"))
    if total and done is not None:
        visible["percent"] = round(min(100.0, max(0.0, done * 100.0 / total)), 1)
    return visible


def numeric_value(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except ValueError:
        return None


def update_job(job_id: str, **updates: Any) -> None:
    with jobs_lock:
        job = jobs[job_id]
        job.update(updates)
        snapshot = dict(job)
    persist_job(snapshot)


def persist_job(job: dict[str, Any]) -> None:
    jobs_dir.mkdir(parents=True, exist_ok=True)
    (jobs_dir / f"{job['job_id']}.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_existing_file(path: str) -> Path:
    file_path = Path(path).resolve()
    if not is_allowed_read_path(file_path):
        raise HTTPException(status_code=403, detail="file is outside the workbench read boundary")
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return file_path


def is_allowed_read_path(path: Path) -> bool:
    return any(path == root or root in path.parents for root in allowed_read_roots) or is_known_job_artifact(path)


def is_known_job_artifact(path: Path) -> bool:
    artifact_keys = {
        "ProgressPath",
        "SummaryJsonPath",
        "SummaryCsvPath",
        "IssueLogPath",
        "ChangeLogPath",
        "OutputPath",
        "SummaryPath",
    }
    directory_keys = {"OutputDirectory"}
    with jobs_lock:
        snapshots = [dict(job) for job in jobs.values()]
    for job in snapshots:
        base_value = job.get("workbench_output_base")
        if base_value and is_path_inside(path, Path(str(base_value)).resolve()):
            return True
        payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
        for key in artifact_keys:
            value = payload.get(key) if payload else None
            if value and path == Path(str(value)).resolve():
                return True
        for key in directory_keys:
            value = payload.get(key) if payload else None
            if value and is_path_inside(path, Path(str(value)).resolve()):
                return True
    return False


def is_path_inside(path: Path, directory: Path) -> bool:
    return path == directory or directory in path.parents


def now_text() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
