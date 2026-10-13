<# Local backend restart: rebuild aerun.exe and relaunch it hidden.
Usage:
  powershell -ExecutionPolicy Bypass -File scripts/local-backend.ps1        # rebuild + restart + health
  powershell -ExecutionPolicy Bypass -File scripts/local-backend.ps1 -NoBuild  # restart existing exe
  powershell -ExecutionPolicy Bypass -File scripts/local-backend.ps1 -StopOnly # just stop it
#>
param(
  [switch]$NoBuild,
  [switch]$StopOnly
)

$ErrorActionPreference = 'Stop'
$BackendDir = Join-Path (Join-Path $PSScriptRoot '..') 'backend'
$RunDir = Join-Path $BackendDir '.local-run'
$Exe = Join-Path $RunDir 'aerun.exe'
$OutLog = Join-Path $RunDir 'stdout.log'
$ErrLog = Join-Path $RunDir 'stderr.log'
$Health = 'http://127.0.0.1:8090/api/aerun/health'

function Stop-LocalBackend {
  $procs = Get-Process aerun -ErrorAction SilentlyContinue
  if ($procs) {
    Write-Host "Stopping $($procs.Count) aerun process(es)..."
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 2
    $left = Get-Process aerun -ErrorAction SilentlyContinue
    if ($left) { throw 'aerun process did not stop, kill it manually (Task Manager).' }
    Write-Host 'Stopped.'
  } else {
    Write-Host 'No running aerun process.'
  }
}

Stop-LocalBackend
if ($StopOnly) { exit 0 }

if (-not $NoBuild) {
  Write-Host 'Building aerun.exe...'
  Push-Location $BackendDir
  try {
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    go build -o $Exe ./cmd/aerun
    if ($LASTEXITCODE -ne 0) { throw "go build failed (exit $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
  Write-Host 'Build OK.'
} elseif (-not (Test-Path $Exe)) {
  throw "No $Exe - run without -NoBuild first."
}

Write-Host 'Starting aerun.exe (hidden)...'
Start-Process -FilePath $Exe -WorkingDirectory $BackendDir `
  -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden

Write-Host 'Waiting for health...'
for ($i = 1; $i -le 12; $i++) {
  Start-Sleep -Seconds 2
  try {
    $resp = Invoke-RestMethod -Uri $Health -TimeoutSec 5
    if ($resp.status -eq 'ok') {
      Write-Host "Healthy (try $i/12): env=$($resp.environment)"
      exit 0
    }
  } catch { }
  Write-Host "  not yet ($i/12)..."
}
Write-Host 'FAILED to become healthy. Tail of logs:'
Get-Content $OutLog -Tail 15 -ErrorAction SilentlyContinue
Get-Content $ErrLog -Tail 15 -ErrorAction SilentlyContinue
exit 1
