# Restore patched dsh-shared-brain files into the installed plugin directory.
# Use after a bundle reinstall / upgrade overwrote the local patches.
# Usage: powershell -File apply-patches.ps1 [-All] [-DryRun]
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files
# as ANSI and mangles non-ASCII text, which breaks parsing.
param(
  [switch]$All,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$patches = Join-Path $PSScriptRoot "lib"
$target  = "C:\Users\13176\.dsh\profiles\desktop\node_modules\dsh-shared-brain\lib"
$node    = "C:\Users\13176\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path $patches)) { throw "patch dir not found: $patches" }
if (-not (Test-Path $target))  { throw "plugin dir not found: $target (plugin not installed?)" }
if (-not (Test-Path $node))    { throw "node not found: $node" }

# 1) collect files that differ
$changed = @()
foreach ($file in Get-ChildItem "$patches\*.js") {
  $dst = Join-Path $target $file.Name
  if (-not (Test-Path $dst)) { $changed += $file.Name; continue }
  if ((Get-FileHash $file.FullName).Hash -ne (Get-FileHash $dst).Hash) { $changed += $file.Name }
}

if ($changed.Count -eq 0) {
  Write-Output "No differences: plugin already matches the patches."
  return
}

Write-Output ("Files to restore ({0}): {1}" -f $changed.Count, ($changed -join ", "))
if ($DryRun) { return }

# 2) syntax-check before copying anything
$bad = @()
foreach ($name in $changed) {
  $src = Join-Path $patches $name
  & $node --check $src 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $bad += $name }
}
if ($bad.Count -gt 0) {
  throw ("syntax check failed, refusing to copy: " + ($bad -join ", "))
}

# 3) back up the current plugin lib, then copy
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "C:\Users\13176\Documents\dsh-shared-brain-backup-$stamp\lib"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item "$target\*.js" $backup -Force
Write-Output "Backed up current lib to: $backup"

foreach ($name in $changed) {
  Copy-Item (Join-Path $patches $name) (Join-Path $target $name) -Force
}

# 4) verify hashes after copy
$mismatch = @()
foreach ($name in $changed) {
  $a = (Get-FileHash (Join-Path $patches $name)).Hash
  $b = (Get-FileHash (Join-Path $target $name)).Hash
  if ($a -ne $b) { $mismatch += $name }
}
if ($mismatch.Count -gt 0) { throw ("hash mismatch after copy: " + ($mismatch -join ", ")) }

Write-Output "Patches restored. Restart DSH to take effect."
