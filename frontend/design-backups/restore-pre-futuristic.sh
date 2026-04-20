#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT_DIR/design-backups/2026-04-20-pre-futuristic"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "Backup directory not found: $BACKUP_DIR"
  exit 1
fi

rm -rf "$ROOT_DIR/src"
cp -a "$BACKUP_DIR/src" "$ROOT_DIR/src"
cp -a "$BACKUP_DIR/tailwind.config.js" "$ROOT_DIR/tailwind.config.js"
cp -a "$BACKUP_DIR/index.html" "$ROOT_DIR/index.html"

echo "Restored frontend design from backup: $BACKUP_DIR"
