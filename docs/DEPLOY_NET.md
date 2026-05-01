# Deploy de BOTDOT (.NET) a produccion

Guia de deploy del port .NET a un VPS Linux. Reusa MySQL, schema y data del
Node original — coexiste si ambos corren en paralelo, o reemplaza si haces
cutover hard.

Para el deploy del Node original, ver `DEPLOY.md`.

## Opciones

### Opcion A — VPS Linux (recomendada)

**Provider sugerido:** DigitalOcean Droplet $12/mes (2GB RAM, 2 vCPU, 50GB SSD),
Hetzner CX21 €5.83/mes, o cualquier Ubuntu 22.04+.

**Por que Linux y no Windows Server:** .NET 8 corre nativo en Linux con perf
identico, costo de licencia $0, ecosistema servidor (nginx, certbot, systemd,
ufw) bien probado para apps publicas.

#### Pasos

```bash
# 1. Crear VPS Ubuntu 22.04 LTS, anotar IP
# 2. DNS: subdominio (ej. dispatch.intelogix.mx) → IP via A record
# 3. SSH al server
ssh root@TU_IP

# 4. Hardening basico
adduser botdot
usermod -aG sudo botdot
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable

# 5. Stack base
apt update && apt upgrade -y
apt install -y nginx mysql-server certbot python3-certbot-nginx git

# 6. Instalar .NET 8 SDK + Runtime
wget https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb
dpkg -i packages-microsoft-prod.deb
apt update
apt install -y dotnet-sdk-8.0
dotnet --info     # verificar 8.x instalado

# 7. MySQL
mysql_secure_installation
mysql -u root -p
> CREATE DATABASE botdot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> CREATE USER 'botdot'@'localhost' IDENTIFIED BY 'PASSWORD_FUERTE';
> GRANT ALL ON botdot.* TO 'botdot'@'localhost';
> FLUSH PRIVILEGES;
> EXIT;

# 8. Clonar repo
sudo -u botdot bash
cd /home/botdot
git clone <REPO_URL> botdot
cd botdot

# 9. Migrations — el .NET NO trae runner, usar el del Node:
#    Si NO queres tener Node en prod, hace el migrate desde tu maquina y
#    sube el dump. Sino:
sudo apt install -y nodejs npm
npm install --production
cp .env.example .env
nano .env    # llenar DB_*, JWT_SECRET, COOKIE_SECRET
node src/db/init.js     # aplica migrations + crea admin sembrado
# (alternativamente: npm run migrate)

# 10. Endurecer permisos audit_log (ver DEPLOY.md paso 8b para detalle)
mysql -u root -p
> REVOKE UPDATE, DELETE ON botdot.audit_log FROM 'botdot'@'localhost';
> REVOKE TRIGGER, DROP, ALTER ON botdot.* FROM 'botdot'@'localhost';
> FLUSH PRIVILEGES;
> EXIT;

# 11. Build .NET para prod
cd dotnet
dotnet publish BotDot.Web -c Release -o /home/botdot/publish

# 12. Config prod del .NET
cd /home/botdot/publish
cp appsettings.json appsettings.Production.json
nano appsettings.Production.json
# Llenar:
#   "Env": "Production"
#   "PublicUrl": "https://dispatch.intelogix.mx"
#   "Db": password real
#   "Anthropic": { "ApiKey": "sk-ant-...", "Mock": false }
#   "Samsara": { "Token": "samsara_...", "Mock": false }
#   "Auth": { "JwtSecret": <openssl rand -hex 64>, "CookieSecret": <otro> }
#   "Email": { "Mock": false, "SmtpHost": "smtp.gmail.com", "SmtpPort": 587,
#              "SmtpUser": "...", "SmtpPass": "...", "EscalationsTo": "compliance@intelogix.mx" }

# 13. systemd service
exit  # volver a root
nano /etc/systemd/system/botdot-net.service
```

Contenido de `/etc/systemd/system/botdot-net.service`:

```ini
[Unit]
Description=BOTDOT .NET ASP.NET Core
After=network.target mysql.service

[Service]
Type=notify
WorkingDirectory=/home/botdot/publish
ExecStart=/usr/bin/dotnet /home/botdot/publish/BotDot.Web.dll
Restart=always
RestartSec=10
KillSignal=SIGINT
SyslogIdentifier=botdot-net
User=botdot
Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=ASPNETCORE_URLS=http://127.0.0.1:5050
# DOTNET_PRINT_TELEMETRY_MESSAGE=false silencia el banner del primer run.
Environment=DOTNET_PRINT_TELEMETRY_MESSAGE=false

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable botdot-net
systemctl start botdot-net
systemctl status botdot-net    # debe estar 'active (running)'
journalctl -u botdot-net -f    # ver logs en vivo

# 14. Nginx reverse proxy (mismo que el Node, solo cambiar puerto interno)
nano /etc/nginx/sites-available/botdot
```

Contenido de `/etc/nginx/sites-available/botdot`:

```nginx
server {
  listen 80;
  server_name dispatch.intelogix.mx;

  location / {
    proxy_pass http://127.0.0.1:5050;     # 5050 para .NET (Node usa 3000)
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

  client_max_body_size 25M;     # 20MB Excel + headroom
}
```

```bash
ln -s /etc/nginx/sites-available/botdot /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# 15. SSL con Let's Encrypt
certbot --nginx -d dispatch.intelogix.mx
# Auto-renewal: certbot crea cron diario por default. Verificar:
systemctl status certbot.timer

# 16. Smoke test publico
curl https://dispatch.intelogix.mx/api/health
# Esperado: { "ok": true, "env": "Production", "mock_llm": false, ... }
```

### Opcion B — Windows Server con IIS

Si la organizacion exige Windows Server (politica corporativa), .NET 8 corre
nativo en IIS con el ASP.NET Core Hosting Bundle.

#### Pasos abreviados

1. Windows Server 2019/2022, instalar IIS con ASP.NET Core Module
2. Bajar [ASP.NET Core 8 Hosting Bundle](https://dotnet.microsoft.com/download/dotnet/8.0)
3. `dotnet publish -c Release -o C:\inetpub\botdot`
4. Site nuevo en IIS apuntando a `C:\inetpub\botdot\`, AppPool `No Managed Code`
5. `web.config` se genera automaticamente (lo crea `dotnet publish`)
6. MySQL en otra VM o RDS
7. URL Rewrite + ARR para reverse proxy si hace falta
8. Win-ACME para Let's Encrypt en Windows

**Recomendacion:** Linux es mas simple, mas barato, y el equipo no necesita
licencias adicionales. Solo Windows si la auditoria de la org lo exige.

## Coexistencia con el Node (durante migracion)

Si quieres correr ambos en paralelo durante la migracion:

```nginx
# Routing por path en nginx — strangler pattern
server {
  listen 443 ssl;
  server_name dispatch.intelogix.mx;
  ssl_certificate /etc/letsencrypt/live/dispatch.intelogix.mx/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dispatch.intelogix.mx/privkey.pem;

  # Por default todo va al .NET
  location / {
    proxy_pass http://127.0.0.1:5050;
    # ...
  }

  # Excepciones al Node (si necesitas mantener algunos endpoints alli)
  # location /api/legacy/ {
  #   proxy_pass http://127.0.0.1:3000;
  # }
}
```

El Node corre en `:3000`, el .NET en `:5050`. Misma DB, misma audit chain.
Cuando el .NET pase la fase de prueba en piloto, descartas el Node:

```bash
systemctl stop botdot-node    # si lo tienes como service
# o
pm2 delete botdot              # si usas pm2
```

## Pre-deploy checklist (.NET)

- [ ] `BotDot:Env = "Production"` en `appsettings.Production.json`
- [ ] `BotDot:Anthropic:Mock = false` + API key real
- [ ] `BotDot:Samsara:Mock = false` + token real (read-only)
- [ ] `BotDot:Email:Mock = false` + SMTP real
- [ ] `BotDot:Auth:JwtSecret` y `CookieSecret` regenerados (cada uno >=64 chars)
- [ ] `BotDot:Email:EscalationsTo = "compliance@intelogix.mx"` (alias)
- [ ] Rotar password default `changeme123` del admin sembrado
- [ ] MySQL prod: aplicar GRANTs minimos (REVOKE UPDATE/DELETE/TRIGGER/DROP/ALTER)
- [ ] systemd `botdot-net.service` enabled + started
- [ ] nginx reverse proxy + Let's Encrypt activos
- [ ] Firewall: 22, 80, 443 (cerrar 5050 al exterior)
- [ ] Cron de backup MySQL configurado con S3/R2 destination
- [ ] Monitoring: UptimeRobot pinging `https://dispatch.intelogix.mx/api/health`

## Operacion

### Ver logs

```bash
journalctl -u botdot-net -f --since "1 hour ago"
journalctl -u botdot-net --grep "audit_chain_failure"   # buscar errores criticos
```

### Restart graceful

```bash
systemctl restart botdot-net
# El service hace SIGTERM → app drena conexiones HTTP → cierra MySQL pool → exit
# /api/health responde 503 durante drain → load balancer (si hubiera) deriva trafico
```

### Backups

```bash
# Cron diario en /etc/cron.daily/botdot-backup
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/home/botdot/backups
mkdir -p $BACKUP_DIR
mysqldump -u botdot -p<PASSWORD> botdot \
  --single-transaction --quick --skip-lock-tables \
  | gzip > $BACKUP_DIR/botdot_$TIMESTAMP.sql.gz
# Subir a S3/R2 (requiere aws-cli o rclone configurado)
aws s3 cp $BACKUP_DIR/botdot_$TIMESTAMP.sql.gz s3://intelogix-botdot-backups/
# Limpiar locales >7 dias
find $BACKUP_DIR -name "botdot_*.sql.gz" -mtime +7 -delete
```

### Upgrade .NET app

```bash
cd /home/botdot/botdot
git pull
cd dotnet
dotnet publish BotDot.Web -c Release -o /home/botdot/publish
# Mantener el appsettings.Production.json — no se pisa con el publish
sudo systemctl restart botdot-net
sudo systemctl status botdot-net
curl https://dispatch.intelogix.mx/api/health
```

### Verificar audit chain integridad

```bash
# Endpoint .NET (admin/compliance)
curl -b cookies.txt https://dispatch.intelogix.mx/api/audit/verify?full=1
# Esperado: { "intact": true, "rows_checked": N, ... }

# Si "intact": false → INVESTIGAR INMEDIATAMENTE
# Probable causa: alguien modifico audit_log via SQL directo (revocaste TRIGGER?)
```

## Troubleshooting

### Service no inicia

```bash
journalctl -u botdot-net --since "5 minutes ago"
# Causas comunes:
#   - JwtSecret <32 chars (JwtService throws en startup)
#   - DB connection refused (verificar mysql.service y password)
#   - Puerto 5050 ocupado (cambiar Kestrel:Endpoints en appsettings)
```

### "Invalid host" en nginx

```bash
nginx -t  # ver error
# Probable: server_name no matchea el Host header del request.
# Fix: agregar el dominio a server_name o setear default_server.
```

### MySQL "Too many connections"

El .NET usa pool de 10 (configurable en `BotDotOptions.Db.ConnectionString` con
`MaximumPoolSize`). Si lo excedes con N workers concurrentes, ajustar:
```
"MaximumPoolSize=20"  # en BotDotOptions.cs Db.ConnectionString
```

### Audit chain rota

**Critico**. Stop el service inmediato. Investigar:
1. `SELECT * FROM audit_log ORDER BY id DESC LIMIT 5` — la ultima fila es nueva o vieja?
2. `node scripts/verify-audit-chain.js` (del Node) — desde donde se rompio?
3. Restaurar desde backup que precede el corte.
4. Revisar quien tuvo acceso a MySQL en el ultimo periodo.

## Costo operativo estimado (.NET)

| Item | $/mes |
|---|---|
| VPS (DigitalOcean / Hetzner) | $12-25 |
| Claude API (con prompt caching) | $200-400 |
| Samsara API | incluido en plan del cliente |
| MySQL backup S3/R2 | $1-3 |
| **Total** | **~$215-430** |

Sin diferencia significativa vs Node — los costos dominantes son Claude API y
Samsara, no el VPS.
