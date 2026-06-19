$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherScript = Join-Path $scriptRoot "open-local-workbench.ps1"

if (-not (Test-Path -LiteralPath $launcherScript)) {
  throw "Launcher script not found: $launcherScript"
}

$command = '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherScript + '" "%1"'
$protocolKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Classes\csvrepair")
if ($null -eq $protocolKey) {
  throw "Failed to open HKCU\Software\Classes\csvrepair for writing."
}
try {
  $protocolKey.SetValue("", "URL:CsvRepairWorkbench", [Microsoft.Win32.RegistryValueKind]::String)
  $protocolKey.SetValue("URL Protocol", "", [Microsoft.Win32.RegistryValueKind]::String)
} finally {
  $protocolKey.Dispose()
}

$commandKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Classes\csvrepair\shell\open\command")
if ($null -eq $commandKey) {
  throw "Failed to open HKCU\Software\Classes\csvrepair\shell\open\command for writing."
}
try {
  $commandKey.SetValue("", $command, [Microsoft.Win32.RegistryValueKind]::String)
} finally {
  $commandKey.Dispose()
}

Write-Output "Installed csvrepair://open protocol for current user."
Write-Output "Command: $command"
