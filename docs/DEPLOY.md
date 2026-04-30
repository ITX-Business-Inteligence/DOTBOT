# Deploy de BOTDOT a produccion

## Opciones

### Opcion A — VPS (recomendada para MVP)

**Provider sugerido:** DigitalOcean Droplet $12/mes (2GB RAM, 2 vCPU, 50GB SSD), o Hetzner CX21 €5.83/mes.

#### Pasos

```bash
# 1. Crear VPS Ubuntu 22.04 LTS, anotar IP

# 2. Apuntar dominio (ej. dispatch.intelogix.mx) al IP via DNS A record

# 3. SSH al servidor
ssh root@TU_IP

# 4. Hardening basico
adduser botdot
usermod -aG sudo botdot
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable

# 5. Stack
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx mysql-server certbot python3-certbot-nginx git

# 6. MySQL — paso 1: usuario con permisos amplios para correr init.js
mysql_secure_installation
mysql -u root -p
> CREATE DATABASE botdot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> CREATE USER 'botdot'@'localhost' IDENTIFIED BY 'PASSWORD_FUERTE';
> GRANT ALL ON botdot.* TO 'botdot'@'localhost';
> FLUSH PRIVILEGES;
> EXIT;

# 7. Clonar repo y dependencias
sudo -u botdot bash
cd /home/botdot
git clone <REPO_URL> botdot
cd botdot
npm install --production
cp .env.example .env
nano .env  # Llenar todos los secretos

# 8. Init DB (corre migrations pendientes, crea triggers append-only,
#    asegura usuario admin). Idempotente — corre lo mismo en cada deploy.
node src/db/init.js
# (alternativa equivalente para solo migrations: npm run migrate)

# 8b. MySQL — paso 2: endurecer permisos sobre audit_log DESPUES de init.
#
# Esto es lo que hace inmutable a la cadena de audit aunque haya un bug
# o un SQLi en la app. Ver docs/ARCHITECTURE.md seccion "Audit log tamper-evidence".
#
# Capas de defensa que esto activa:
#   - REVOKE UPDATE, DELETE en audit_log: el app user no puede modificar
#     filas. INSERT sigue permitido (lo necesita appendAudit).
#   - REVOKE TRIGGER: el app user no puede crear NI dropear triggers, asi
#     que las del migration 002 (que abortan UPDATE/DELETE) no se pueden
#     desactivar via SQL.
#   - REVOKE DROP: TRUNCATE TABLE audit_log requiere DROP privilege en
#     MySQL — sin esto un atacante con SQLi podia limpiar toda la tabla.
#   - REVOKE ALTER: opcional pero recomendado — evita que un attacker
#     cambie el schema de audit_log para meter columnas o cambiar tipos.
#
# IMPORTANTE: estos REVOKEs hay que correrlos DESPUES de init.js / migrate
# (que necesitan los privilegios para crear schema y triggers). En cada
# deploy nuevo que aplique migrations, hay que volver a hacer GRANT,
# correr migrate, y volver a REVOKE — o usar dos usuarios distintos
# (ver Opcion B abajo).

mysql -u root -p
> REVOKE UPDATE, DELETE ON botdot.audit_log FROM 'botdot'@'localhost';
> REVOKE TRIGGER, DROP, ALTER ON botdot.* FROM 'botdot'@'localhost';
> FLUSH PRIVILEGES;
> SHOW GRANTS FOR 'botdot'@'localhost';   # verificar grants resultantes
> EXIT;

# Verificacion — los 3 comandos deben FALLAR:
mysql -u botdot -p botdot -e "UPDATE audit_log SET reasoning='hack' WHERE id=1"
# Esperado: ERROR 1644 (45000): audit_log es append-only; UPDATE bloqueado
mysql -u botdot -p botdot -e "DELETE FROM audit_log WHERE id=1"
# Esperado: ERROR 1644 (45000): audit_log es append-only; DELETE bloqueado
mysql -u botdot -p botdot -e "DROP TRIGGER audit_log_no_update"
# Esperado: ERROR 1227 (42000): Access denied; you need TRIGGER privilege

# > Opcion B (alta seguridad — recomendada para prod final): usar dos usuarios
# > MySQL distintos. 'botdot_migrator' con GRANT ALL solo para correr
# > migrations a mano (ssh + mysql -u botdot_migrator). 'botdot' (que usa la
# > app, en .env) nace SIN TRIGGER/DROP/ALTER y SIN UPDATE/DELETE en audit_log.
# > Ventaja: aunque te olvides de re-aplicar el REVOKE despues de un migrate,
# > el app user nunca tuvo esos privilegios.

# 9. Cargar SMS data inicial (subir CSVs a /home/botdot/botdot/data/ primero via scp)
npm run ingest-sms

# 10. PM2 para mantener corriendo
sudo npm install -g pm2
pm2 start server.js --name botdot
pm2 save
pm2 startup  # Seguir instrucciones

# 11. Nginx reverse proxy
exit  # volver a root
nano /etc/nginx/sites-available/botdot
```

Contenido de `/etc/nginx/sites-available/botdot`:

```nginx
server {
  listen 80;
  server_name dispatch.intelogix.mx;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_read_timeout 60s;
  }

  client_max_body_size 5M;
}
```

```bash
ln -s /etc/nginx/sites-available/botdot /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# 12. SSL con Let's Encrypt
certbot --nginx -d dispatch.intelogix.mx
# Acepta los terminos, da tu email, certbot configura HTTPS automatico

# 13. Firewall final
ufw status
# Solo 22, 80, 443 deben estar abiertos
```

Listo: https://dispatch.intelogix.mx funcionando.

---

### Opcion B — Cloud-managed (escala posterior)

- **Backend:** AWS Lightsail / Render / Railway / Fly.io
- **DB:** AWS RDS MySQL t3.micro, o PlanetScale, o Supabase
- **CDN:** Cloudflare al frente (gratis tier)

Para 450 drivers + 25 dispatchers, Opcion A es mas que suficiente. Migrar a B solo si crecen mucho.

## Verificacion del audit_log

`audit_log` esta encadenado por hashes; cualquier modificacion historica rompe
la cadena y se detecta.

**El backup diario** (siguiente seccion) ya incluye la verificacion al inicio
del proceso — si la cadena rompe, el backup sale con codigo 1 y cron manda
mail. Asi que normalmente no necesitas un cron separado solo para verify.

Para chequeos ad-hoc:

```bash
npm run verify-audit                 # CLI
npm run verify-audit -- --json       # output JSON parseable
curl https://dispatch.intelogix.mx/api/audit/verify   # via API (requiere admin/compliance)
curl https://dispatch.intelogix.mx/api/audit/head     # head actual (para anclaje externo manual)
```

## Backups

### Backup diario de la DB

El repo trae `scripts/backup.sh` que hace el flujo completo:

1. Verifica integridad de la cadena de `audit_log`
2. Captura el head de la cadena (id + row_hash) en el manifest
3. `mysqldump --single-transaction` (consistente con InnoDB, sin lockear)
4. gzip + sha256 del dump
5. Escribe `*.manifest.json` con metadata
6. Sube a S3/R2/B2 si esta configurado
7. Rota locales viejos

Configurar variables en `.env` (ver `.env.example`):

```ini
BOTDOT_BACKUP_DIR=/home/botdot/botdot-backups
BOTDOT_BACKUP_RETENTION_DAYS=30
# Opcional — solo si quieres subir offsite:
BOTDOT_S3_BUCKET=botdot-backups-intelogix
BOTDOT_S3_PREFIX=botdot
BOTDOT_S3_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com  # si es Cloudflare R2
```

Para subir offsite necesitas el `aws` CLI:
```bash
sudo apt install awscli jq
aws configure  # access_key, secret_key. Para R2/B2 son las que te da el provider.
```

Probar manual:
```bash
sudo -u botdot bash
cd /home/botdot/botdot
chmod +x scripts/backup.sh scripts/restore.sh
./scripts/backup.sh
ls -lh /home/botdot/botdot-backups/
cat /home/botdot/botdot-backups/botdot-*.manifest.json
```

Cron diario (3 AM UTC) + alerta por mail si falla:
```bash
crontab -e
```
```cron
# Backup diario. Si la cadena de audit esta rota, exit code = 1 y cron manda mail al MAILTO de arriba.
MAILTO=compliance@intelogix.mx
0 3 * * * /home/botdot/botdot/scripts/backup.sh >> /var/log/botdot-backup.log 2>&1
```

### Recomendado: bucket con Object Lock para anclaje externo

Para que el backup actue como "Layer 4" de defensa de la cadena de audit
(detectable contra alguien que comprometa el VPS entero), el bucket S3/R2
debe tener **Object Lock / immutable retention** habilitado. Asi un atacante
con credenciales del VPS no puede sobrescribir backups viejos.

- AWS S3: habilitar Object Lock al crear el bucket, modo `COMPLIANCE`, retencion 730 dias.
- Cloudflare R2: habilitar Object Lock en el bucket (panel de R2 -> Settings).
- Backblaze B2: habilitar Object Lock al crear el bucket.

### Restore

```bash
cd /home/botdot/botdot
./scripts/restore.sh /home/botdot/botdot-backups/botdot-20260101T030000Z.sql.gz
# Por seguridad crea una BD nueva con sufijo _restore_<timestamp>.
# Despues de restaurar, valida la cadena en la copia:
DB_NAME=botdot_restore_20260101030000 npm run verify-audit
# Si todo cuadra, swap manual con servidor apagado:
pm2 stop botdot
mysql -e "DROP DATABASE botdot; RENAME DATABASE botdot_restore_20260101030000 TO botdot"  # ejemplo
pm2 start botdot
```

### Test de restore (recomendado semanal)

Un backup que nunca testeas no es backup. Cron semanal sugerido:
```cron
# Domingo 5 AM: restaurar el backup mas reciente en una BD throw-away y verificar audit chain.
0 5 * * 0 /home/botdot/botdot/scripts/backup.sh && \
          LATEST=$(ls -t /home/botdot/botdot-backups/botdot-*.sql.gz | head -1) && \
          /home/botdot/botdot/scripts/restore.sh "$LATEST" --target botdot_restore_test <<< yes && \
          DB_NAME=botdot_restore_test /home/botdot/botdot/node_modules/.bin/node /home/botdot/botdot/scripts/verify-audit-chain.js
```

### Backup de .env y secretos

`.env` no entra en `mysqldump`. Guardar copia encriptada en bitwarden / 1Password / KeePass del equipo. Lo mismo para credenciales de Samsara y Anthropic.

## Updates

```bash
sudo -u botdot bash
cd /home/botdot/botdot
git pull
npm install --production
npm run migrate           # aplica migrations pendientes (idempotente)
npm run migrate:status    # opcional: ver que aplico
pm2 restart botdot
```

## Monitoring

### Logs

```bash
pm2 logs botdot          # tail
pm2 logs botdot --lines 1000
```

### Uptime (recomendado)

- UptimeRobot.com (gratis hasta 50 monitors)
- Endpoint: `https://dispatch.intelogix.mx/api/health` cada 5 min

### Alertas

- Falla DB → email
- Latencia >10s → email
- 5xx rate >1% → email

## Variables de entorno criticas en prod

| Variable | Valor recomendado prod |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | 64+ chars random, generado con crypto |
| `COOKIE_SECRET` | otro secreto distinto |
| `DB_PASSWORD` | password fuerte (no el de .env.example) |
| `ANTHROPIC_API_KEY` | api key real (las API keys NO viven en dev por seguridad) |
| `SAMSARA_API_TOKEN` | token con permisos minimos (read en HOS, drivers, vehicles) |
| `BOTDOT_MOCK_LLM` | **`false`** (en dev queda `true`) |
| `BOTDOT_MOCK_SAMSARA` | **`false`** (en dev queda `true`) |

### Swap de mocks → APIs reales (al deploy)

Las API keys de Anthropic y Samsara viven **solo en el server**. En dev,
se usan los mocks (`BOTDOT_MOCK_LLM=true`, `BOTDOT_MOCK_SAMSARA=true`).
Para activar las APIs reales en prod:

```bash
sudo -u botdot bash
nano /home/botdot/botdot/.env
# Reemplazar:
#   ANTHROPIC_API_KEY=sk-ant-api03-XXXXX  → la key real
#   SAMSARA_API_TOKEN=samsara_api_XXXXX   → el token real
#   BOTDOT_MOCK_LLM=true                  → false
#   BOTDOT_MOCK_SAMSARA=true              → false
pm2 restart botdot
pm2 logs botdot --lines 30
# Verificar que NO aparezcan:
#   [BOTDOT] MOCK LLM ACTIVO
#   [BOTDOT] MOCK SAMSARA ACTIVO
# El boot deberia decir solamente:
#   [sync] scheduler arrancado: drivers=60min, vehicles=60min, hos=5min
```

Verificar via health check:
```bash
curl https://dispatch.intelogix.mx/api/health
# {"ok":true,"mock_llm":false,"mock_samsara":false,"sync_enabled":true,...}
```

Si el server arranca con `NODE_ENV=production` Y algun mock activado,
imprime un `[WARNING] MOCK MODE EN PRODUCCION` en stderr — verlo en logs
es signo de que el swap esta incompleto.

## Graceful shutdown

El server captura `SIGTERM` (que es lo que `pm2 restart`, `docker stop`, y
`kill PID` mandan) e inicia un shutdown ordenado:

1. `/api/health` empieza a responder **503** (load balancer / UptimeRobot drainea)
2. HTTP server deja de aceptar requests nuevas y espera a las en vuelo
3. Schedulers de sync (Samsara) y jobs (alerts, CFR update) se detienen
4. MySQL pool se cierra cuando todas las conexiones vuelven al pool
5. Logger flush
6. Exit 0

Timeout: **30 segundos**. Si algo se atora (típicamente un sync de Samsara
o un fetch de CFR mid-ejecución), force exit con código 1.

**Configuración pm2 importante** — pm2 por default manda `SIGKILL` 4 segundos
después del `SIGTERM`. Eso es muy poco para nuestro shutdown (puede tomar
hasta 30s). Hay que extender el `kill_timeout`:

```js
// /home/botdot/botdot/ecosystem.config.js
module.exports = {
  apps: [{
    name: 'botdot',
    script: 'server.js',
    kill_timeout: 30000,        // espera 30s antes de SIGKILL
    listen_timeout: 10000,      // espera 10s al startup
    max_memory_restart: '500M', // reinicia si pasa de 500MB
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
```

Y arrancar con:
```bash
pm2 start ecosystem.config.js --env production
```

Para verificar que funciona:
```bash
pm2 logs botdot &
kill -TERM $(pm2 pid botdot)
# Deberias ver en logs:
#   "iniciando graceful shutdown signal=SIGTERM"
#   "http server closed"
#   "schedulers stopped"
#   "mysql pool closed"
# Y pm2 reporta el restart limpio.
```

## Rollback

```bash
pm2 stop botdot
cd /home/botdot/botdot
git checkout <commit-anterior>
npm install --production
pm2 restart botdot
```

Si la DB cambio (migration), restaurar dump:
```bash
gunzip < backups/botdot-YYYY-MM-DD.sql.gz | mysql -u botdot -p botdot
```

## Costos estimados produccion

| Item | Costo/mes |
|---|---|
| VPS DigitalOcean 2GB | $12 |
| Dominio (.mx) | ~$15/año = $1.25 |
| Cloudflare CDN (free tier) | $0 |
| Anthropic Claude API (con caching) | $200-400 |
| Backup S3/R2 (5GB) | $0.50 |
| UptimeRobot | $0 |
| **TOTAL** | **~$215-415** |
