param(
  [switch]$SkipBuild,
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipBuild) {
  dotnet build .\engine\CsvRepairKit\CsvRepairKit.csproj -c Release
  if (Test-Path ".\web\package.json") {
    Push-Location ".\web"
    if (-not (Test-Path ".\node_modules")) {
      npm install
    }
    npm run build
    Pop-Location
  }
}

$port = 8787
$existingListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  Write-Output "CsvRepairWorkbench API is already running at http://127.0.0.1:$port/"
  if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:$port/"
  }
  exit 0
}

$pythonCommand = Get-Command python -ErrorAction Stop
$pythonDirectory = Split-Path -Parent $pythonCommand.Source
$pythonwPath = Join-Path $pythonDirectory "pythonw.exe"
$pythonRuntime = if (Test-Path $pythonwPath) { $pythonwPath } else { $pythonCommand.Source }
$logDirectory = Join-Path $repoRoot "outputs\csv_repair_workbench\logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$stdoutLog = Join-Path $logDirectory "api_stdout.log"
$stderrLog = Join-Path $logDirectory "api_stderr.log"
$arguments = @(
  "-m",
  "uvicorn",
  "workbench.api:app",
  "--host",
  "127.0.0.1",
  "--port",
  "$port",
  "--log-level",
  "warning"
)

$process = Start-Process `
  -FilePath $pythonRuntime `
  -ArgumentList $arguments `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$started = $false
for ($attempt = 1; $attempt -le 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/runs" -UseBasicParsing -TimeoutSec 3 | Out-Null
    $started = $true
    break
  } catch {
    if ($process.HasExited) {
      break
    }
  }
}

if ($started) {
  Write-Output "CsvRepairWorkbench API started in background at http://127.0.0.1:$port/"
  Write-Output "Logs: $logDirectory"
  Write-Output "ProcessId: $($process.Id)"
  if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:$port/"
  }
  exit 0
}

Write-Error "CsvRepairWorkbench API did not respond. Check logs in $logDirectory"
exit 1
