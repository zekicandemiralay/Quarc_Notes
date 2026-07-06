#!/usr/bin/env bash
# ============================================================
#  Quarc Notes — Data Backup
#  Run from the project directory:
#    bash backup.sh
#
#  Creates: ./backup_YYYYMMDD_HHMMSS/
#    notes.db      — full SQLite database (pages, links, tags)
#    attachments/  — uploaded files referenced by pages
#    .env          — all secrets and config
# ============================================================
set -e

BACKUP_DIR="./backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Backing up to $BACKUP_DIR ..."

BACKEND=$(docker ps -q --filter "label=com.docker.compose.service=backend" | head -1)
if [ -z "$BACKEND" ]; then
  echo "ERROR: backend container not running. Start it first: docker compose up -d backend"
  exit 1
fi

echo "  · Exporting notes.db ..."
docker cp "$BACKEND:/app/data/notes.db" "$BACKUP_DIR/notes.db"

echo "  · Exporting attachments/ ..."
docker cp "$BACKEND:/app/data/attachments" "$BACKUP_DIR/attachments" 2>/dev/null || mkdir -p "$BACKUP_DIR/attachments"

echo "  · Copying .env ..."
cp .env "$BACKUP_DIR/.env"

DB_SIZE=$(du -sh "$BACKUP_DIR/notes.db" | awk '{print $1}')
echo ""
echo "Backup complete: $BACKUP_DIR"
echo "  notes.db : $DB_SIZE"
echo ""
echo "Next: copy this folder to the new server."
echo "  scp -r $BACKUP_DIR user@new-server:~/Quarc_Notes/"
