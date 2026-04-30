# Security Posture — BOTDOT v0.1.0

**Fecha del audit**: 2026-04-30
**Build auditado**: `3c95d4c`
**Ambito**: aplicacion completa (auth, RBAC, queries, uploads, audit chain,
deps, headers, mock mode, IDOR).
**Metodo**: lectura de codigo + smoke tests sobre server vivo.

---

## Resumen ejecutivo

✅ **No hay hallazgos CRITICAL.**
✅ **2 HIGH cerrados** (xlsx CVE → migrado; multer hardening).
✅ **8 MEDIUM cerrados.**
✅ **6 LOW cerrados** (en este pase).

Build aprobado para staging interno. Pendiente checklist Pre-deploy
(GRANTs prod MySQL, NODE_ENV=production, real API keys, TLS) antes de
exposicion publica.

---

## Defensas activas

### Authentication
- ✅ bcrypt cost 12 (incrementado de 10).
- ✅ JWT en cookie `httpOnly + Secure (en prod) + SameSite=Strict` — CSRF cubre.
- ✅ Bearer auth removido del middleware (cookie-only, reduce surface area).
- ✅ Lockout per-account tras 10 intentos fallidos consecutivos.
- ✅ Rate limit IP en `/login` (30/15min) — defensa secundaria contra brute force.
- ✅ Force-change-password tras admin reset.
- ✅ User enumeration: mismo mensaje "Credenciales invalidas" para user
  inexistente vs password errada.
- ✅ Audit en cada lockout / password change / reset (`account_locked`,
  `password_changed_by_user`, `user_management`).

### Authorization (RBAC)

5 roles en jerarquia: `dispatcher | supervisor | compliance | manager | admin`.
Cada endpoint protegido por `requireRole(...)` per-route (no `router.use`
global despues del fix M6).

Self-protection: admin no puede cambiarse su propio rol ni desactivarse.
Last-admin: no podes degradar/desactivar al ultimo admin activo.

Matrix verificada en QA con 30 checks (ver QA_REPORT.md).

### Audit log tamper-evidence

3 capas de defensa:

1. **Triggers MySQL** (migration 002) — `BEFORE UPDATE/DELETE` aborta con
   `SIGNAL SQLSTATE '45000'`.
2. **GRANTs MySQL prod** (DEPLOY.md paso 8b) — el app user tiene
   `REVOKE UPDATE, DELETE` sobre `audit_log` y `REVOKE TRIGGER, DROP, ALTER`
   sobre la database. Aunque haya SQLi, no puede dropear los triggers ni
   modificar audit.
3. **Hash chain SHA-256** (`src/db/audit-chain.js`):
   - Cada fila guarda `prev_hash` (= row_hash de la anterior).
   - `row_hash = SHA-256(prev_hash || canonical(contenido))`.
   - `appendAudit()` toma `GET_LOCK` MySQL para serializar inserciones.
   - `verifyChain()` recalcula y reporta breaks.
   - Cualquier mutacion historica deja el hash desincronizado y se detecta.

### Input validation

- ✅ **SQL**: parameterized queries (`?` placeholders) en TODA la base de
  codigo. Cero string interpolation con datos del usuario.
- ✅ **Body size cap**: `express.json({ limit: '256kb' })` global.
- ✅ **Whitelisted enums** en query params (notifications, escalations).
- ✅ **Length caps** por campo en PATCH `/admin/drivers/:id` (notes ≤4000,
  otros 32-128).
- ✅ **Date format validation** (`YYYY-MM-DD` strict) — evita errores oscuros
  de MySQL.
- ✅ **Allowlist** de campos permitidos en mass-assign de PATCHs.

### Output encoding (XSS)

- ✅ `escapeHtml` consistente en interpolacion de DOM con datos de DB
  (auditado y cerrado en M2 — antes habia 7 spots inconsistentes).
- ✅ `formatMessage` en chat aplica escapeHtml ANTES de markdown rendering.
- ✅ CSP `script-src 'self'` SIN `'unsafe-inline'` — un XSS escapado-faltante
  no se convierte en JS arbitrario.
- ✅ 3 inline scripts movidos a archivos externos (`/js/login.js`, etc).
- ✅ `users.html` usa `meta http-equiv="refresh"` en vez de inline script.

### File upload

- ✅ **Chat attachments**: multer in-memory storage. Sin disco → sin path
  traversal. Validacion de MIME + size + count.
- ✅ **Driver Excel import**: `fileFilter` (xlsx/xls/csv only), originalname
  saneado con `path.basename + regex`, cleanup garantizado en success/error
  paths.
- ✅ **Migracion de `xlsx` a `exceljs`** — `xlsx@0.18.5` tenia CVE de
  prototype pollution + ReDoS.

### Headers (helmet)

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.tailwindcss.com
                         https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' ...;
                         frame-ancestors 'self'; base-uri 'self'; form-action 'self';
                         object-src 'none'; manifest-src 'self'; worker-src 'self';
                         upgrade-insecure-requests
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

### Concurrency / DoS controls

- ✅ Inflight gate per-user en `/chat/send` (no concurrent requests).
- ✅ Rate limit per-user en `/chat/send` (30/min, configurable).
- ✅ Budget caps USD en chat (24h rolling, per-user $5 + per-org $25 default).
- ✅ Pagination obligatoria en `/audit/verify` (max 1000 rows, `full=1`
  requiere admin).
- ✅ Hard caps en `LIMIT` de queries (max 100-2000 segun endpoint).

### Static file serving

- ✅ `express.static` apuntando a `public/` solamente.
- ✅ Verificado: `.env`, `server.js`, `node_modules/`, `migrations/`, `data/`,
  `scripts/`, `test/`, `.git/` NO accesibles via HTTP (caen a SPA fallback
  con HTML del login).
- ✅ `data/imports/` (uploads del driver import) gitignored y no servido
  por static.

### Logging

- ✅ pino structured logging.
- ✅ Redact paths: `*.password`, `*.password_hash`, `*.token`, `*.api_key`,
  `req.headers.authorization`, `req.headers.cookie`, `body.password`,
  `body.current_password`, `body.new_password`.
- ✅ pino-http agrega `request_id`, `user_id`, `role` automaticamente a cada
  log line.
- ✅ Audit failures: log CRITICAL a stderr (bypass pino buffer).

---

## Threat model resumen

### Threats considerados

| Threat | Defensa |
|---|---|
| Brute force login | Lockout 10x + rate limit IP 30/15min |
| Password DB leak | bcrypt cost 12 + DB encryption at rest (recomendado, no implementado) |
| SQLi | Parameterized queries en 100% del codigo |
| XSS persistente | escapeHtml en frontend + CSP sin unsafe-inline |
| CSRF | SameSite=Strict + cookie httpOnly |
| Clickjacking | X-Frame-Options + CSP frame-ancestors |
| Session hijacking | httpOnly + Secure + 8h expiracion + audit |
| IDOR (chat conversations) | `WHERE user_id = ?` en query, 404 si no es del usuario |
| IDOR (attachments) | Owner check + roles privilegiados explicitos |
| Path traversal (uploads) | path.basename + sanitize regex en filename |
| Prototype pollution (xlsx CVE) | Migrado a exceljs |
| ReDoS (xlsx CVE) | Mismo |
| Mass assignment | Allowlist de campos en PATCHs |
| Audit log tampering | 3 capas (triggers + GRANTs + hash chain) |
| Audit log delete (TRUNCATE) | REVOKE DROP en MySQL prod (TRUNCATE requiere DROP) |
| Audit triggers drop | REVOKE TRIGGER en MySQL prod |
| LLM prompt injection | System prompt regla 1 + log_off_topic con category=injection_attempt |
| LLM evasion (false logs, etc) | System prompt regla 4 + log_refused_request |
| Cost runaway (LLM) | Budget caps USD per-user + per-org, 24h rolling |
| DoS via verify (full chain scan) | Pagination obligatoria, max 1000 rows |
| DoS via uploads | fileSize 5MB chat / 20MB import, count caps |
| Open redirect | No usamos redirects con input del usuario |
| Server-side request forgery | No tomamos URLs del usuario para fetch (eCFR es URL fija) |
| Information disclosure (404) | SPA fallback en HTML pages, JSON 404 en /api/* |
| Information disclosure (errors) | Mensajes genericos accionables, stack traces solo en logs |
| Privileged role escalation | requireRole gate + self-protection + last-admin check |
| Account takeover via reset | Reset requiere admin auth + force-change-password en next login |
| Audit chain in-flight failure | Fail-loud (CRITICAL log + stderr direct) |

### Threats fuera de scope MVP (deuda tecnica)

- **Audit chain external anchoring** — hoy se verifica contra si misma. Un
  atacante con write a la DB puede rotar TODOS los hashes coherentemente.
  Mitigacion: cron diario que copia `head_hash + timestamp` a S3 con object
  lock o RFC 3161 timestamp service. **Severity**: MEDIUM, no exploit
  practico sin DBA-level access.
- **DB encryption at rest** — passwords y CDL #s estan en plaintext en
  MySQL. Si alguien copia el `.frm`/`.ibd`, los hashes bcrypt protegen
  passwords pero CDL #s estan expuestos. Mitigacion: MySQL TDE o filesystem
  encryption (LUKS).
- **Real-time intrusion detection** — no hay SIEM ni alertas en tiempo real
  de patrones sospechosos (ej. burst de 401s, escalation de privilegios).

### Threats fuera de scope para esta arquitectura

- **Driver impersonation** — el bot NO habla con drivers. Solo usuarios
  internos autenticados.
- **Privilege escalation via Samsara** — Samsara API token es read-only
  por config (segun checklist al cliente).
- **Supply chain via npm** — `npm audit` corre periodicamente. xlsx ya
  removido. tar+node-pre-gyp HIGH son devDep transitivos de sharp
  (build-time, no runtime).

---

## Hallazgos del audit y fixes aplicados

### HIGH cerrados

#### H1 — `xlsx@0.18.5` Prototype Pollution + ReDoS
- **Origen**: npm audit. `xlsx` (sheetjs) abandonado en npm desde 2023.
- **Impacto**: Excel malicioso → contaminar `Object.prototype` → comportamiento
  server-wide alterado, o ReDoS regex catastrofico.
- **Fix**: migrado a `exceljs`. `src/utils/import-drivers.js` y
  `scripts/inspect-xlsx.js` reescritos. Tests 185/185 siguen pasando.

#### H2 — Driver Excel upload sin fileFilter ni sanitize
- **Origen**: revision manual.
- **Impacto**: aceptaba `.exe`, `.html`, etc. `originalname` con `../` posible.
- **Fix**: `fileFilter` xlsx/xls/csv, `path.basename + regex` para filename,
  cleanup garantizado en success y error paths.

### MEDIUM cerrados

#### M1 — CSP `'unsafe-inline'` en scripts
- **Impacto**: un XSS escapado-faltante se convierte en JS arbitrario.
- **Fix**: 3 inline scripts movidos a `/js/login.js`, `/js/change-password.js`,
  meta-refresh en `users.html`. CSP scripts ahora: `'self' https://cdn.tailwindcss.com
  https://cdn.jsdelivr.net`.

#### M2 — escapeHtml inconsistente en frontend
- **Impacto**: 7 spots con `${e.user_role}`, `${e.category}`, `${n.cdl_state}`
  sin escapar. XSS persistente posible si admin pollutea datos.
- **Fix**: aplicado escapeHtml en todos.

#### M3 — Audit failures swallowed silently
- **Impacto**: si appendAudit fallaba en lockout audit, el lockout sucede
  pero NO queda registro. Para compliance es gap.
- **Fix**: log CRITICAL via pino + stderr directo (bypass buffers).

#### M5 — DEPLOY.md GRANTs incompletos
- **Impacto**: si admin de DB sigue al pie de la letra el doc, faltan REVOKE
  para `ALTER` y verificacion explicita.
- **Fix**: bloque expandido con `ALTER`, comandos de verificacion (deben
  fallar), y opcion B con dos usuarios MySQL para alta seguridad.

#### M6 — RBAC bug: compliance bloqueado del admin router
- **Impacto**: `router.use(requireRole('admin'))` bloqueaba TODO, incluso
  rutas con `requireAdminOrCompliance` posterior. Compliance no podia
  importar drivers.
- **Fix**: removido el guard global; cada ruta gateada explicitamente.

#### M7 — `/audit/verify` sin paginacion
- **Impacto**: en 6 meses con 50k+ filas, single request = full table scan
  + 50k SHA-256 (DoS interno).
- **Fix**: cap default 1000 filas. `full=1` requiere admin. Rangos >1000
  rechazados con 400.

#### M8 — `/api/*` 404 devolvia HTML del SPA
- **Impacto**: clientes que pegaban a endpoints API mal escritos recibian
  el HTML del login con 200. Confunde debug y rompe contratos.
- **Fix**: `app.use('/api', ...)` antes del SPA fallback retorna JSON 404.

### LOW cerrados

| ID | Issue | Fix |
|---|---|---|
| L1 | bcrypt cost 10 | Subido a 12 en todos los hash points |
| L3 | `notifications` query params sin whitelist | Validacion explicita contra Sets |
| L4 | PATCH drivers sin length cap ni date format | Caps por campo + regex `YYYY-MM-DD` |
| L5 | Bearer auth innecesario | Removido (cookie-only) |
| L7 | Cache-Control attachments agresivo | Cambiado a `no-store` |

### Aceptados como deuda tecnica

| ID | Issue | Por que |
|---|---|---|
| M4 | Audit chain sin anclaje externo | Mejora post-MVP. Requiere infra extra (S3/object-lock o TSA). No exploitable sin DBA-level access. |
| L2 | CDL # visible a dispatchers via `/drivers-at-risk` | Decision de producto. Dispatchers necesitan saber estado de CDL para asignar. Si fuera mas restrictivo, tendrian que pedir info constantemente. |
| L6 | tar + node-pre-gyp HIGH transitivos | DevDep build-time de sharp. No runtime user input flow. Resolucion en sharp upstream. |

---

## Pre-deploy checklist (operacional, NO codigo)

Antes de exponer publicamente:

- [ ] `NODE_ENV=production` en server (activa cookie.secure=true).
- [ ] `BOTDOT_MOCK_LLM=false`, `BOTDOT_MOCK_SAMSARA=false`,
      `BOTDOT_MOCK_EMAIL=false`.
- [ ] `ANTHROPIC_API_KEY` real seteada (en server, NO en dev).
- [ ] `SAMSARA_API_TOKEN` real seteado (read-only en HOS/drivers/vehicles).
- [ ] `JWT_SECRET` y `COOKIE_SECRET` regenerados (`openssl rand -hex 64` cada uno).
- [ ] SMTP credentials (`BOTDOT_SMTP_*`) para emails reales.
- [ ] `BOTDOT_ESCALATIONS_TO` con alias compliance@intelogix.mx.
- [ ] Default admin password `changeme123` rotada (login una vez, change-password).
- [ ] VPS Ubuntu 22.04 LTS aprovisionado.
- [ ] DNS subdominio (ej. `dispatch.intelogix.mx`) → IP del VPS.
- [ ] nginx reverse proxy configurado (ver DEPLOY.md).
- [ ] Let's Encrypt con auto-renewal (certbot).
- [ ] MySQL prod: aplicar bloque GRANT/REVOKE (DEPLOY.md paso 8b).
- [ ] MySQL prod: opcion B con `botdot_migrator` + `botdot` users separados.
- [ ] pm2 startup configurado (sobrevive reboot del VPS).
- [ ] Firewall: solo 22, 80, 443 expuestos.
- [ ] Backup cron diario (`scripts/backup.sh`) → S3/R2/B2 con bucket dedicado.
- [ ] Monitoring: Grafana/Datadog/UptimeRobot pingueando `/api/health`.
- [ ] Alerting: PagerDuty/Slack para 5xx burst, audit chain breaks, budget cap hits.

---

## Mantenimiento continuo

### Semanal
- Revisar `npm audit`. Trackear si tar/node-pre-gyp se resuelven en sharp.
- Verificar que `data/imports/` se limpia (cleanup post-import deberia
  garantizarlo).
- Revisar logs de `audit_chain_failure` (si aparece, investigar).

### Mensual
- Rotacion de `JWT_SECRET` (invalidates all sessions — coordinar mantenimiento).
- Run de `node scripts/verify-audit-chain.js` full-scan offline.
- Revisar usuarios inactivos > 90 dias y desactivar.
- Snapshot del `audit_log.row_hash` head a anclaje externo (cuando se implemente M4).

### Trimestral
- Penetration test externo (third party).
- Revision del system prompt con compliance officer (¿hay nuevas reglas
  duras? ¿algun caso de uso emergente?).
- Upgrade de deps mayores (`npm outdated`).

### Anual
- Audit completo equivalente a este (todo el threat model + nuevas amenazas).
- Tabletop exercise: ¿que hacemos si la audit chain se rompe? ¿si Samsara
  esta caido por 4h? ¿si Anthropic cambia precios 10x?

---

## Contactos

- **Product owner**: Juan Trejo (`juant@intelogix.mx`).
- **Compliance officer**: definido por Intelogix.
- **Reporte de vulnerabilidad**: contactar al PO. **NO** abrir issue publico
  con detalles del exploit hasta que este parchado.
