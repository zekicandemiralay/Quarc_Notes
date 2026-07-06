#!/usr/bin/env bash
# ============================================================
#  Quarc Notes — Data Restore
#  Run on the target server from the Quarc_Notes directory:
#    bash restore.sh ./backup_20240101_120000
# ============================================================
set -e

BACKUP_DIR="$1"

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Usage: bash restore.sh <backup-dir>"
  echo "  e.g. bash restore.sh ./backup_20240101_120000"
  exit 1
fi

if [ ! -f "$BACKUP_DIR/notes.db" ] || [ ! -f "$BACKUP_DIR/.env" ]; then
  echo "ERROR: backup directory must contain notes.db and .env"
  exit 1
fi

echo "Restoring from $BACKUP_DIR ..."

echo "  · Restoring .env ..."
cp "$BACKUP_DIR/.env" .env

echo "  · Initializing Docker volume ..."
docker compose up -d backend 2>/dev/null || true
sleep 3
docker compose stop backend

echo "  · Restoring notes.db ..."
BACKEND=$(docker ps -aq --filter "label=com.docker.compose.service=backend" | head -1)
if [ -z "$BACKEND" ]; then
  echo "ERROR: backend container not found. Run 'docker compose up -d backend' first."
  exit 1
fi
docker cp "$BACKUP_DIR/notes.db" "$BACKEND:/app/data/notes.db"

if [ -d "$BACKUP_DIR/attachments" ]; then
  echo "  · Restoring attachments/ ..."
  docker cp "$BACKUP_DIR/attachments" "$BACKEND:/app/data/attachments"
fi

echo "  · Starting all services ..."
bash deploy.sh

echo ""
echo "Restore complete. Check status: bash check.sh"
