<# Скачать бэкап БД с VPS на этот компьютер (PowerShell).
Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/download-backup.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/download-backup.ps1 -File pb_data-backup-20261106-120000.tgz
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/download-backup.ps1 -Out "$env:USERPROFILE\Desktop\db.tgz" -Overwrite
Без -File скачивается новейший бэкап; по умолчанию — в
.deploy\backups\ (gitignored). Проверка sha256 — внутри deploy.py.
#>
param(
  [string]$File = '',
  [string]$Out = '',
  [switch]$Overwrite
)

$ErrorActionPreference = 'Stop'
$Root = Join-Path $PSScriptRoot '..'
$Py = Get-Command python -ErrorAction SilentlyContinue
if (-not $Py) { $Py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $Py) { throw 'python not found on PATH.' }

$args = @('deploy.py', 'backup')
if ($File -ne '') { $args += @('--file', $File) }
if ($Out -ne '') { $args += @('--out', $Out) }
if ($Overwrite) { $args += '--overwrite' }

Push-Location $Root
try {
  & $Py.Source @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}