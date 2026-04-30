#!/usr/bin/env bash
# Backup diario de BOTDOT.
#
# Que hace:
#   1. Verifica integridad de la cadena de audit_log (no bloquea, solo avisa)
#   2. Captura el head actual de la cadena (id + row_hash)
#   3. mysqldump consistente (--single-transaction, OK con InnoDB)
#   4. gzip + sha256 del dump
#   5. Escribe manifest.json con metadata + head de audit
#   6. Si BOTDOT_S3_BUCKET esta seteado, sube dump y manifest a S3/R2/B2
#   7. Rota locales > BOTDOT_BACKUP_RETENTION_DAYS dias
#
# Sale con codigo:
#   0 = todo OK
#   1 = backup OK pero cadena de audit comprometida (alertar!)
#   2 = falla tecnica (mysqldump fallo, etc)
#
# Uso (manual):
#   ./scripts/backup.sh
#
# Cron (3 AM diario):
#   0 3 * * * /home/botdot/botdot/scripts/backup.sh >> /var/log/botdot-backup.log 2>&1
#
# Pre-requisitos en el VPS:
#   - mysqldump, gzip, sha256sum (todos en util-linux/coreutils)
#   - jq (apt install jq) — usado por restore.sh, no estricto aqui
#   - aws CLI si vas a subir a S3/R2 (apt install awscli, o pip install awscli)

set -euo pipefail

# Paths absolutos por si corre en cron (PATH limitado)
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

# Cargar .env
if [ ! -f .env ]; then
  echo "ERROR: .env no encontrado en $REPO_DIR" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DB_USER:?DB_USER no esta en .env}"
: "${DB_PASSWORD:?DB_PASSWORD no esta en .env}"
: "${DB_NAME:?DB_NAME no esta en .env}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"

BACKUP_DIR="${BOTDOT_BACKUP_DIR:-$HOME/botdot-backups}"
RETENTION_DAYS="${BOTDOT_BACKUP_RETENTION_DAYS:-30}"
S3_BUCKET="${BOTDOT_S3_BUCKET:-}"
S3_PREFIX="${BOTDOT_S3_PREFIX:-botdot}"
S3_ENDPOINT_URL="${BOTDOT_S3_ENDPOINT_URL:-}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="botdot-${TIMESTAMP}"
DUMP_FILE="$BACKUP_DIR/${BACKUP_NAME}.sql.gz"
MANIFEST_FILE="$BACKUP_DIR/${BACKUP_NAME}.manifest.json"

mkdir -p "$BACKUP_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

log "=== Backup BOTDOT iniciando (db=$DB_NAME) ==="
log "  destino: $DUMP_FILE"

# 1. Verificar cadena de audit_log antes del backup. NO bloqueamos el backup
#    si esta comprometida — al contrario, queremos preservar la evidencia.
#    Solo marcamos el manifest y salimos no-zero al final para que cron alerte.
CHAIN_OK=true
log "  verificando audit chain..."
VERIFY_LOG=$(mktemp)
if ! npm run --silent verify-audit > "$VERIFY_LOG" 2>&1; then
  CHAIN_OK=false
  log "  WARNING: cadena de audit COMPROMETIDA. Salida del verify:"
  sed 's/^/    /' "$VERIFY_LOG" >&2
fi
rm -f "$VERIFY_LOG"

# 2. Capturar head de la cadena (id + row_hash) para el manifest
log "  capturando audit head..."
MYSQL_FLAGS=(-u "$DB_USER" -p"$DB_PASSWORD" -h "$DB_HOST" -P "$DB_PORT" -N --silent)
HEAD_ID="$(mysql "${MYSQL_FLAGS[@]}" -e \
  "SELECT IFNULL(MAX(id), 0) FROM audit_log" "$DB_NAME")"
HEAD_HASH="$(mysql "${MYSQL_FLAGS[@]}" -e \
  "SELECT IFNULL((SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1), REPEAT('0',64))" "$DB_NAME")"

# 3. mysqldump consistente
log "  dumping..."
if ! mysqldump \
      -u "$DB_USER" -p"$DB_PASSWORD" -h "$DB_HOST" -P "$DB_PORT" \
      --single-transaction \
      --routines --triggers --events \
      --set-gtid-purged=OFF \
      --hex-blob \
      "$DB_NAME" \
      | gzip > "$DUMP_FILE.partial"; then
  log "ERROR: mysqldump fallo"
  rm -f "$DUMP_FILE.partial"
  exit 2
fi
mv "$DUMP_FILE.partial" "$DUMP_FILE"

# 4. Checksum + tamano
DUMP_SHA="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
DUMP_BYTES="$(stat -c %s "$DUMP_FILE" 2>/dev/null || stat -f %z "$DUMP_FILE")"

# 5. Manifest. Es un JSON pequeno con metadata para validar/restaurar.
cat > "$MANIFEST_FILE" <<EOF
{
  "backup_id": "${BACKUP_NAME}",
  "created_at_utc": "$(date -u +%FT%T.%3NZ)",
  "host": "$(hostname)",
  "database": "${DB_NAME}",
  "dump_filename": "${BACKUP_NAME}.sql.gz",
  "dump_sha256": "${DUMP_SHA}",
  "dump_bytes": ${DUMP_BYTES},
  "audit_head_id": ${HEAD_ID},
  "audit_head_hash": "${HEAD_HASH}",
  "audit_chain_intact": ${CHAIN_OK}
}
EOF

log "  dump: ${DUMP_BYTES} bytes, sha256=${DUMP_SHA:0:16}..."
log "  audit head: id=${HEAD_ID} hash=${HEAD_HASH:0:16}... intact=${CHAIN_OK}"

# 6. Subir a S3/R2/B2 si esta configurado
if [ -n "$S3_BUCKET" ]; then
  log "  upload a s3://$S3_BUCKET/$S3_PREFIX/..."
  AWS_FLAGS=()
  if [ -n "$S3_ENDPOINT_URL" ]; then
    AWS_FLAGS+=(--endpoint-url "$S3_ENDPOINT_URL")
  fi
  aws s3 cp "$DUMP_FILE"     "s3://$S3_BUCKET/$S3_PREFIX/${BACKUP_NAME}.sql.gz"        "${AWS_FLAGS[@]}"
  aws s3 cp "$MANIFEST_FILE" "s3://$S3_BUCKET/$S3_PREFIX/${BACKUP_NAME}.manifest.json" "${AWS_FLAGS[@]}"
fi

# 7. Rotar locales viejos
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'botdot-*.sql.gz' -o -name 'botdot-*.manifest.json' \) \
  -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
log "  rotacion: $DELETED archivos > $RETENTION_DAYS dias eliminados de $BACKUP_DIR"

log "=== Backup completado: ${BACKUP_NAME} ==="

# Si la cadena estaba rota, salir 1 para que cron pueda alertar
if [ "$CHAIN_OK" != "true" ]; then
  exit 1
fi
exit 0
