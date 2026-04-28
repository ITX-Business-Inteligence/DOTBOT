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

# 6. MySQL
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

# 8. Init DB
node src/db/init.js

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

## Backups

### Diario de DB

```bash
# Crear /home/botdot/backup.sh
#!/bin/bash
DATE=$(date +%Y-%m-%d)
mysqldump -u botdot -pPASSWORD botdot | gzip > /home/botdot/backups/botdot-$DATE.sql.gz
# Subir a S3 / R2 / B2 (recomendado)
# aws s3 cp /home/botdot/backups/botdot-$DATE.sql.gz s3://botdot-backups/
# Limpiar locales > 7 dias
find /home/botdot/backups -name "*.sql.gz" -mtime +7 -delete
```

```bash
crontab -e
# Linea: 0 3 * * * /home/botdot/backup.sh
```

### Backup de .env y config

Guardar copia encriptada en bitwarden / 1Password / KeePass del equipo.

## Updates

```bash
sudo -u botdot bash
cd /home/botdot/botdot
git pull
npm install --production
# Si hay migrations:
# node src/db/migrate.js
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
| `ANTHROPIC_API_KEY` | api key de prod (separada de dev) |
| `SAMSARA_API_TOKEN` | token con permisos minimos (read en HOS, drivers, vehicles) |

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
