#!/usr/bin/env bash
# Скачать бэкап БД с VPS на этот компьютер (macOS/Linux-обёртка).
# Использование:
#   ./scripts/download-backup.sh
#   ./scripts/download-backup.sh --file pb_data-backup-20261106-120000.tgz
#   ./scripts/download-backup.sh --out ~/Desktop/db.tgz --overwrite
# Без --file скачивается новейший бэкап; по умолчанию — в .deploy/backups/.
# Проверка sha256 — внутри deploy.py.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python deploy.py backup "$@"