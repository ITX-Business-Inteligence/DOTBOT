# Arquitectura BOTDOT

## Diagrama logico

```
   Dispatcher / Supervisor / Compliance / Manager
       (PC o celular, navegador)
                   │
                   │ HTTPS
                   ▼
   ┌────────────────────────────────────────────┐
   │          BOTDOT Backend (Node)             │
   │                                            │
   │  Express ───┬─── /api/auth   (login JWT)   │
   │             ├─── /api/chat   (agente)      │
   │             └─── /api/dashboard            │
   │                                            │
   │  Agente Claude ──┬── tool use loop         │
   │                  └── system prompt + RAG   │
   │                                            │
   │  ┌──────────────┐                          │
   │  │  MySQL       │  conversations           │
   │  │              │  messages                │
   │  │              │  audit_log               │
   │  │              │  sms_*                   │
   │  │              │  drivers / vehicles      │
   │  │              │  assignment_decisions    │
   │  └──────────────┘                          │
   └────┬──────────────────┬──────────┬─────────┘
        │                  │          │
        ▼                  ▼          ▼
   Samsara API      Anthropic API   FMCSA SAFER
   (HOS live)       (Claude)        (publico)
```

## Componentes

### 1. Frontend (HTML/JS/CSS)

- **public/index.html** — Login. Mobile-first, max-width centered card.
- **public/app.html** — App principal. Layout: header + sidebar (dashboard) + main (chat).
- **Tailwind via CDN** — sin build step para MVP. Si va a produccion alta-escala, compilar local.
- **Responsive breakpoints**:
  - Mobile (<1024px): sidebar oculto, hamburguesa abre overlay
  - Desktop (>=1024px): sidebar fijo a la izquierda

### 2. Backend (Node + Express)

- **server.js** — entry. Helmet (CSP), cookie-parser, JSON body, rutas.
- **src/routes/** — auth, chat, dashboard. Todas con auth middleware excepto login y health.
- **src/middleware/auth.js** — JWT en cookie httpOnly. `requireRole(...)` para gating por rol.
- **src/db/pool.js** — mysql2/promise pool, helpers `query`, `queryOne`, `transaction`.

### 3. Agente Claude

#### Tool use loop (`src/agent/claude.js`)

```
1. Usuario manda mensaje → guardado como role=user en messages
2. Cargamos history de conversation
3. Llamada a Claude con: system prompt (cached) + tools + history + msg
4. Si stop_reason = "tool_use":
   a. Por cada tool_use, ejecutamos handler local
   b. Guardamos tool_use + tool_result en messages
   c. Mandamos resultados de vuelta a Claude
   d. Loop hasta que stop_reason = "end_turn" o limit
5. Devolvemos texto final al usuario
```

#### Tools disponibles

| Tool | Funcion | Fuente |
|---|---|---|
| `samsara_get_driver_hos` | HOS clock real-time | Samsara API |
| `samsara_search_driver` | Busca drivers por nombre parcial | DB local |
| `samsara_get_drivers_near_limit` | Drivers cerca de algun limite HOS | Samsara API |
| `samsara_get_vehicle_status` | Status de vehiculo | DB local + Samsara |
| `check_assignment_compliance` | Aplica reglas 395.x a una asignacion | Logica + Samsara |
| `search_cfr` | Busqueda en CFR index | JSON local |
| `get_cfr_section` | Texto completo de una seccion CFR | JSON local |
| `query_basics_status` | BASICs del snapshot mas reciente | DB local |
| `query_top_violations` | Pareto de violaciones | DB local |
| `query_driver_inspections` | Historial roadside de un driver | DB local |
| `query_dataqs_candidates` | Crashes no disputados | DB local |
| `log_decision` | Audit log de decision operacional | DB local |
| `log_refused_request` | Audit log cuando se rechaza solicitud | DB local |

#### System prompt

Definido en `src/agent/system-prompt.js`. Tiene:
- Identidad del agente
- 7 reglas duras no negociables
- Conocimiento regulatorio base (CFRs relevantes, memos FMCSA)
- Contexto especifico del carrier (4 BASICs en Alert)
- Format guideline para respuestas operacionales
- Tono: profesional, directo, espanol por default

#### Prompt caching

El system prompt se manda con `cache_control: { type: 'ephemeral' }`. Esto reduce costo en ~90% para mensajes subsecuentes en la misma sesion.

### 4. Base de datos (MySQL)

#### Tablas core

- **users** — autenticacion + roles
- **conversations** — chat sessions
- **messages** — turns individuales (user/assistant/tool_use/tool_result) con tokens
- **audit_log** — decisiones inmutables
- **drivers** — sync desde Samsara
- **vehicles** — sync desde Samsara
- **assignment_decisions** — historico de consultas dispatch

#### Tablas SMS

- **sms_snapshots** — percentiles por BASIC por fecha
- **sms_violations** — violaciones individuales (top viols)
- **sms_inspections** — inspecciones roadside
- **sms_crashes** — crashes con flag DataQs

### 5. Integracion Samsara

`src/integrations/samsara-client.js`. REST API. Token en `Authorization: Bearer`.

Endpoints usados:
- `GET /fleet/hos/clocks` — HOS real-time
- `GET /fleet/drivers` — roster
- `GET /fleet/vehicles` — flota
- `GET /fleet/hos/logs` — RODS detallados

Sync recomendado:
- **Real-time** (en tool calls): HOS clocks
- **Cron 4-hourly**: drivers, vehicles roster
- **Cron daily**: HOS logs detallados (para auditoria)

Pendiente Sprint 2: webhooks de Samsara para push de eventos HOS.

### 6. Seguridad

- **HTTPS obligatorio en prod** (Let's Encrypt)
- **JWT en cookie httpOnly + Secure + SameSite=Lax**
- **bcrypt cost 10** para passwords
- **rate limit en login** (10 intentos / 15 min)
- **Helmet CSP** — no inline scripts excepto Tailwind/CDN
- **No logging de secretos** (filtrar en logger)
- **Audit log inmutable** — sin UPDATE/DELETE permitidos
- **Datos sensibles**: CDL #s, medical info → almacenar en DB encriptada at rest (Sprint 2)

## Flujo end-to-end ejemplo

**Caso: Dispatcher pregunta por una asignacion**

1. Dispatcher en celular abre `app.html` (sesion ya activa)
2. Escribe: `"Puedo asignar load 8821 a Juan Perez? 13.5 hrs de manejo"`
3. POST `/api/chat/send` → backend
4. Backend carga history, llama Claude con tools
5. Claude responde con tool_use: `samsara_search_driver({query: "Juan Perez"})`
6. Backend ejecuta → DB returns Juan Perez samsara_id
7. Backend manda resultado a Claude
8. Claude pide: `check_assignment_compliance({driver, drive_min: 810, load: 8821})`
9. Backend: llama Samsara → arma HOS snapshot → aplica reglas 395.3 → returns DECLINE
10. Backend manda resultado a Claude
11. Claude pide: `samsara_get_drivers_near_limit({threshold: 0})` para alternativas
12. ...
13. Claude pide: `log_decision({action: "assignment_check", decision: "decline", cfr: "395.3(a)(3)", reasoning: "..."})`
14. Claude responde texto final con tabla de alternativas
15. Backend retorna JSON al frontend
16. Frontend renderiza burbuja de chat + nota "consultó: samsara_search_driver, check_assignment_compliance, ..."

Tiempo total: 3-8 segundos. Tokens: ~3-8k input cached + ~500-1500 output.

## Performance esperado

- 25 dispatchers + supervisores activos
- ~50-200 consultas/dia
- Latencia P50: 3-5s, P95: 10s
- Costo Claude API por consulta: $0.005-0.02 con caching

## Tradeoffs y decisiones

| Decision | Razon |
|---|---|
| Node sobre PHP | Mejor SDK de Anthropic, async natural para tool use |
| Tailwind CDN sobre build | Simplicidad MVP. Migrar a build cuando suba volumen |
| MySQL sobre Postgres | XAMPP ya lo trae. Postgres se vuelve mejor cuando agreguemos pgvector |
| JSON CFR index sobre vector DB | MVP. Migrar a pgvector cuando index supere 50 secciones |
| JWT en cookie sobre localStorage | XSS protection (httpOnly) |
| Sin WhatsApp en MVP | Simplifica dramaticamente, evita Meta verification y costo |
| Sin queue jobs | MVP single-process. Agregar BullMQ cuando agreguemos sync background |
