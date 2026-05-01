# BOTDOT — Port a .NET 8 / ASP.NET Core

Port completo del proyecto BOTDOT (originalmente Node.js) a stack Microsoft.
**Status: 8 de 8 fases entregadas.** Funcionalmente equivalente al Node original.

Para detalle de la migracion, ver [`../docs/PORT_HANDOFF.md`](../docs/PORT_HANDOFF.md).
Para deploy a produccion, ver [`../docs/DEPLOY_NET.md`](../docs/DEPLOY_NET.md).

## Stack

- **.NET 8 LTS** (soporte hasta noviembre 2026)
- **ASP.NET Core 8 minimal API** + static files (no Razor / Blazor — el frontend
  vive como HTML+JS vanilla en `wwwroot/`, copiado 1:1 del Node)
- **Dapper + MySqlConnector** (no Entity Framework — para audit chain
  byte-exacto necesitamos SQL deterministico)
- **Serilog** (logging estructurado)
- **BCrypt.Net-Next** (passwords)
- **System.IdentityModel.Tokens.Jwt** (JWT en cookie httpOnly)
- **HttpClient raw** (Anthropic API + eCFR — NO SDK community)
- **MailKit** (SMTP)
- **ClosedXML** (Excel import — sin CVE)

## Estructura del proyecto

```
dotnet/
├── BotDot.sln
├── BotDot.Web/
│   ├── Program.cs                    # Entry, pipeline, DI, endpoint maps
│   ├── BotDot.Web.csproj             # NuGets + EmbeddedResource system-prompt
│   ├── appsettings.json              # Config base (mocks ON, secrets placeholder)
│   ├── appsettings.Development.json  # Override local (gitignored)
│   │
│   ├── Configuration/
│   │   └── BotDotOptions.cs          # POCOs tipados
│   │
│   ├── Data/
│   │   └── DbAccess.cs               # Pool Dapper + Query/QueryOne/Transaction/ExecuteInsert
│   │
│   ├── Auth/
│   │   ├── AuthModels.cs             # AuthUser, UserRow, Roles
│   │   ├── JwtService.cs             # HS256 issue + validate (MapInboundClaims=false)
│   │   ├── AuthMiddleware.cs         # Cookie reader + RequireAuthFilter
│   │   └── AuthEndpoints.cs          # /login /logout /me /change-password + rate limits
│   │
│   ├── Audit/
│   │   ├── Canonicalize.cs           # JSON serializer byte-exact al Node canonicalize()
│   │   ├── IAuditService.cs          # Interface
│   │   ├── AuditService.cs           # Hash chain SHA-256 + GET_LOCK MySQL
│   │   ├── AuditVerifier.cs          # VerifyChain con paginacion M7
│   │   └── AuditEndpoints.cs         # /head /verify (admin/compliance)
│   │
│   ├── Agent/
│   │   ├── SystemPrompt.cs + Resources/system-prompt.txt   # 11 reglas duras (embedded)
│   │   ├── AnthropicDtos.cs          # Request/response shapes
│   │   ├── IAnthropicClient.cs
│   │   ├── AnthropicHttpClient.cs    # HttpClient raw, sin SDK community
│   │   ├── MockClaudeClient.cs       # Pattern-based para dev sin API key
│   │   ├── SamsaraClient.cs          # ISamsaraClient + Mock + HttpStub
│   │   ├── ChatService.cs            # Tool use loop principal
│   │   ├── ChatEndpoints.cs          # /chat/send (multipart) + /attachments + /conversations
│   │   ├── BudgetService.cs          # Caps USD 24h con pricing tabla
│   │   ├── InflightGate.cs           # Gate per-user concurrency
│   │   ├── AttachmentValidator.cs    # MIME/size/count limits
│   │   └── Tools/
│   │       ├── ITool.cs              # Interface + ToolDefBuilder
│   │       ├── ToolRegistry.cs       # 15 tools registry
│   │       ├── AuditTools.cs         # log_decision / log_refused_request / log_off_topic
│   │       ├── SamsaraTools.cs       # 4 tools + check_assignment_compliance (HOS rules)
│   │       ├── CfrTools.cs           # search_cfr / get_cfr_section (lee data/cfrs/cfr-index.json)
│   │       ├── SmsTools.cs           # 4 tools de SMS/BASICs/violations/dataqs
│   │       └── EscalateTool.cs       # escalate_to_compliance + email a compliance
│   │
│   ├── Email/
│   │   └── IEmailService.cs          # MockEmailService + MailKitEmailService
│   │
│   ├── Routes/
│   │   ├── DashboardEndpoints.cs     # /dashboard/{basics,kpis,audit,drivers-at-risk}
│   │   ├── AdminUsersEndpoints.cs    # CRUD + reset-pwd + unlock (admin only)
│   │   ├── AdminDriversEndpoints.cs  # CRUD + import + discrepancies (admin/compliance)
│   │   ├── DriverImporter.cs         # ClosedXML xlsx parsing + Levenshtein matching
│   │   ├── AdminSyncCfrEndpoints.cs  # /admin/sync/* + /admin/cfr/*
│   │   ├── EscalationsEndpoints.cs   # list + badge-count + patch
│   │   ├── NotificationsEndpoints.cs # list + dismiss + run-job
│   │   └── AnalyticsEndpoints.cs     # 10 endpoints (overview, top-users, cost, etc.)
│   │
│   ├── Jobs/
│   │   ├── SamsaraSyncRunner.cs      # Helper sync_runs (status/duration/error)
│   │   ├── SamsaraSyncService.cs     # 3 loops drivers/vehicles/hos_clocks
│   │   ├── ExpirationAlertsService.cs # Cron 6am, buckets, dedup, email
│   │   ├── CfrFetcher.cs             # eCFR.gov fetch con regex (sin XXE) + URL allowlist
│   │   └── CfrUpdateService.cs       # Cron 4am, baseline+update, audit+email
│   │
│   └── wwwroot/                      # Frontend copia 1:1 del public/ Node
│       ├── *.html  (9 paginas)
│       ├── css/styles.css
│       ├── js/*.js  (13 archivos)
│       ├── img/*  (7 imagenes)
│       ├── manifest.json + sw.js  (PWA)
│       └── favicon.ico
│
└── README.md (este archivo)
```

## Fases del port

| # | Fase | Commit | Notas |
|---|---|---|---|
| 0 | Scaffold (.sln + Web project + 8 NuGets) | `40bc73c` | |
| 1 | Foundation (config, Serilog, Dapper, health) | `40bc73c` | |
| 2 | Auth + RBAC + rate limit | `7b1bad3` | 15/15 smoke pasados |
| 3 | Audit chain byte-exact | `7cf1d84` | Cross-stack verified, 19 filas Node intact en .NET |
| 4 | Agente Claude + 15 tools + chat E2E | `3c8dba2` | Mock LLM dispara tools reales |
| 5 | 40+ routes API | `9611490` | RBAC matrix 36/36 |
| 6 | Frontend (copy 1:1 del Node) | `e0f6bdb` | 33 archivos a wwwroot/ |
| 7 | Jobs background (3 IHostedService) | `eafc261` | Sync + alerts + cfr-update |
| 8 | Docs handoff final | (este) | DEPLOY_NET + PORT_HANDOFF + PDFs |

## Setup local

### 1. Pre-requisitos

```bash
# .NET 8 SDK
dotnet --list-sdks   # debe listar 8.x.x

# MySQL (XAMPP local funciona)
mysql -u root -p -e "CREATE DATABASE botdot CHARACTER SET utf8mb4;"
mysql -u root -p -e "CREATE USER 'botdot'@'localhost' IDENTIFIED BY 'botdot_dev'; GRANT ALL ON botdot.* TO 'botdot'@'localhost'; FLUSH PRIVILEGES;"

# Migrations — el .NET NO tiene runner propio; usar el del Node:
cd ..
node src/db/migrate.js
# Esto aplica las 9 migrations contra la DB.
```

### 2. Config local

```bash
cd dotnet/BotDot.Web
cp appsettings.json appsettings.Development.json
# Editar appsettings.Development.json:
#   - BotDot:Db:Password = "botdot_dev"
#   - BotDot:Auth:JwtSecret = generar con openssl rand -hex 64
#   - BotDot:Auth:CookieSecret = generar otro distinto
#   - Mocks pueden quedar en true para dev sin API keys reales
```

### 3. Run

```bash
dotnet run --project BotDot.Web
# Server arranca en http://localhost:5050
# Login con juant@citlogistics.us (Intelogix1) o admin@intelogix.mx (changeme123)
```

### 4. Build prod

```bash
dotnet publish -c Release -o ./publish
# Genera ./publish/BotDot.Web.dll + dependencies, listo para deploy.
# Ver docs/DEPLOY_NET.md para systemd / nginx / Let's Encrypt.
```

## Coexistencia con el Node original

Ambos stacks usan **la misma DB MySQL** y **las mismas migrations**. Eso permite:

1. **Correr el Node y el .NET en paralelo** sin pisar datos. El Node en `:3000`,
   el .NET en `:5050`. Schema compartido = misma audit chain, mismos users, mismas
   conversations.

2. **Validar paridad funcional** comparando outputs. Por ejemplo, el smoke test
   de Fase 3 inserta una fila desde .NET y verifica con el Node — ambos reportan
   `intact:true` con head_hash idéntico.

3. **Migracion gradual production** via nginx routing por path (strangler pattern).
   Detalle en `docs/PORT_HANDOFF.md`.

## Smoke commands

```bash
# Health
curl http://localhost:5050/api/health

# Login + cookie
curl -c cookies.txt -X POST -H "Content-Type: application/json" \
  -d '{"email":"juant@citlogistics.us","password":"Intelogix1"}' \
  http://localhost:5050/api/auth/login

# Audit chain verify (debe ser intact:true cross-stack contra el Node)
curl -b cookies.txt http://localhost:5050/api/audit/verify

# Sync ad-hoc
curl -b cookies.txt -X POST http://localhost:5050/api/admin/sync/run/drivers

# Expiration alerts ad-hoc
curl -b cookies.txt -X POST http://localhost:5050/api/notifications/run-job

# Chat E2E con mock LLM
curl -b cookies.txt -F "message=que dice 49 CFR 395.3" \
  http://localhost:5050/api/chat/send
```

## Decisiones arquitecturales

| Decision | Razon |
|---|---|
| Dapper sobre EF Core | Audit chain requiere SQL byte-deterministico. EF puede cambiar SQL entre versiones y romper hashes. |
| Static HTML+JS sobre Blazor Server | Frontend copia 1:1 del Node = cero curva de aprendizaje + cero riesgo de regresion visual. Si el equipo despues quiere reescribir a Razor componentes, lo hacen como mejora cosmetica. |
| HttpClient raw sobre Anthropic.SDK community | Community lag detras del SDK Node oficial. Para compliance preferimos control total. |
| `MapInboundClaims = false` en JwtSecurityTokenHandler | Microsoft default re-mapea `sub` → `ClaimTypes.NameIdentifier`. Eso rompe paridad con el JWT del Node. |
| `JsonNamingPolicy.SnakeCaseLower` global | El contrato API del Node usa `must_change_password`, `current_password`, `full_name`. Frontend espera ese formato. |
| Regex parsing del eCFR XML (no XmlReader) | Defense en profundidad contra XXE + paridad byte-exacta con el Node fetcher. |
| Migrations compartidas con Node (`../migrations/`) | Mismo schema, ambos stacks leen/escriben las mismas tablas. |

## Mantenimiento

- **Modificar el system prompt**: editar `src/agent/system-prompt.js` del Node (canonico),
  luego regenerar `dotnet/BotDot.Web/Agent/Resources/system-prompt.txt` con:
  ```bash
  node -e "const{SYSTEM_PROMPT_BASE}=require('./src/agent/system-prompt'); \
           require('fs').writeFileSync('dotnet/BotDot.Web/Agent/Resources/system-prompt.txt', SYSTEM_PROMPT_BASE)"
  ```
- **Agregar una tool**: archivo nuevo en `Agent/Tools/`, registrar en `ToolRegistry.cs`,
  implementar interface `ITool`. Ver `AuditTools.cs` como ejemplo simple.
- **Modificar el system prompt** debe disparar review de compliance officer + tests
  (mismas reglas que el Node).

## Tests

El equipo .NET debe armar su propia suite — los 185 tests unitarios del Node NO
estan portados (decision explicita del owner para no duplicar QA del nuevo stack).
Ver `docs/QA_REPORT.md` (del Node) como spec de comportamiento esperado.

Smoke tests verificados durante el port:
- Fase 2 (auth): 15/15
- Fase 3 (audit): cross-stack intact con head_hash identico
- Fase 4 (chat): 6/6 (off-topic, dot, injection)
- Fase 5 (routes): 36/36 (RBAC matrix completo)
- Fase 6 (frontend): 43/43 (static files + login render)
- Fase 7 (jobs): 8/8 (sync + alerts + audit chain post-jobs)
