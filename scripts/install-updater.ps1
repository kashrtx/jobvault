# Registers the optional updater helper with your browser on Windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-updater.ps1 <extension-id>
#   powershell -ExecutionPolicy Bypass -File scripts\install-updater.ps1 -Remove
#
# The extension id is shown in JobVault -> Settings once you tick the updater
# box, and on chrome://extensions with developer mode on. It is required because
# a native messaging host only answers the extensions it names.

param(
  [Parameter(Position = 0)][string]$ExtensionId = "",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$repo = (Get-Location).Path
$hostName = "com.jobvault.updater"

# Registry keys are per-user (HKCU), so this needs no administrator rights.
$browsers = @(
  @{ Name = "Chrome";   Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" },
  @{ Name = "Brave";    Key = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName" },
  @{ Name = "Edge";     Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" },
  @{ Name = "Chromium"; Key = "HKCU:\Software\Chromium\NativeMessagingHosts\$hostName" },
  @{ Name = "Vivaldi";  Key = "HKCU:\Software\Vivaldi\NativeMessagingHosts\$hostName" }
)

$manifestPath = Join-Path $repo "native\$hostName.json"
$batPath = Join-Path $repo "native\jobvault_updater.bat"

if ($Remove) {
  foreach ($b in $browsers) {
    if (Test-Path $b.Key) {
      Remove-Item $b.Key -Force
      Write-Host "Removed from $($b.Name)"
    }
  }
  Remove-Item $manifestPath, $batPath -Force -ErrorAction SilentlyContinue
  Write-Host "Done."
  exit 0
}

if (-not $ExtensionId) {
  Write-Host "Usage: powershell -ExecutionPolicy Bypass -File scripts\install-updater.ps1 <extension-id>"
  Write-Host "Find the id in JobVault -> Settings, or on chrome://extensions."
  exit 1
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Host "`"$ExtensionId`" does not look like an extension id (32 letters, a through p)."
  exit 1
}

# Written the long way because Windows PowerShell 5.1 has no ?? operator.
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) {
  Write-Host "Python 3 is not on your PATH. The helper needs it; install Python and re-run."
  Write-Host "Everything else in JobVault works without this helper."
  exit 1
}

# Windows will not launch a .py file as a native messaging host, so the manifest
# points at a small batch wrapper instead.
@"
@echo off
"$($python.Source)" "%~dp0jobvault_updater.py" %*
"@ | Set-Content -Path $batPath -Encoding ASCII

$manifest = [ordered]@{
  name           = $hostName
  description    = "JobVault git updater"
  path           = $batPath
  type           = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

$installed = 0
foreach ($b in $browsers) {
  New-Item -Path $b.Key -Force | Out-Null
  Set-ItemProperty -Path $b.Key -Name "(default)" -Value $manifestPath
  Write-Host "Registered with $($b.Name)"
  $installed++
}

Write-Host ""
Write-Host "Registered with $installed browser(s)."
Write-Host "Restart the browser, then use Update now in JobVault -> Settings."
