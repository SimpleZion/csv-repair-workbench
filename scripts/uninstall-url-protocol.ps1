$ErrorActionPreference = "Stop"

$protocolRoot = "HKCU:\Software\Classes\csvrepair"
if (Test-Path -LiteralPath $protocolRoot) {
  Remove-Item -LiteralPath $protocolRoot -Recurse -Force
  Write-Output "Removed csvrepair:// protocol for current user."
} else {
  Write-Output "csvrepair:// protocol is not installed for current user."
}
