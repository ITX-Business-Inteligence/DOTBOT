# QA Report — BOTDOT v0.1.0

**Fecha**: 2026-04-30
**Tester**: Claude (Opus 4.7) en sesion supervisada
**Build**: commit `3c95d4c` en `main`
**Ambiente**: Windows 11 Pro + XAMPP (MySQL 10.5+) + Node 20+
**Modo**: Mock (LLM + Samsara + Email)

## Resumen ejecutivo

**307 / 307 checks automatizados pasados.** Sin fallos. Build aprobado para
exposicion local controlada (NO produccion publica todavia — pendiente
items de #3 Pre-deploy del roadmap).

| Suite | Pass | Fail |
|---|---:|---:|
| Tests unitarios (`npm test`) | 185 | 0 |
| Smoke tests (health, static, headers) | 40 | 0 |
| E2E auth + chat + audit + admin endpoints | 24 | 0 |
| RBAC matrix + L4 length caps + L4 dates | 30 | 0 |
| PWA assets + manifest + service worker | 28 | 0 |
| **Total** | **307** | **0** |

---

## Detalle de coverage

### 1. Tests unitarios — 185/185

```
node --test "test/*.test.js"
```

40 suites, 185 tests, ejecutados en ~5.5s. Cobertura:

- **HOS rules** (`test/hos-rules.test.js`) — `evaluateHosCompliance` contra
  49 CFR 395.3 (PROCEED / CONDITIONAL / DECLINE), bordes de gap, multiples
  violaciones simultaneas.
- **System prompt** (`test/system-prompt.test.js`) — verifica que las 11
  reglas duras existen, frase exacta de redirect off-topic, Parts criticos
  del 49 CFR. Si alguien edita el prompt y borra una regla, CI lo detecta.
- **Audit chain** (`test/audit-chain.test.js`) — `canonicalize` deterministico,
  `computeRowHash` reproducible, sensibilidad a cambios en cualquier campo.
- **Pricing** (`test/pricing.test.js`) — calculos de costo en formato API
  Anthropic y formato DB, todos los modelos, edge cases.
- **Tools registry** (`test/tools-registry.test.js`) — todos los tools tienen
  schema valido, names unicos, los que el system prompt nombra existen.
- **Import drivers** (`test/import-drivers.test.js`) — `normName`, `normCdl`,
  `normState`, `parseDate`, `levenshtein`, `namesMatch`.
- **Email** (`test/email.test.js`) — mock mode, fail-safe.
- **Mock LLM** (`test/mock-llm.test.js`) — pattern dispatch, classify, off-topic.
- **Expiration alerts** (`test/expiration-alerts.test.js`) — bucketing por
  thresholds (-1, 0, 7, 14, 30, 60).

### 2. Smoke tests — 40/40

#### Health + Static

| Item | Estado |
|---|---|
| `GET /api/health` = 200 application/json | ✓ |
| 15 estaticos (HTML, CSS, JS, imagenes, manifest, sw) = 200 | ✓ |

#### Headers de seguridad (helmet)

| Header | Verificado |
|---|---|
| `Content-Security-Policy` SIN `'unsafe-inline'` en scripts | ✓ |
| `Strict-Transport-Security` (HSTS) | ✓ |
| `X-Frame-Options` | ✓ |
| `X-Content-Type-Options: nosniff` | ✓ |
| `Referrer-Policy` | ✓ |

#### Routing

| Item | Estado |
|---|---|
| `GET /api/inexistente` → 404 JSON | ✓ |
| `GET /pagina-inexistente` → 200 SPA fallback | ✓ |
| `GET /users.html` → 200 (meta refresh a settings) | ✓ |

#### Auth gates (sin sesion)

10 endpoints autenticados retornan **401** sin cookie:
`/api/dashboard/basics`, `/audit`, `/api/chat/conversations`, `/api/admin/users`,
`/api/escalations`, `/api/notifications`, `/api/audit/verify`, `/api/audit/head`,
`/api/analytics/overview`, `/api/admin/sync/status`.

#### Login endpoint

| Caso | Esperado | Resultado |
|---|---|---|
| Body vacio | 400 | ✓ |
| Email vacio | 400 | ✓ |
| Credenciales invalidas | 401 | ✓ |
| Bearer token (no soportado) | 401 | ✓ |

### 3. E2E flow — 24/24

Login con `juant@citlogistics.us` (admin). Cookie capturada, ejercicio de:

- `GET /api/auth/me` retorna user logueado ✓
- `GET /api/dashboard/drivers-at-risk` retorna `{drivers:[], total_at_risk}` ✓
- `GET /api/dashboard/basics` (management) retorna BASICs snapshot ✓
- `GET /api/audit/head` retorna `{audit_id, row_hash, created_at}` ✓
- `GET /api/audit/verify` retorna `{intact:true, rows_checked:19}` ✓
- `GET /api/chat/conversations` lista conversaciones del usuario ✓
- `POST /api/chat/send` con mensaje → mock LLM responde ✓
- Conversacion creada con id valido, contiene 2 mensajes (user + assistant) ✓
- `GET /api/chat/conversations/:id/messages` carga el thread ✓
- `GET /api/audit/verify` post-chat sigue intacto ✓
- `GET /api/admin/users`, `/admin/drivers`, `/admin/sync/status`, `/admin/cfr/runs` (admin) ✓
- `GET /api/escalations`, `/escalations/badge-count` ✓
- `GET /api/notifications` ✓
- `GET /api/notifications?urgency=hack` rechaza con 400 (whitelist L3) ✓
- `GET /api/analytics/overview?period=7d` ✓
- `POST /api/auth/logout` retorna `{ok:true}` ✓
- `GET /api/auth/me` post-logout sin cookie = 401 ✓

### 4. RBAC matrix — 30/30

Cookies de 3 roles distintos exercitan toda la API. Resumen:

| Endpoint | dispatcher | compliance | admin |
|---|:---:|:---:|:---:|
| `/api/auth/me` | 200 | 200 | 200 |
| `/api/dashboard/drivers-at-risk` | 200 | 200 | 200 |
| `/api/chat/conversations` | 200 | 200 | 200 |
| `/api/dashboard/basics` (mgmt) | 403 | 200 | 200 |
| `/api/dashboard/audit` (mgmt) | 403 | 200 | 200 |
| `/api/admin/users` (admin only) | 403 | 403 | 200 |
| `/api/admin/drivers` (admin/compliance) | 403 | **200** | 200 |
| `/api/admin/sync/status` (admin only) | 403 | 403 | 200 |
| `/api/admin/cfr/runs` (mgmt) | 403 | 200 | 200 |
| `/api/escalations` (mgmt) | 403 | 200 | 200 |
| `/api/notifications` (mgmt) | 403 | 200 | 200 |
| `/api/audit/verify` (admin/compliance) | 403 | 200 | 200 |
| `/api/audit/head` (admin/compliance) | 403 | 200 | 200 |
| `/api/analytics/overview` (mgmt) | 403 | — | 200 |

Nota destacada: el M6 fix esta verificado — `compliance` ahora puede acceder
a `/api/admin/drivers` (antes era bloqueado por `router.use(requireRole('admin'))`).

#### L4: PATCH `/admin/drivers/:id` length caps + date validation

| Caso | Esperado | Resultado |
|---|---|---|
| `notes` con 4500 chars (cap=4000) | 400 | ✓ |
| `cdl_expiration` = "not-a-date" | 400 | ✓ |

### 5. PWA — 28/28

#### `manifest.json`

- `name`, `short_name`, `start_url`, `display`, `theme_color` presentes ✓
- `icons[]` con 192/512 + maskable ✓
- Content-Type `application/json` ✓

#### `sw.js`

- Install + fetch handlers ✓
- Distingue `/api/*` (network-only) vs estaticos (cache-first) ✓
- `CACHE_VERSION` para invalidacion ✓
- Content-Type `text/javascript` ✓

#### Tags PWA en HTML

8/8 paginas (`index, app, settings, drivers, escalations, notifications,
change-password, analytics`) tienen `<link rel="manifest">` y `<script src="/js/pwa.js" defer>`.

#### Iconos

| Archivo | Tamano | MIME |
|---|---:|---|
| `icon-192.png` | 15193 b | image/png ✓ |
| `icon-512.png` | 78754 b | image/png ✓ |
| `icon-maskable-192.png` | 7716 b | image/png ✓ |
| `icon-maskable-512.png` | 36614 b | image/png ✓ |
| `apple-touch-180.png` | 13729 b | image/png ✓ |
| `favicon-32.png` | 1754 b | image/png ✓ |

---

## Deuda tecnica conocida (no bloqueante)

Items del audit que quedaron pendientes para post-MVP:

- **M4** — Anclaje externo del audit head (cron a S3 con object lock).
- **L2** — CDL number como PII visible a dispatchers (decision de producto).
- **L6** — `tar` + `@mapbox/node-pre-gyp` HIGH transitivos de `sharp` (build-time
  devDep, no runtime; espera a que sharp publique upgrade).

Items previos fuera del scope del audit:

- **Logo fuente >=512×512** — el actual es 128×128, `icon-512.png` esta upscaled
  con lanczos3 → algo suave. Cuando haya logo grande, regenerar via
  `node scripts/generate-pwa-icons.js`.

---

## Bloqueantes para deploy publico (a resolver con accesos del cliente)

- API keys reales: `ANTHROPIC_API_KEY`, `SAMSARA_API_TOKEN`.
- Setear `NODE_ENV=production` (activa `cookie.secure: true`).
- Setear `BOTDOT_MOCK_LLM=false`, `BOTDOT_MOCK_SAMSARA=false`,
  `BOTDOT_MOCK_EMAIL=false`.
- VPS Ubuntu + DNS + Let's Encrypt + nginx reverse proxy.
- Aplicar bloque de GRANTs minimos sobre MySQL prod (ver `DEPLOY.md` paso 8b).
- pm2 para process supervision.
- Backup cron diario (`scripts/backup.sh` + S3/R2/B2 destination).

---

## Veredicto

✅ **APROBADO para staging/QA interno.**

⚠️ **NO APROBADO para produccion publica** hasta completar checklist de
Pre-deploy (ver tabla anterior). Build esta listo desde el lado de codigo;
las acciones pendientes son operacionales (infraestructura + secretos).
