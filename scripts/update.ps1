# Pull the latest JobVault on Windows and let the extension reload itself.
#
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Branch main -Force

param(
  [string]$Branch = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$root = (Get-Location).Path

function Stamp {
  $sha = (git rev-parse HEAD).Trim()
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $version = ((Get-Content manifest.json -Raw) | Select-String -Pattern '"version"\s*:\s*"([^"]+)"').Matches[0].Groups[1].Value
  git -c core.fileMode=false diff --quiet; $d1 = $LASTEXITCODE
  git -c core.fileMode=false diff --cached --quiet; $d2 = $LASTEXITCODE
  $dirty = if ($d1 -ne 0 -or $d2 -ne 0) { "true" } else { "false" }
  $stamp = [ordered]@{
    sha      = $sha
    shortSha = $sha.Substring(0, 7)
    branch   = $branch
    version  = $version
    dirty    = $dirty
    builtAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  # Written by hand so `dirty` stays a JSON boolean rather than a quoted string.
  @"
{
  "sha": "$($stamp.sha)",
  "shortSha": "$($stamp.shortSha)",
  "branch": "$($stamp.branch)",
  "version": "$($stamp.version)",
  "dirty": $($stamp.dirty),
  "builtAt": "$($stamp.builtAt)"
}
"@ | Set-Content -Path "build.json" -Encoding UTF8 -NoNewline
  Write-Host "stamp: $($stamp.shortSha) on $($stamp.branch) (v$($stamp.version))"
}

git rev-parse --git-dir *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "This folder is not a git checkout, so there is nothing to pull."
  Write-Host "Clone the repo and load that folder in your browser instead:"
  Write-Host "  git clone https://github.com/kashrtx/jobvault.git"
  exit 1
}

if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD).Trim() }

Write-Host "Fetching origin/$Branch ..."
git fetch --quiet origin $Branch

$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse "origin/$Branch").Trim()

if ($local -eq $remote) {
  Write-Host "Already on the latest commit ($($local.Substring(0,7)))."
  Stamp
  exit 0
}

git -c core.fileMode=false diff --quiet; $d1 = $LASTEXITCODE
git -c core.fileMode=false diff --cached --quiet; $d2 = $LASTEXITCODE
if (($d1 -ne 0 -or $d2 -ne 0) -and -not $Force) {
  Write-Host ""
  Write-Host "You have uncommitted changes in $root."
  Write-Host "Commit them, stash them, or re-run with -Force to discard them."
  exit 1
}

Write-Host "Updating $($local.Substring(0,7)) -> $($remote.Substring(0,7))"
git --no-pager log --oneline "$local..$remote"

if ($Force) {
  git reset --hard "origin/$Branch"
} else {
  git merge --ff-only "origin/$Branch"
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Your branch has commits that are not on origin/$Branch."
    Write-Host "Push your work, or re-run with -Force to take the remote version."
    exit 1
  }
}

Stamp
Write-Host ""
Write-Host "Done. JobVault reloads itself within a minute."
Write-Host "In a hurry: open JobVault -> Settings -> Reload the extension."
