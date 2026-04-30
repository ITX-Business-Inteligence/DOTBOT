# BOTDOT — Port a .NET 8 / ASP.NET Core / Blazor

Reescritura del proyecto BOTDOT (originalmente Node.js) a stack Microsoft.

## Stack

- **.NET 8 LTS** (soporte hasta noviembre 2026)
- **ASP.NET Core 8** — minimal API + controllers
- **Blazor Server** (UI) — pendiente Fase 6
- **Dapper + MySqlConnector** (no Entity Framework — para audit chain compliance necesitamos SQL exacto, no auto-generado)
- **Serilog** (logging estructurado)
- **BCrypt.Net-Next** (passwords)
- **System.IdentityModel.Tokens.Jwt** (JWT en cookie httpOnly)
- **HttpClient raw** (Anthropic + Samsara + eCFR — no SDK community)
- **MailKit** (SMTP)

## Estructura del proyecto

```
dotnet/
├── BotDot.sln
├── BotDot.Web/
│   ├── Program.cs                    # Entry, middleware pipeline, health
│   ├── appsettings.json              # Config (en dev: appsettings.Development.json — NO commitear)
│   ├── BotDot.Web.csproj             # Refs NuGet
│   ├── Configuration/
│   │   └── BotDotOptions.cs          # POCOs tipados de config
│   ├── Data/
│   │   └── DbAccess.cs               # Pool Dapper + helpers Query/QueryOne/Transaction
│   ├── wwwroot/                      # Static files (HTML, CSS, JS, manifest, sw.js)
│   │   └── index.html                # Placeholder hasta Fase 6
│   ├── Auth/                         # PENDIENTE Fase 2
│   ├── Audit/                        # PENDIENTE Fase 3
│   ├── Agent/                        # PENDIENTE Fase 4
│   ├── Controllers/                  # PENDIENTE Fase 5
│   ├── Components/                   # PENDIENTE Fase 6 (Blazor)
│   └── Jobs/                         # PENDIENTE Fase 7
└── README.md (este archivo)
```

## Fases del port

| # | Fase | Status |
|---|---|---|
| 0 | Scaffold (.sln + Web project + NuGets) | ✅ Listo |
| 1 | Foundation (config tipada, Serilog, Dapper pool, health) | ✅ Listo |
| 2 | Auth + RBAC (bcrypt, JWT cookie httpOnly, lockout, change-password) | 🚧 Pendiente |
| 3 | Audit chain (canonicalize byte-exact + appendAudit + verifyChain) | 🚧 Pendiente |
| 4 | Agente Claude (HttpClient + tool use loop + 15 tools + mock) | 🚧 Pendiente |
| 5 | Controllers (chat, dashboard, admin, escalations, notifications, audit, analytics) | 🚧 Pendiente |
| 6 | Frontend Blazor (dark mode + PWA + 9 paginas) | 🚧 Pendiente |
| 7 | Jobs background (sync samsara, expiration alerts, cfr update) | 🚧 Pendiente |
| 8 | Docs handoff + DEPLOY.NET | 🚧 Pendiente |

## Setup local

### 1. Pre-requisitos

```bash
# .NET 8 SDK
dotnet --list-sdks   # debe listar 8.x.x

# MySQL (XAMPP local funciona)
# crear DB:
mysql -u root -p -e "CREATE DATABASE botdot CHARACTER SET utf8mb4;"
```

### 2. Config local

Copiar `appsettings.json` a `appsettings.Development.json` y completar los secretos:

```bash
cd BotDot.Web
cp appsettings.json appsettings.Development.json
# editar appsettings.Development.json con DB password, JWT secrets, API keys
```

### 3. Migrations de DB

**IMPORTANTE**: las migrations 001-009 ya estan en `../migrations/` (compartidas
con el proyecto Node). El port .NET las aplica con su propio runner — pendiente
Fase 1.5. Por ahora, podes correr el `node ../src/db/migrate.js` del proyecto
Node para preparar la DB.

### 4. Run

```bash
dotnet run --project BotDot.Web
# Server arranca en http://localhost:5050
# health: curl http://localhost:5050/api/health
```

### 5. Build

```bash
dotnet build       # debug
dotnet publish -c Release -o ./publish    # prod-ready binaries
```

## Decisiones arquitecturales (vs el Node original)

| Decision | Razon |
|---|---|
| Dapper sobre EF Core | Audit chain requiere SQL byte-deterministico. EF puede cambiar entre versiones y romper hashes. |
| Blazor Server sobre WASM | App de compliance, todo el state en server. Auth simpler. Menos surface area expuesta. |
| HttpClient raw sobre Anthropic.SDK community | El SDK community lag detras del oficial Node. Para compliance necesitamos control total del wire format. |
| `System.IdentityModel.Tokens.Jwt` sin `Microsoft.AspNetCore.Authentication.JwtBearer` | El JwtBearer para .NET 8 esta en v8.x, ya no se actualiza. Issuing+validating manual con SHS256 nos da el mismo resultado que el JWT del Node. |
| Configuracion via `appsettings.*.json` + IOptions<T> | Tipado estatico. El Node usaba `dotenv` + objeto runtime. |
| Migrations compartidas con Node (`../migrations/`) | Mismo schema, ambos stacks leen/escriben las mismas tablas. Permite migracion gradual si fuera necesario. |

## Compatibilidad con el proyecto Node

Ambos stacks usan **la misma DB MySQL** y **las mismas migrations**. Eso permite:

1. Correr el Node mientras se desarrolla el .NET (sin pisar datos).
2. Validar paridad funcional comparando outputs entre ambos servers contra la misma DB.
3. Migracion gradual production via nginx routing por path (strangler pattern).

## Mantenimiento del Node original

El Node original sigue siendo el sistema de referencia hasta que el port .NET
pase QA equivalente (307+ checks). Ver [`../README.md`](../README.md) y
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) para el sistema de origen.
