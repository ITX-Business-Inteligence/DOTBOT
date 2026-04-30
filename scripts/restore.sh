#!/usr/bin/env bash
# Restaura un backup de BOTDOT en una BD destino.
#
# Por seguridad, NUNCA sobrescribe la BD de produccion por defecto: crea
# una BD nueva con sufijo _restore_<timestamp>. Si quieres swap, lo haces
# tu manual despues de validar.
#
# Uso:
#   ./scripts/restore.sh /path/to/botdot-XXX.sql.gz
#   ./scripts/restore.sh /path/to/botdot-XXX.sql.gz --target botdot_restored
#   ./scripts/restore.sh --skip-checksum /path/to/botdot-XXX.sql.gz
#
# Despues de restaurar, valida la cadena de audit en la copia:
#   DB_NAME=<target_db> npm run verify-audit

set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

DUMP_FILE=""
TARGET_DB=""
SKIP_CHECKSUM=false

while [ $# -gt 0 ]; do
  case "$1" in
    --target)         TARGET_DB="$2"; shift 2 ;;
    --skip-checksum)  SKIP_CHECKSUM=true; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *)
      if [ -z "$DUMP_FILE" ]; then DUMP_FILE="$1"; else
        echo "Arg desconocido: $1" >&2; exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump file requerido y debe existir: '$DUMP_FILE'" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "ERROR: .env no encontrado en $REPO_DIR" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"

if [ -z "$TARGET_DB" ]; then
  TARGET_DB="${DB_NAME}_restore_$(date +%Y%m%d%H%M%S)"
fi

# Manifest hermano (mismo nombre, .manifest.json)
MANIFEST_FILE="${DUMP_FILE%.sql.gz}.manifest.json"

if [ "$SKIP_CHECKSUM" = false ] && [ -f "$MANIFEST_FILE" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq requerido para validar manifest. Instala con 'apt install jq' o pasa --skip-checksum." >&2
    exit 1
  fi
  EXPECTED="$(jq -r .dump_sha256 "$MANIFEST_FILE")"
  ACTUAL="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "ERROR: checksum del dump NO cuadra con el manifest" >&2
    echo "  esperado: $EXPECTED" >&2
    echo "  archivo:  $ACTUAL" >&2
    echo "Si confias en el dump y aceptas el riesgo, usa --skip-checksum." >&2
    exit 1
  fi
  echo "checksum OK contra $MANIFEST_FILE"

  HEAD_ID="$(jq -r .audit_head_id "$MANIFEST_FILE")"
  HEAD_HASH="$(jq -r .audit_head_hash "$MANIFEST_FILE")"
  CHAIN_OK="$(jq -r .audit_chain_intact "$MANIFEST_FILE")"
  echo "audit head al momento del backup: id=$HEAD_ID hash=${HEAD_HASH:0:16}... intact=$CHAIN_OK"
fi

echo "Restaurando $DUMP_FILE en BD: $TARGET_DB"
read -p "Confirmar (yes/NO): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelado."
  exit 0
fi

mysql -u "$DB_USER" -p"$DB_PASSWORD" -h "$DB_HOST" -P "$DB_PORT" -e \
  "CREATE DATABASE IF NOT EXISTS \`$TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

gunzip -c "$DUMP_FILE" \
  | mysql -u "$DB_USER" -p"$DB_PASSWORD" -h "$DB_HOST" -P "$DB_PORT" "$TARGET_DB"

echo
echo "Restaurado en BD: $TARGET_DB"
echo "Para validar integridad de la cadena de audit:"
echo "  DB_NAME=$TARGET_DB npm run verify-audit"
echo
echo "Para activar como BD de produccion (con servidor APAGADO):"
echo "  mysql -e 'DROP DATABASE \`$DB_NAME\`; RENAME ... '  # ejercicio para el operador, NO automatico"
