$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
dotnet build .\engine\CsvRepairKit\CsvRepairKit.csproj -c Release
python -m uvicorn workbench.api:app --host 127.0.0.1 --port 8787

