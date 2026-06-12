$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
dotnet build .\engine\CsvRepairKit\CsvRepairKit.csproj -c Release
if (Test-Path ".\web\package.json") {
  Push-Location ".\web"
  if (-not (Test-Path ".\node_modules")) {
    npm install
  }
  npm run build
  Pop-Location
}
python -m uvicorn workbench.api:app --host 127.0.0.1 --port 8787
