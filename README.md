# CsvRepairWorkbench

CsvRepairWorkbench is a local-first workbench for scanning, repairing, validating and auditing malformed CSV files. It targets practical CSV failures such as naked quotes inside quoted fields, quotes inside unquoted fields, multiline fields and column-count mismatches.

The project has three parts:

- `engine/CsvRepairKit`: a streaming .NET 8 CSV scanner and repair engine.
- `workbench/api.py`: a FastAPI local API that runs engine jobs and serves JSONL/CSV/report previews.
- `web`: a bilingual React/Vite UI for batch tasks, progress, issue grouping, repair preview and highlighted before/after diffs.

## Features

- Scan one CSV or a whole directory recursively.
- Repair one CSV, selected issue files, or a full scan scope without overwriting source files.
- Keep issue logs, change logs, summary CSV files, progress JSONL and JSON reports.
- Preview repair changes before formal repair from scan rows, with highlighted original and projected repaired tokens.
- Upload a CSV through the UI instead of manually typing a path.
- Switch between Chinese and English in the UI.

## Requirements

- .NET SDK 8.0 or newer.
- Python 3.10 or newer.
- Node.js 20 or newer.

## Quick Start

From the repository root:

```powershell
dotnet build .\engine\CsvRepairKit\CsvRepairKit.csproj -c Release
python -m pip install -r .\workbench\requirements.txt
npm --prefix .\web install
```

Start the local API:

```powershell
.\scripts\start-api.ps1
```

Start the web UI:

```powershell
.\scripts\start-web.ps1
```

Open `http://127.0.0.1:5173`.

## CLI Examples

Scan one CSV:

```powershell
dotnet .\engine\CsvRepairKit\bin\Release\net8.0\CsvRepairKit.dll scan --input .\samples\malformed.csv --output-dir .\outputs\scan --log-all-issues
```

Repair one CSV:

```powershell
dotnet .\engine\CsvRepairKit\bin\Release\net8.0\CsvRepairKit.dll repair --input .\samples\malformed.csv --output .\outputs\malformed_repaired.csv --log-all-changes
```

Validate a repaired CSV:

```powershell
dotnet .\engine\CsvRepairKit\bin\Release\net8.0\CsvRepairKit.dll validate --input .\outputs\malformed_repaired.csv
```

## Deployment Note

The web UI is static and can be deployed to Cloudflare Pages or any static host. File scanning and repair require the local FastAPI service because browsers cannot directly read arbitrary local folders.

