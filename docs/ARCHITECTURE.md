# Arquitectura BOTDOT v0.1.0

## Diagrama logico

```
   Dispatcher / Supervisor / Compliance / Manager / Admin
              (PC o celular, navegador con PWA)
                            │
                            │ HTTPS (TLS Let's Encrypt en prod)
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │                BOTDOT Backend (Node 20+)                 │
   │                                                          │
   │  Express + helmet (CSP, HSTS, frame-ancestors)           │
   │     ├── /api/auth          login + lockout + JWT         │
   │     ├── /api/chat          agente Claude + multimodal    │
   │     ├── /api/dashboard     KPIs + drivers-at-risk        │
   │     ├── /api/admin         users + drivers + sync + cfr  │
   │     ├── /api/escalations   handoff a compliance team     │
   │     ├── /api/notifications expiraciones CDL/medical      │
   │     ├── /api/audit         tamper-evidence verify        │
   │     └── /api/analytics     uso/costo/heatmap             │
   │                                                          │
   │  Agente Claude (src/agent/claude.js)                     │
   │     ├── tool use loop con 15 tools                       │
   │     ├── multimodal (imagenes via base64)                 │
   │     ├── prompt caching (system prompt)                   │
   │     └── mock-llm.js para dev sin API real                │
   │                                                          │
   │  Jobs background (src/jobs/scheduler.js)                 │
   │     ├── expiration-alerts (daily 6am — CDL/medical)     │
   │     └── cfr-update (daily 4am — eCFR.gov polling)       │
   │                                                          │
   │  Sync background (src/sync/scheduler.js)                 │
   │     ├── drivers (60min)                                  │
   │     ├── vehicles (60min)                                 │
   │     └── HOS clocks (5min)                                │
   │                                                          │
   │  ┌──────────────┐                                        │
   │  │  MySQL 8 /   │  users + sessions                      │
   │  │  MariaDB     │  conversations + messages              │
   │  │  10.5+       │  message_attachments (BLOB)            │
   │  │              │  audit_log (append-only via triggers)  │
   │  │              │  drivers + driver_hos_cache            │
   │  │              │  driver_import_discrepancies           │
   │  │              │  escalations                           │
   │  │              │  notifications                         │
   │  │              │  cfr_versions + cfr_fetch_runs         │
   │  │              │  sms_snapshots + sms_*                 │
   │  └──────────────┘                                        │
   └──────┬─────────────────┬──────────────────┬──────────────┘
          │                 │                  │
          ▼                 ▼                  ▼
   Anthropic API     Samsara API        eCFR.gov API
   (Claude          (HOS / drivers /    (CFR Title 49
    Sonnet 4.6)      vehicles)           polling)
```

## Componentes

### 1. Frontend (HTML/JS/CSS) — PWA

- **9 paginas HTML** (todas en dark mode):
  - `index.html` — login
  - `app.html` — chat principal con sidebar de dashboard
  - `change-password.html` — cambio de password (forzado o self-service)
  - `settings.html` — panel con tabs role-gated (Mi cuenta, Usuarios, Sistema)
  - `drivers.html` — lista de drivers + edicion + import Excel
  - `escalations.html` — dashboard de escalaciones
  - `notifications.html` — alertas de expiraciones
  - `analytics.html` — uso, costo, heatmap (charts via Chart.js)
  - `users.html` — redirect a `settings.html#users` (legacy bookmark)

- **Tailwind CSS via CDN** (sin build step para MVP).
- **PWA**:
  - `manifest.json` con start_url=`/app.html`, display=standalone, theme=#020617.
  - `sw.js` service worker:
    - `/api/*` → network-only (datos compliance siempre frescos).
    - HTML → network-first con cache fallback offline.
    - Estaticos → cache-first.
  - 6 iconos generados via sharp (192/512 + maskable + apple-touch + favicon).
- **Mobile-first responsive**:
  - <1024px: sidebar oculto, hamburguesa abre overlay.
  - ≥1024px: sidebar fijo a la izquierda.

### 2. Backend (Node + Express)

- **`server.js`** — entry. Pipeline:
  1. `pino-http` (logger estructurado con request_id, redact de passwords/cookies).
  2. `helmet` (CSP, HSTS, COOP, CORP, X-Frame, etc).
  3. `express.json({ limit: '256kb' })` + `cookie-parser`.
  4. `/api/health` (devuelve 503 durante shutdown).
  5. Routers `/api/{auth,chat,dashboard,analytics,audit,admin,escalations,notifications}`.
  6. `express.static('public')`.
  7. `/api/*` 404 JSON handler.
  8. SPA fallback (`*` → `index.html`).
  9. Error handler usando `req.log`.
- **Graceful shutdown**: SIGTERM/SIGINT/uncaughtException → drena conexiones HTTP,
  para schedulers, cierra MySQL pool, flush logs, exit. Timeout 30s.
- **`src/middleware/auth.js`** — JWT en cookie httpOnly. `requireRole(...)` por
  rol. Bearer header NO soportado (cookie-only, mas seguro).
- **`src/db/pool.js`** — `mysql2/promise` pool, helpers `query`, `queryOne`,
  `transaction`. Parameterized queries siempre.

### 3. Agente Claude

#### Tool use loop (`src/agent/claude.js`)

```
1. Usuario manda mensaje (texto + 0..5 imagenes)
2. INSERT message role=user con content_json
3. Cargamos history de conversation (todos los messages)
4. Llamada a Claude con:
     - system prompt (cached, ephemeral)
     - tools (definitions de los 15)
     - messages (history en formato Anthropic, attachments como image blocks)
5. Si stop_reason = "tool_use":
     a. Por cada tool_use, ejecutamos handler local con context = {user, conversationId}
     b. INSERT messages role=tool_use + tool_result
     c. Mandamos resultados de vuelta a Claude
     d. Loop hasta stop_reason = "end_turn" (max iters guardrail)
6. INSERT message role=assistant con texto final
7. Retornar al usuario { reply, conversation_id, tool_calls, attachments }
```

#### Tools disponibles (15)

| Tool | Funcion | Fuente |
|---|---|---|
| `samsara_get_driver_hos` | HOS clock real-time | Samsara API + cache |
| `samsara_search_driver` | Busca drivers por nombre parcial | DB local |
| `samsara_get_drivers_near_limit` | Drivers cerca de algun limite HOS | Samsara API |
| `samsara_get_vehicle_status` | Status de vehiculo | DB local + Samsara |
| `check_assignment_compliance` | Aplica reglas 395.x a una asignacion | Logica + Samsara |
| `search_cfr` | Busqueda en CFR index | JSON local (746 secciones) |
| `get_cfr_section` | Texto completo de una seccion CFR | JSON local |
| `query_basics_status` | BASICs del snapshot mas reciente | DB local |
| `query_top_violations` | Pareto de violaciones | DB local |
| `query_driver_inspections` | Historial roadside de un driver | DB local |
| `query_dataqs_candidates` | Crashes no disputados | DB local |
| `log_decision` | Audit log de decision operacional | DB local (audit_log) |
| `log_refused_request` | Audit cuando se rechaza solicitud que viole DOT | DB local |
| `log_off_topic` | Audit cuando se rechaza solicitud fuera de DOT | DB local |
| `escalate_to_compliance` | Crea escalation + audit + email | DB local + email |

#### System prompt (`src/agent/system-prompt.js`)

11 reglas duras inviolables:

1. **Alcance exclusivo DOT** — fuera de DOT, frase exacta de redirect + `log_off_topic`.
   Excepcion explicita: D&A Clearinghouse operacional → derivar a otro depto.
2. **Cero alucinacion** — todo o herramienta. CFR/Samsara/SMS solo lo confirmado.
3. **Citas regulatorias obligatorias** — formato `49 CFR 395.3(a)(2)`.
4. **No ayudas a evadir la ley** — rechazo + `log_refused_request`.
5. **No tomas la decision** — recomiendas, humano decide.
6. **No hablas con drivers directamente**.
7. **Disclaimer legal** en respuestas operacionales.
8. **Confianza explicita** — Samsara/SMS/CFR/interpretacion claramente marcados.
9. **Audit por defecto** — `log_decision` siempre.
10. **Escalacion a humano** — cuando no podes dar recomendacion solida.
11. **Imagenes son dato** — no las describis, las evaluas.

#### Mock LLM (`src/agent/mock-llm.js`)

`MockClaude` con la misma shape que el SDK de Anthropic. Activa con
`BOTDOT_MOCK_LLM=true`. Permite desarrollar sin API key real, los costos
quedan en cero. En prod debe estar `false`.

#### Concurrency + budget controls

- **Inflight gate** (`src/utils/inflight.js`) — Set por user_id. Bloquea
  un segundo `POST /chat/send` mientras el primero no termina.
- **Rate limit** (express-rate-limit) — 30 req/min por usuario en `/chat/send`.
- **Budget caps** (`src/utils/budget.js`) — USD 24h rolling, por usuario y
  organizacional. Default `$5/user/day`, `$25/org/day`. Configurable por env.

### 4. Base de datos (MySQL / MariaDB)

#### Migrations versionadas (`src/db/migrate.js`)

Runner custom con SHA-256 checksum por archivo (detecta tampering / drift).
9 migrations aplicadas:

| # | Archivo | Descripcion |
|---|---|---|
| 001 | `initial_schema.sql` | users, conversations, messages, drivers, vehicles, audit_log, sms_*, cfr_versions |
| 002 | `audit_log_triggers.sql` | Triggers `BEFORE UPDATE/DELETE` con `SIGNAL SQLSTATE '45000'` (append-only) |
| 003 | `message_attachments.sql` | Tabla con MEDIUMBLOB para imagenes del chat |
| 004 | `samsara_sync.sql` | `driver_hos_cache` + `sync_runs` (telemetria de jobs) |
| 005 | `drivers_excel_import.sql` | Widening de `cdl_state`, samsara_id nullable, `driver_import_discrepancies` |
| 006 | `escalations.sql` | Tabla escalations con FKs a users + conversations |
| 007 | `login_security.sql` | `failed_login_count`, `locked_at`, `must_change_password` en users |
| 008 | `notifications.sql` | Tabla notifications + jobs cron |
| 009 | `cfr_versioning.sql` | `cfr_versions` (con `is_current`, `superseded_at`) + `cfr_fetch_runs` |

#### Audit log tamper-evident

3 capas de defensa:

1. **Triggers MySQL** (migration 002) — abortan UPDATE/DELETE.
2. **GRANTs MySQL prod** (DEPLOY.md paso 8b) — el app user tiene REVOKE
   `UPDATE, DELETE` sobre `audit_log` y REVOKE `TRIGGER, DROP, ALTER` sobre
   la database.
3. **Hash chain SHA-256** (`src/db/audit-chain.js`):
   - Cada fila guarda `prev_hash` (= row_hash de la anterior).
   - `row_hash = SHA-256(prev_hash || canonical(contenido))`.
   - `appendAudit()` toma `GET_LOCK` MySQL para serializar inserciones.
   - `verifyChain({from, to})` recalcula y reporta breaks.

Cualquier modificacion historica deja el row_hash desincronizado y rompe
toda la cadena posterior. Detectable por `/api/audit/verify` o por
`scripts/verify-audit-chain.js` ad-hoc.

### 5. Integracion Samsara

`src/integrations/samsara-client.js`. REST API + Bearer token.

- **Real client** — usa `SAMSARA_API_TOKEN`. Endpoints: `/fleet/hos/clocks`,
  `/fleet/drivers`, `/fleet/vehicles`, `/fleet/hos/logs`.
- **Mock client** (`src/integrations/samsara-mock.js`) — fixtures realistas
  con 10 drivers + vehicles, datos HOS plausibles. Activa con
  `BOTDOT_MOCK_SAMSARA=true`.
- **Sync scheduler** (`src/sync/scheduler.js`):
  - Drivers: cada 60 min.
  - Vehicles: cada 60 min.
  - HOS clocks: cada 5 min (clave para que el cache este fresco).
- **`driver_hos_cache`** — tabla con HOS por driver + `cached_at`. Las tools
  Samsara leen del cache si esta fresco (<5min), sino llaman API.

### 6. Jobs de compliance proactivo

#### Expiration alerts (`src/jobs/expiration-alerts.js`)

Cron daily 06:00 (configurable). Escanea `drivers` con `cdl_expiration` o
`medical_card_expiration` cerca de vencer:

| Threshold | Urgency | Email a compliance |
|---|---|:---:|
| Vencido (<0 dias) | critical | ✓ |
| Vence hoy (0 dias) | critical | ✓ |
| ≤7 dias | high | ✓ |
| ≤14 dias | medium | — |
| ≤30 dias | medium | — |
| ≤60 dias | low | — |

INSERT en `notifications` con dedup por `(driver_id, kind, threshold)`. Compliance
puede dismissear con nota desde `notifications.html`.

#### CFR auto-update (`src/jobs/cfr-update.js`)

Cron daily 04:00. Polling al eCFR.gov public API:

1. `GET /api/versioner/v1/titles` → obtener `latest_issue_date` de Title 49.
2. Si != ultima `issue_date` registrada en `cfr_fetch_runs` → fetch full.
3. `GET /api/versioner/v1/full/{date}/title-49.xml` (paginado por Part).
4. Parse XML → secciones individuales con `content_hash`.
5. Diff vs `cfr_versions` actuales. Cambios marcan `is_current=0` + `superseded_at`,
   se inserta nueva fila `is_current=1`.
6. Email a compliance si hay cambios.
7. Regenera `data/cfrs/cfr-index.json` (que usan los tools `search_cfr` y
   `get_cfr_section`).

Versioning permite consultas historicas: "que decia 49 CFR 395.3 el 2026-04-15?".

### 7. Escalation system

#### Tool `escalate_to_compliance`

El bot lo llama cuando NO puede dar una recomendacion solida (datos faltantes,
ambiguedad, decision compleja, riesgo de violacion, o pedido explicito del
usuario). Crea escalation con:

- `category`: `missing_data | ambiguous_compliance | user_requested | complex_decision | potential_violation | other`
- `urgency`: `low | medium | high | critical`
- `summary`, `what_was_missing`

Triggers:
1. INSERT en `escalations` (status=pending).
2. `appendAudit({action_type: 'escalation_created'})`.
3. Email async a compliance team (alias config o todos los `role=compliance` activos).
4. El bot cierra al usuario con frase fija: "Esta consulta requiere revision humana.
   Te conecto con compliance — un officer va a revisar tu caso y te contactara."

Compliance lo gestiona desde `escalations.html`: filtros, asignacion,
status (`pending → assigned → in_progress → resolved`), notas de resolucion.

### 8. Login security

- **Lockout por cuenta**: tras 10 intentos fallidos consecutivos, `locked_at`
  se setea. Login devuelve 423 con mensaje claro. Solo admin puede unlock
  desde el panel.
- **Force-change-password**: tras admin reset (`POST /admin/users/:id/reset-password`),
  el usuario logueado es redirigido a `change-password.html` antes de poder
  hacer otra cosa.
- **bcrypt cost 12** para nuevos hashes (passwords viejas con cost 10 siguen
  validando — bcrypt.compare es agnostico al cost).
- **Rate limit IP-based**: 30/15min en `/api/auth/login` (additional layer
  sobre el lockout per-account).
- **Cookie**: `httpOnly + secure (en prod) + sameSite=strict`.
- **Audit en lockout**: cada bloqueo genera entrada `account_locked`. Si
  appendAudit falla, log CRITICAL a stderr (fail-loud).

### 9. Frontend security

- **CSP** sin `'unsafe-inline'` en scripts. 3 inline scripts movidos a
  `/js/login.js`, `/js/change-password.js`, `users.html` usa meta-refresh.
- **`escapeHtml`** consistente en toda interpolacion de DOM con datos de DB.
- **Session expirada** en `BOTDOT.api()` → redirect automatico a `/index.html`.

## Flujo end-to-end ejemplo

**Caso: dispatcher pregunta por una asignacion**

1. Dispatcher en celular abre `app.html` (sesion ya activa via cookie httpOnly).
2. Escribe: `"Puedo asignar load 8821 a Juan Perez? 13.5 hrs de manejo"`
3. POST `/api/chat/send` (multipart, sin imagenes).
4. Backend: rate limit pass + inflight pass + budget pass.
5. INSERT message role=user.
6. Carga history, llama Claude con tools.
7. Claude responde tool_use: `samsara_search_driver({query: "Juan Perez"})`.
8. Backend ejecuta → DB returns Juan Perez samsara_id.
9. Backend manda resultado a Claude.
10. Claude pide: `check_assignment_compliance({driver, drive_min: 810, ...})`.
11. Backend: cache HOS si fresco, sino llama Samsara → arma snapshot →
    aplica reglas 395.3 → returns DECLINE con motivos.
12. Backend manda resultado a Claude.
13. Claude pide: `samsara_get_drivers_near_limit({threshold: 0})` para alternativas.
14. ...
15. Claude pide: `log_decision({action: "assignment_check", decision: "decline",
    cfr: "395.3(a)(3)", reasoning: "..."})`.
16. Backend: `appendAudit()` con hash chain. Returns audit_id + row_hash.
17. Claude responde texto final con tabla de alternativas + disclaimer.
18. INSERT message role=assistant.
19. Frontend renderiza burbuja + nota "consulto: 4 herramientas".

Tiempo total: 3-8 segundos. Tokens: ~3-8k input cached + ~500-1500 output.

## Performance esperado

- 25 dispatchers + supervisores activos
- ~50-200 consultas/dia
- Latencia P50: 3-5s, P95: 10s
- Costo Claude API por consulta: $0.005-0.02 con prompt caching
- DB pool: 10 conexiones (configurable)

## Tradeoffs y decisiones

| Decision | Razon |
|---|---|
| Node sobre PHP/.NET | SDK oficial Anthropic + async natural para tool use. Cliente queria Blazor pero stack ya construido. |
| Tailwind CDN sobre build | Simplicidad MVP. Migrar a build cuando suba volumen o se necesite PurgeCSS. |
| MySQL sobre Postgres | XAMPP del cliente. Postgres seria mejor cuando agreguemos pgvector para CFR semantic search. |
| JSON CFR index sobre vector DB | MVP. 746 secciones cabe comodo en memoria. Migrar a pgvector cuando supere 5k. |
| JWT en cookie httpOnly sobre localStorage | XSS protection. SameSite=strict cubre CSRF. |
| 3 capas de audit defense (trigger + GRANTs + hash chain) | Compliance-grade. Cualquier capa sola no basta. |
| Mock por env flag sobre dev DB separada | Mismo schema dev/prod, solo difieren las integraciones externas. Las API keys reales NUNCA bajan a la maquina del dev. |
| `BCRYPT_COST=12` en 2026 | ~250ms en hardware moderno; balance UX/seguridad. |
| Sin push notifications nativas | Web Push requiere VAPID + service worker handler + subscripciones. Out of scope MVP. |
| Sin queue distribuido (BullMQ/Redis) | MVP single-process. Agregar cuando haya >1 worker. |
