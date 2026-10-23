# Full migration runner: Firestore staging ledger -> PocketBase (Go) DB.
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File backend/tools/migration/run-full-migration.ps1 -Ledger backend/migration-data/stage-2.json -Auth backend/migration-data/auth-official-2026-09-18.json -DataDir backend/pb_data
param(
  [Parameter(Mandatory=$true)] [string]$Ledger,
  [Parameter(Mandatory=$true)] [string]$Auth,
  [string]$DataDir = "backend/pb_data",
  [string]$OutDir = "backend/migration-data/rehearsal-full"
)

$ErrorActionPreference = "Stop"

# 1. Rehearse (analysis only, does not write)
go run ./backend/tools/migration/importer/cmd/import-rehearse -ledger $Ledger -auth $Auth -out $OutDir

# 2. Import roles first (users depend on roles)
go run ./backend/tools/migration/importer/cmd/import-roles -data $DataDir -ledger $Ledger

# 3. Import users
go run ./backend/tools/migration/importer/cmd/import-users -data $DataDir -ledger $Ledger -auth $Auth

# 4. Import board (categories, topics, posts)
go run ./backend/tools/migration/importer/cmd/import-board -data $DataDir -ledger $Ledger

# 4b. Import global forum settings (forum_settings singleton)
go run ./backend/tools/migration/importer/cmd/import-settings -data $DataDir -ledger $Ledger

# 5. Import characters
go run ./backend/tools/migration/importer/cmd/import-characters -data $DataDir -ledger $Ledger

# 6. Import avatars
go run ./backend/tools/migration/importer/cmd/import-avatars -data $DataDir -ledger $Ledger -storage backend/migration-data -scope all

# 7. Recompute counters
go run ./backend/tools/migration/importer/cmd/recompute-counters -data $DataDir

Write-Host "Full migration completed into $DataDir"