param(
  [string]$ProtocolUrl = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $scriptRoot "start-api.ps1"

powershell.exe `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -WindowStyle Hidden `
  -File $startScript `
  -SkipBuild `
  -OpenBrowser
