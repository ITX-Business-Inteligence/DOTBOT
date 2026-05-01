# Port BOTDOT Node → .NET — Handoff a desarrollo

Documento para el dev .NET que recibe el proyecto. Asume que entiendes
ASP.NET Core, Dapper, MySQL, JWT y arquitectura web moderna. Si tenes dudas
del **dominio** (DOT/FMCSA, HOS rules, BASICs, audit compliance), preguntar
al product owner antes de inventar.

## Resumen ejecutivo

- **Stack original Node v0.1.0** ya estaba en produccion-ready (307/307 QA, 0
  bugs criticos, audit chain tamper-evident, PWA). Funciona y se mantiene como
  referencia.
- **Stack .NET v0.2.0** es port FUNCIONALMENTE EQUIVALENTE. 8 fases entregadas
  con commits separados (`40bc73c` → `eafc261`).
- Ambos comparten **misma DB MySQL**, **mismas migrations**, **misma audit chain**.
  Pueden correr en paralelo durante migracion.
- **Frontend NO se reescribio a Razor/Blazor** — copia 1:1 de los HTML+JS del
  Node a `wwwroot/`. Decision para entregar rapido y sin riesgo de regresion.

## Arquitectura comparada

| Componente | Node | .NET |
|---|---|---|
| Runtime | Node 20+ | .NET 8 LTS |
| Web framework | Express 4 | ASP.NET Core 8 minimal API |
| Logging | pino + pino-http | Serilog |
| DB driver | mysql2/promise | Dapper + MySqlConnector |
| Auth | jsonwebtoken | System.IdentityModel.Tokens.Jwt |
| Passwords | bcrypt | BCrypt.Net-Next |
| Email | nodemailer | MailKit |
| Anthropic SDK | @anthropic-ai/sdk oficial | HttpClient raw (NO SDK community) |
| Excel parsing | exceljs (post-CVE migration) | ClosedXML |
| Frontend | HTML+JS vanilla en `public/` | HTML+JS vanilla en `wwwroot/` (copia identica) |
| Process manager | pm2 | systemd |
| Puerto local | 3000 | 5050 |

## Lo que se mantiene byte-exacto

### 1. Schema MySQL

Las 9 migrations en `migrations/*.sql` se aplican una sola vez. El .NET las
lee desde la misma DB que el Node. **No hay migration runner en el .NET** —
seguir usando `node src/db/migrate.js` o aplicar el SQL a mano.

Tablas compartidas: `users`, `conversations`, `messages`, `message_attachments`,
`audit_log`, `drivers`, `vehicles`, `driver_hos_cache`, `driver_import_discrepancies`,
`escalations`, `notifications`, `cfr_versions`, `cfr_fetch_runs`, `sync_runs`,
`sms_*`.

### 2. Audit chain SHA-256

**El requisito mas critico del port.** El `Canonicalize.Serialize()` de C# en
`Audit/Canonicalize.cs` produce bytes IDENTICOS al `canonicalize()` del Node
(`src/db/audit-chain.js`). Eso significa:

- Una fila escrita por el Node verifica `intact:true` desde el .NET
- Una fila escrita por el .NET verifica INTACTA desde el Node
- El head_hash es identico en ambos stacks

Verificacion cross-stack ya hecha durante el port (Fase 3, 4, 5, 7) — siempre
con `head_hash` matcheando. Si tocas `Canonicalize.cs`, **SIEMPRE** correr:

```bash
# Desde el .NET
curl -b cookies.txt http://localhost:5050/api/audit/verify
# Desde el Node (referencia)
node scripts/verify-audit-chain.js
# Ambos deben reportar head_hash identico
```

Si el byte-exact se rompe (por ejemplo cambiando el orden de keys, el formato
de numeros, o el escape de strings), pierdes la verificabilidad de filas
historicas. Es bug critico.

### 3. JWT cookie format

`Auth/JwtService.cs` emite tokens con claims `sub/email/role/name/iat/exp` igual
al Node. El cookie `botdot_token` (httpOnly, sameSite=Strict, secure en prod)
funciona en ambos stacks **si comparten el secreto** (no recomendado — usar
secretos distintos por stack).

### 4. System prompt

`dotnet/BotDot.Web/Agent/Resources/system-prompt.txt` es **copia exacta** del
texto exportado por `src/agent/system-prompt.js` del Node. Las 11 reglas duras
estan ahi. **Cualquier cambio al prompt requiere editar el JS canonico y
regenerar el .txt:**

```bash
node -e "const{SYSTEM_PROMPT_BASE}=require('./src/agent/system-prompt'); \
         require('fs').writeFileSync('dotnet/BotDot.Web/Agent/Resources/system-prompt.txt', SYSTEM_PROMPT_BASE)"
```

Cambios al prompt requieren **review de compliance officer + tests** (mismo
proceso que en el Node).

### 5. CFR knowledge base

`data/cfrs/cfr-index.json` (746 secciones) es leido por el `CfrIndex` del .NET.
Cuando el `CfrUpdateService` corre y detecta cambios, regenera el JSON desde
`cfr_versions`. Mismo formato que el Node — los tools `search_cfr` /
`get_cfr_section` consumen el archivo identicamente.

### 6. Frontend

`wwwroot/*.html`, `wwwroot/css/`, `wwwroot/js/`, `wwwroot/img/`, `wwwroot/manifest.json`,
`wwwroot/sw.js` son copia EXACTA de `public/` del Node. Si ediltas el Node,
copia los archivos:

```bash
cp -r public/{*.html,css,js,img,manifest.json,sw.js,favicon.ico} dotnet/BotDot.Web/wwwroot/
```

(O mejor: ediltar **directamente** en `wwwroot/` y olvidar el Node).

## Lo que cambia por stack

### Process management

**Node:** pm2 con `ecosystem.config.js`, `pm2 restart botdot`, `pm2 logs`.

**.NET:** systemd con `botdot-net.service`, `systemctl restart botdot-net`,
`journalctl -u botdot-net -f`.

### Configuracion

**Node:** `.env` con variables `DB_*`, `JWT_SECRET`, etc.

**.NET:** `appsettings.json` (base) + `appsettings.Production.json` (override
prod, gitignored). POCOs tipados en `Configuration/BotDotOptions.cs`.

### Migrations

**Node:** `node src/db/migrate.js` con runner custom + checksums.

**.NET:** No tiene runner. Aplicar via Node o SQL manual. **Decision aceptada
para no duplicar — el equipo .NET puede portar el runner si quiere, los
checksums son SHA-256 simples.**

### Tests

**Node:** 185 tests con `node:test`, ejecuta en ~5s.

**.NET:** El owner del proyecto decidio NO portar la suite. El equipo .NET
debe armar su propia (xUnit recomendado). Ver `docs/QA_REPORT.md` como spec
de comportamiento esperado. Smoke tests verificados durante el port:

| Fase | Smoke |
|---|---|
| 2 (auth) | 15/15 |
| 3 (audit chain) | cross-stack intact con head_hash identico |
| 4 (chat E2E) | 6/6 (off-topic, dot, injection) |
| 5 (routes) | 36/36 (RBAC matrix) |
| 6 (frontend) | 43/43 (static files + login render) |
| 7 (jobs) | 8/8 (sync + alerts + audit post-jobs) |

## Como correr ambos stacks en paralelo

Para validacion durante migracion gradual:

```bash
# Terminal 1: Node en :3000
cd /path/to/DOTBOT
npm start

# Terminal 2: .NET en :5050
cd /path/to/DOTBOT/dotnet
dotnet run --project BotDot.Web

# Login en cualquiera, hacer chat, verificar audit chain en ambos:
curl -b cookies.txt http://localhost:3000/api/audit/verify  # Node
curl -b cookies.txt http://localhost:5050/api/audit/verify  # .NET
# head_hash debe ser identico
```

En produccion, nginx puede rutear por path (strangler pattern):

```nginx
location /api/legacy/ {
  proxy_pass http://127.0.0.1:3000;   # endpoints especificos al Node
}
location / {
  proxy_pass http://127.0.0.1:5050;   # default al .NET
}
```

Asi pones piloto el .NET con un grupo de usuarios sin cortar al resto.

## Mapa de archivos clave Node → .NET

| Funcion | Node | .NET |
|---|---|---|
| Entry | `server.js` | `dotnet/BotDot.Web/Program.cs` |
| Config | `src/config/index.js` + `.env` | `Configuration/BotDotOptions.cs` + `appsettings.json` |
| DB pool | `src/db/pool.js` | `Data/DbAccess.cs` |
| Migrations | `src/db/migrate.js` | (no portado, usar Node) |
| Audit chain | `src/db/audit-chain.js` | `Audit/Canonicalize.cs` + `AuditService.cs` + `AuditVerifier.cs` |
| Auth middleware | `src/middleware/auth.js` | `Auth/AuthMiddleware.cs` |
| Login route | `src/routes/auth.js` | `Auth/AuthEndpoints.cs` |
| Chat tool loop | `src/agent/claude.js` | `Agent/ChatService.cs` |
| Mock LLM | `src/agent/mock-llm.js` | `Agent/MockClaudeClient.cs` |
| System prompt | `src/agent/system-prompt.js` | `Agent/SystemPrompt.cs` + `Resources/system-prompt.txt` |
| Tools registry | `src/agent/tools/index.js` | `Agent/Tools/ToolRegistry.cs` |
| 15 tools | `src/agent/tools/*.js` | `Agent/Tools/{Audit,Samsara,Cfr,Sms}Tools.cs` + `EscalateTool.cs` |
| Samsara client | `src/integrations/samsara-client.js` + `samsara-mock.js` | `Agent/SamsaraClient.cs` |
| Email | `src/utils/email.js` | `Email/IEmailService.cs` |
| Budget caps | `src/utils/budget.js` | `Agent/BudgetService.cs` |
| Inflight gate | `src/utils/inflight.js` | `Agent/InflightGate.cs` |
| Excel import | `src/utils/import-drivers.js` | `Routes/DriverImporter.cs` |
| Sync background | `src/sync/scheduler.js` + `src/sync/{drivers,vehicles,hos}.js` | `Jobs/SamsaraSyncService.cs` + `SamsaraSyncRunner.cs` |
| Expiration alerts | `src/jobs/expiration-alerts.js` | `Jobs/ExpirationAlertsService.cs` |
| CFR fetcher | `src/utils/cfr-fetcher.js` | `Jobs/CfrFetcher.cs` |
| CFR update job | `src/jobs/cfr-update.js` | `Jobs/CfrUpdateService.cs` |
| Routes admin | `src/routes/admin.js` | `Routes/Admin{Users,Drivers,SyncCfr}Endpoints.cs` |
| Routes dashboard | `src/routes/dashboard.js` | `Routes/DashboardEndpoints.cs` |
| Routes escalations | `src/routes/escalations.js` | `Routes/EscalationsEndpoints.cs` |
| Routes notifications | `src/routes/notifications.js` | `Routes/NotificationsEndpoints.cs` |
| Routes analytics | `src/routes/analytics.js` | `Routes/AnalyticsEndpoints.cs` |
| Routes audit verify | `src/routes/audit.js` | `Audit/AuditEndpoints.cs` |
| Routes chat | `src/routes/chat.js` | `Agent/ChatEndpoints.cs` |
| Frontend | `public/*` | `BotDot.Web/wwwroot/*` (copia 1:1) |

## Bugs encontrados y resueltos durante el port

Lista para que el equipo .NET sepa los gotchas:

1. **`MapInboundClaims = true` (default)** re-mapea `sub` → `ClaimTypes.NameIdentifier`
   en JWT validation. Eso rompia paridad con el JWT del Node. **Fix:** seteado a
   `false` en `JwtService` constructor. Si rompes esto, el `/api/auth/me` siempre
   devuelve 401.

2. **`JsonNamingPolicy.CamelCase`** rompia el contrato API del Node (que usa
   snake_case en `must_change_password`, `current_password`, `full_name`). **Fix:**
   cambiado a `SnakeCaseLower` global en `Program.cs`.

3. **`Dapper` auto-open cierra la conexion entre `INSERT` y `SELECT LAST_INSERT_ID()`**,
   devolviendo 0. **Fix:** `DbAccess.ExecuteInsertAsync()` llama `OpenAsync()` explicito
   para mantener la conexion fisica. Si encuentras `LAST_INSERT_ID()` devolviendo 0,
   ese es el motivo.

4. **`StringComparer.Ordinal`** vs `StringComparer.OrdinalIgnoreCase` en sort de
   keys del canonicalize. JS `Array.sort()` default es UTF-16 code unit order
   (case-sensitive). **Fix:** usar `Ordinal` o el hash chain rompe.

5. **System.Text.Json escapa demasiado por default** (HTML, comillas tipograficas).
   **Fix:** `JavaScriptEncoder.UnsafeRelaxedJsonEscaping` en serializer options
   donde el output debe matchear `JSON.stringify` de Node (especialmente en
   `evidence_json` para hash chain).

6. **`\u00xx` LOWERCASE** vs `\u00XX` UPPERCASE en escape de control chars.
   V8 emite minusculas, `System.Text.Json` por default mayusculas. **Fix:** custom
   escaper en `Canonicalize.AppendString()` con `("x4")` format.

7. **Class member name = enclosing class name** rechazado por C# compiler.
   En `DriverImporter.ExcelRow` la prop `ExcelRow` colisionaba con la clase. **Fix:**
   renombrada a `RowNumber`.

8. **Schema mismatch en `vehicles`**: las columnas reales son `unit_number`,
   `annual_inspection_date`, `oos_status` (NO `unit`, `annual_inspection`, `oos`).
   **Fix:** verificado con `SHOW COLUMNS FROM vehicles` y SQL corregido.

## Decisiones tomadas en el port (no negociar sin justificacion)

| Decision | Razon |
|---|---|
| Dapper sobre EF Core | Audit chain byte-determinism. EF puede generar SQL distinto entre versiones y romper hashes. |
| Frontend copy en lugar de Razor/Blazor | Cero riesgo de regresion visual + entrega 30min vs 6-8 horas. Mejora cosmetica posible si el equipo quiere despues. |
| HttpClient raw para Anthropic | Community SDK lag detras del oficial Node. Para compliance preferimos control total del wire format. |
| Regex parsing del eCFR XML | Defensa en profundidad contra XXE + paridad byte-exacta con Node. |
| `MapInboundClaims=false` | Sino `sub` no se lee del JWT. |
| `SnakeCaseLower` JSON | Contrato API del Node + frontend asume snake_case. |
| `ClosedXML` sobre `EPPlus` | EPPlus license cambio a comercial; ClosedXML es MIT. |

## Lo que falta (post-MVP, no bloqueante)

- **Suite de tests xUnit** equivalente al Node (decision: equipo .NET la arma).
- **Migration runner .NET** propio para no depender del Node en prod (opcional).
- **Anclaje externo de audit chain** (cron diario `head_hash` a S3 con object lock).
  Mismo TODO que el Node — heredado.
- **Real Samsara HTTP client** (Fase 7 implemento mock + stub que tira
  `NotImplementedException`). Cuando se corra contra Samsara real, hay que
  implementar `SamsaraHttpClient.ListDriversAsync` etc. usando los endpoints
  que el Node ya documenta en su `samsara-client.js`.
- **Real Anthropic.SDK** si el comunity catch-up con el oficial Node — por
  ahora `HttpClient` raw funciona bien.

## Contactos

- **Product owner / domain expert (compliance):** Juan Trejo (juant@intelogix.mx)
- **Reglas duras del agente:** revisar SIEMPRE con compliance officer antes de
  modificar `Resources/system-prompt.txt`.
- **Cambios al system prompt o a `Canonicalize.cs`:** PR con review obligatorio.
  Si tocas el canonicalize, smoke test cross-stack es requisito de merge.

## Bienvenida

Cualquier duda del **dominio** (DOT/FMCSA, HOS rules, BASICs, audit), preguntar
al PO antes de asumir. Las decisiones del prompt y los tools fueron iteradas
con compliance officer durante semanas — no inventar atajos.

Para cualquier duda **tecnica** (Dapper queries, Serilog config, Anthropic API
shapes, .NET hosting), abrir issue en el repo o preguntarle al equipo del port.

El stack Node original sigue siendo el sistema de referencia funcional hasta
que el .NET pase QA equivalente y/o piloto en produccion. **No descartar el
Node hasta tener confianza en el .NET en prod real.**
