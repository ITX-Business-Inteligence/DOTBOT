# API Reference — BOTDOT v0.1.0

Catalogo completo de endpoints HTTP. Convenciones:

- **Base path**: `/api`
- **Auth**: cookie `botdot_token` httpOnly (set por `/api/auth/login`).
- **Format**: requests/responses JSON; `/api/chat/send` y `/api/admin/drivers/import`
  son `multipart/form-data`.
- **Rate limits**: ver detalle por endpoint.
- **Roles**: `dispatcher | supervisor | compliance | manager | admin`.
- **Errores estandar**: `400` (validacion), `401` (no auth), `403` (rol insuficiente),
  `404` (recurso no existe), `409` (conflicto: dup, chain broken),
  `423` (cuenta bloqueada), `429` (rate limit / inflight / budget),
  `500` (error interno), `503` (servicio externo).

---

## Auth

### `POST /api/auth/login`

Anonimo. Rate limit: 30/15min por IP. Lockout por cuenta tras 10 fallidos.

**Request**:
```json
{ "email": "user@intelogix.mx", "password": "..." }
```

**Response 200**:
```json
{
  "user": { "id": 1, "email": "...", "name": "...", "role": "admin" },
  "must_change_password": false
}
```
Set-Cookie: `botdot_token=<JWT>; HttpOnly; SameSite=Strict; Secure (en prod); Max-Age=28800`

**Errores**: 400 (campos faltantes), 401 (creds invalidas / user inactivo),
423 (cuenta bloqueada).

### `POST /api/auth/logout`

Anonimo (clear cookie regardless).

**Response 200**: `{ "ok": true }`

### `GET /api/auth/me`

Cualquier rol autenticado.

**Response 200**:
```json
{ "user": { "id": 1, "email": "...", "role": "admin", "name": "...", "must_change_password": false } }
```

### `POST /api/auth/change-password`

Cualquier rol autenticado. Rate limit: 10/15min por usuario.

**Request**:
```json
{ "current_password": "...", "new_password": "..." }
```

**Response 200**: `{ "ok": true }`

**Validaciones**: `new_password` ≥8 chars, distinta a la actual.
Genera audit `password_changed_by_user`.

---

## Chat

### `GET /api/chat/conversations`

Cualquier rol autenticado. Lista conversaciones del usuario logueado.

**Response 200**:
```json
{
  "conversations": [
    { "id": 16, "title": "...", "started_at": "...", "last_activity_at": "...", "message_count": 4 }
  ]
}
```

Limite: 50 mas recientes.

### `GET /api/chat/conversations/:id/messages`

Cualquier rol autenticado. **IDOR-safe**: query con `WHERE user_id = ?`, 404 si no es del usuario.

**Response 200**:
```json
{
  "messages": [
    { "id": 1, "role": "user", "content": [...], "created_at": "..." },
    { "id": 2, "role": "assistant", "content": [...], "created_at": "..." }
  ]
}
```

### `POST /api/chat/send`

Cualquier rol autenticado. **multipart/form-data**.

Rate limit: 30 req/min por usuario. Inflight gate (no concurrent).
Budget cap: $5/user/day, $25/org/day (configurable).

**Form fields**:
- `message` (string) — texto del usuario
- `conversation_id` (int, optional) — si existe, append; sino crea nueva
- `files[]` (file, 0..5) — imagenes (jpeg/png/webp/gif), max 5MB c/u, 20MB total

**Response 200**:
```json
{
  "conversation_id": 16,
  "reply": "Texto de respuesta del bot...",
  "iterations": 2,
  "tool_calls": ["samsara_search_driver", "log_decision"],
  "attachments": [
    { "id": 5, "mime_type": "image/png", "byte_size": 12345, "sha256": "...", "original_name": "screenshot.png" }
  ]
}
```

**Errores**:
- 400 — sin mensaje ni archivos, o validacion de attachment fallo (tipo/tamano).
- 429 — rate limit, inflight, o budget cap.
- 503 — Anthropic API issues (mapeado de 401/429/5xx upstream).

### `GET /api/chat/attachments/:id`

Owner de la conversacion **o** roles `admin|compliance` (compliance review).
Headers: `Cache-Control: no-store` (no leak en browsers compartidos).

**Response**: binary blob con `Content-Type` original.

---

## Dashboard

### `GET /api/dashboard/drivers-at-risk`

**Cualquier rol autenticado.** Drivers con CDL/medical proximas a vencer.

**Query**:
- `limit` (int, max 100, default 10)
- `horizon_days` (int, max 365, default 60)

**Response 200**:
```json
{
  "drivers": [
    {
      "id": 5, "samsara_id": "...", "full_name": "...",
      "cdl_number": "...", "cdl_expiration": "2026-05-15",
      "cdl_days": 15, "medical_card_expiration": "2026-09-01",
      "medical_days": 124, "soonest_kind": "cdl", "soonest_days": 15
    }
  ],
  "total_at_risk": 3, "shown": 3, "has_more": false, "horizon_days": 60
}
```

### `GET /api/dashboard/basics`

**admin | compliance | manager**. Snapshot mas reciente de los 7 BASICs.

**Response 200**:
```json
{ "basics": [ { "basic_name": "Unsafe Driving", "score_pct": 72, "threshold_pct": 65, "alert": 1, ... } ] }
```

### `GET /api/dashboard/kpis`

**admin | compliance | manager**. KPIs ejecutivos.

**Response 200**:
```json
{ "basics_in_alert": 4, "crashes_24m": 12, "dataqs_candidates": 3, "overrides_30d": 0 }
```

### `GET /api/dashboard/audit`

**admin | compliance | manager**. Lista ultimas N entradas del audit log.

**Query**: `limit` (max 200, default 50).

**Response 200**:
```json
{
  "entries": [
    { "id": 19, "action_type": "log_decision", "decision": "proceed", "cfr_cited": "...", "reasoning": "...", "user_name": "...", "user_role": "...", "created_at": "..." }
  ]
}
```

---

## Admin (gestion de usuarios + drivers + sync + cfr)

Todos requieren autenticacion. Las roles especificas se anotan por endpoint.

### `GET /api/admin/users`  *admin*

Lista todos los users con metadata. Sanitizado (no expone hashes).

### `POST /api/admin/users`  *admin*

Crea un user.

**Request**:
```json
{ "email": "...", "full_name": "...", "password": "...", "role": "dispatcher" }
```

Validaciones: email format, role en whitelist, password ≥8 chars.
**409** si email ya existe. Genera audit `user_management`.

### `PATCH /api/admin/users/:id`  *admin*

Actualiza user. Solo campos: `full_name`, `email`, `role`, `active`.

**Self-protection**: no podes cambiarte tu rol ni desactivarte.
**Last-admin**: no podes degradar/desactivar al ultimo admin activo.

### `POST /api/admin/users/:id/reset-password`  *admin*

Resetea password (genera o usa la del body). Marca `must_change_password=1`,
desbloquea cuenta. Devuelve la nueva password en plaintext **una sola vez**.

**Request** (opcional): `{ "password": "..." }`. Si vacio, genera ~12 chars aleatorios.

**Response 200**: `{ "password": "...", "hint": "Compartelo por canal seguro." }`

### `POST /api/admin/users/:id/unlock`  *admin*

Desbloquea cuenta tras lockout por intentos fallidos.

**Errores**: 400 si la cuenta no esta bloqueada.

### `DELETE /api/admin/users/:id`  *admin*

**Siempre 405** — borrado fisico no permitido. Usar PATCH con `active: false`.

### `GET /api/admin/drivers`  *admin | compliance*

Lista drivers con dias hasta CDL/medical expiration.

**Query**: `show=all` para incluir inactivos. Default solo activos.
Limite hard 2000.

### `PATCH /api/admin/drivers/:id`  *admin | compliance*

Edita driver. Allowlist de campos: `cdl_number, cdl_state, cdl_expiration,
medical_card_expiration, endorsements, phone, hire_date, company, location,
division, notes, active`.

**Validaciones**:
- Length caps (notes ≤4000, otros ≤32-128).
- Fechas: `YYYY-MM-DD` strict.
- Marca `data_source='samsara+excel' | 'manual'` si tocas compliance fields.

Genera audit `driver_management`.

### `POST /api/admin/drivers/import`  *admin | compliance*

Multipart `file` field. **Solo .xlsx, .xls, .csv** (fileFilter por MIME + ext).
Cap 20MB. originalname sanitizado para prevenir path traversal.

**Query**: `commit=1` para ejecutar (default dry-run).

Pipeline: parse → matching fuzzy contra Samsara → diff → INSERTs +
`driver_import_discrepancies` para excel-only y samsara-only.

### `GET /api/admin/drivers/discrepancies`  *admin | compliance*

Lista discrepancies del ultimo import.

**Query**: `source=excel_only|samsara_only`, `resolved=1` para incluir resueltas.

### `POST /api/admin/drivers/discrepancies/:id/resolve`  *admin | compliance*

Marca discrepancy como resuelta con nota.

**Request**: `{ "note": "..." }` (opcional).

### `GET /api/admin/sync/status`  *admin*

Ultimas 30 corridas de Samsara sync + ultima exitosa por resource.

### `POST /api/admin/sync/run/:resource`  *admin*

Force-run de sync ad-hoc. Resources: `drivers | vehicles | hos_clocks`.

### `GET /api/admin/cfr/runs`  *admin | compliance | manager*

Historial de fetch runs del CFR auto-update job.

**Query**: `limit` (max 200, default 30).

### `GET /api/admin/cfr/versions/:section`  *admin | compliance | manager*

Historial de versiones de una seccion CFR (ej. `395.3`). Util para auditoria
("que decia esta seccion el 2026-04-15?").

### `POST /api/admin/cfr/run`  *admin*

Force-run del job CFR update.

---

## Escalations

Todos requieren **admin | compliance | manager**.

### `GET /api/escalations/badge-count`

Conteo de no-resueltas (para badge en header).

### `GET /api/escalations`

Lista con filtros.

**Query**: `status` (pending|assigned|in_progress|resolved), `urgency`
(low|medium|high|critical), `limit` (max 500).

Order: pending primero → critical primero → reciente primero.

### `PATCH /api/escalations/:id`

Actualiza status / asignacion / resolucion.

**Request**:
```json
{
  "status": "resolved",
  "assigned_to_user_id": 5,
  "resolution_notes": "..."
}
```

Validaciones: status en whitelist, `assigned_to_user_id` debe ser usuario con
rol `admin|compliance|manager`. Auto-promueve `pending → assigned` si asignas.
Genera audit `escalation_update`.

---

## Notifications (expiraciones de drivers)

Todos requieren **admin | compliance | manager**.

### `GET /api/notifications/badge-count`

Conteo de active.

### `GET /api/notifications`

Lista con filtros.

**Query**: `status` (active|dismissed|resolved), `urgency`, `kind`
(cdl_expiring|medical_expiring|cdl_expired|medical_expired), `limit` (max 1000).

**Validacion**: cada filtro contra whitelist; valor invalido → 400.

### `POST /api/notifications/:id/dismiss`

Marca notification como atendida.

**Request**: `{ "note": "..." }` (opcional).

**Errores**: 400 si ya fue dismissed.

### `POST /api/notifications/run-job`  *admin only*

Force-run del job de expiration scan. Util para testing.

---

## Audit chain

Todos requieren **admin | compliance**.

### `GET /api/audit/head`

Ultimo `row_hash` de la cadena (util para anclaje externo).

**Response 200**:
```json
{ "audit_id": 19, "row_hash": "abc123...", "created_at": "..." }
```

### `GET /api/audit/verify`

Verifica un rango de la cadena, recalculando hashes y reportando rupturas.

**Query**:
- `from`, `to` (int) — rango especifico.
- `full=1` — toda la cadena (solo admin, sin cap).
- Sin params: ultimas `MAX_ROWS_PER_REQUEST = 1000` filas.

**Response**:
- **200** `{ "intact": true, "rows_checked": N, "head_hash": "...", "issues": [] }`
- **409** `{ "intact": false, "issues": [{ "audit_id": ..., "type": "broken_link" | "hash_mismatch", ... }] }`
- **400** si rango excede 1000 (sin `full=1`).
- **403** si `full=1` y rol no es admin.

---

## Analytics

Todos requieren **admin | compliance | manager**.

### `GET /api/analytics/overview?period=7d`

KPIs agregados: total queries, unique users, avg latency, total cost USD.

### `GET /api/analytics/usage-over-time?period=7d`

Series de uso (queries/dia).

### `GET /api/analytics/by-role?period=7d`

Distribucion de queries por rol.

### `GET /api/analytics/top-users?period=7d`

Top usuarios por cantidad de queries.

### `GET /api/analytics/top-tools?period=7d`

Pareto de tool calls.

### `GET /api/analytics/decisions?period=7d`

Distribucion de decisions (proceed/conditional/decline/override/informational).

### `GET /api/analytics/hour-heatmap?period=7d`

Heatmap dow×hour de actividad.

### `GET /api/analytics/topics?period=7d`

Top words + repeated prompts (para detectar preguntas recurrentes).

### `GET /api/analytics/cost?period=7d`

Costo USD estimado del periodo + proyeccion mensual.

### `GET /api/analytics/refused?period=7d`

Lista de solicitudes rechazadas (audit `decision=decline`). Util para
detectar patrones de evasion intentada.

---

## Health

### `GET /api/health`

Anonimo. Always 200 (o 503 durante shutdown).

**Response 200**:
```json
{
  "ok": true,
  "env": "development",
  "mock_llm": true,
  "mock_samsara": true,
  "sync_enabled": true,
  "ts": "2026-04-30T18:30:00.000Z"
}
```

**Response 503** (durante shutdown):
```json
{ "ok": false, "shutting_down": true, "ts": "..." }
```

---

## Errores comunes

Todos los endpoints devuelven JSON con shape:
```json
{ "error": "Mensaje legible para el usuario" }
```

Los errores tecnicos no leakean stack traces al cliente. Para debugging
revisar logs estructurados (pino-http) — cada request lleva un `req.id` que
podes correlacionar.

Para 5xx: el cliente ve mensajes genericos accionables. Detalle tecnico
queda en logs server-side.

---

## Headers y CSRF

- **CSRF defense**: `SameSite=Strict` en el cookie `botdot_token`.
- **CSP**: `script-src` SIN `'unsafe-inline'` (XSS contention).
- **HSTS**: 1 ano + includeSubDomains.
- **Frame-ancestors**: `'self'` (clickjacking).
- **Content-Type**: nosniff.
- **Referrer-Policy**: no-referrer.

## Rate limits resumen

| Endpoint | Limite |
|---|---|
| `POST /api/auth/login` | 30/15min por IP |
| `POST /api/auth/change-password` | 10/15min por usuario |
| `POST /api/chat/send` | 30/min por usuario |
| `POST /api/chat/send` (concurrent) | 1 inflight por usuario |
| `POST /api/chat/send` (budget) | $5/user/day, $25/org/day |

429 con mensaje accionable cuando se cruza cualquiera.
