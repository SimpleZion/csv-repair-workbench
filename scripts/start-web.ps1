$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $repoRoot "web")
if (-not (Test-Path ".\node_modules")) {
  npm install
}
npm run dev

