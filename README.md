# BOTDOT

Asistente de IA para compliance DOT/FMCSA, uso interno de Intelogix (USDOT 2195271). Vive 100% en HTML responsive (PC + celular). Audiencias: dispatchers, supervisores, compliance officers y managers.

## Que hace

- Pre-decision advisory de asignaciones (HOS contra 49 CFR 395.3)
- Consulta tiempo real de Samsara (HOS, drivers, vehicles)
- Analisis de SMS (BASICs, violaciones, crashes)
- Busqueda en CFRs con citacion obligatoria
- Audit log inmutable de cada decision
- Rechazo activo de solicitudes que violen DOT (con log)
- **Analytics meta** del propio bot (uso, usuarios, tools, costos, refused requests) — solo admin/manager/compliance

**No hace:** comunicacion directa con drivers (queda fuera del flujo del bot), decisiones autonomas (siempre recomienda, humano decide), asesoria legal.

## Stack

- **Backend:** Node.js 20 + Express, MySQL 8 / MariaDB 10.5+
- **Agente:** Claude Sonnet 4.6 con tool use loop, prompt caching
- **Frontend:** HTML + Tailwind CSS (CDN) + vanilla JS, mobile-first responsive
- **Integraciones:** Samsara API (REST), FMCSA SAFER (publico)
- **Auth:** JWT en cookie httpOnly + bcrypt
- **Vector DB CFR:** JSON local en MVP, migrar a pgvector/Pinecone para escalar

## Estructura

```
BOTDOT/
├── server.js                  # Entry Express
├── package.json
├── .env.example               # Template de variables
├── migrations/                # SQL migrations versionadas (001_, 002_, ...)
├── src/
│   ├── config/                # Carga de .env
│   ├── db/                    # pool.js, migrate.js, init.js, audit-chain.js
│   ├── middleware/            # auth.js (JWT)
│   ├── routes/                # auth, chat, dashboard, analytics, audit
│   ├── agent/
│   │   ├── claude.js          # Tool use loop
│   │   ├── system-prompt.js   # System prompt + reglas duras
│   │   └── tools/             # samsara, cfr, sms, audit
│   ├── integrations/          # samsara-client.js
│   └── utils/
│       ├── budget.js          # Cap diario de Claude (user / org)
│       ├── inflight.js        # Concurrency gate por usuario
│       ├── pricing.js         # Pricing y queries de costo
│       └── ingest-sms.js      # Carga CSVs del SMS export a DB
├── public/                    # Frontend
│   ├── index.html             # Login
│   ├── app.html               # Main app
│   ├── css/styles.css
│   └── js/                    # auth, app, chat, dashboard
├── data/
│   ├── *.csv                  # SMS export procesado
│   └── cfrs/cfr-index.json    # Knowledge base CFR
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEPLOY.md
│   └── HANDOFF.md
├── reports/                   # Reportes ejecutivos generados
└── scripts/                   # Scripts: build_report, verify-audit-chain, ...
```

## Setup local (XAMPP)

```bash
# 1. Instalar Node 20+
# 2. Instalar dependencias
npm install

# 3. Copiar y completar .env
cp .env.example .env
# Editar .env con tus secretos reales

# 4. Inicializar (init.js crea la DB si no existe, corre migrations
#    pendientes y asegura el usuario admin). Idempotente.
node src/db/init.js

# Comandos relacionados:
#   npm run migrate          # solo aplicar migrations pendientes
#   npm run migrate:status   # ver aplicadas vs pendientes
#   npm run verify-audit     # chequear integridad del audit_log

# 5. (Opcional) Cargar datos del SMS si ya tienes CSVs en /data
npm run ingest-sms

# 6. Levantar servidor
npm run dev
```

Abrir: http://localhost:3000 (login con `admin@intelogix.mx` / `changeme123`).

## Tests

Suite de tests puros con `node:test` (sin dependencias adicionales). No
tocan DB ni la API de Anthropic — solo logica.

```bash
npm test
```

Cobertura actual:
- **HOS rules** ([test/hos-rules.test.js](test/hos-rules.test.js)) — `evaluateHosCompliance` contra 49 CFR 395.3: PROCEED / CONDITIONAL / DECLINE en escenarios de drive/duty/cycle, fronteras de gap, multiples violaciones simultaneas.
- **System prompt** ([test/system-prompt.test.js](test/system-prompt.test.js)) — verifica que las 9 reglas duras estan presentes, que la frase exacta de redirect off-topic existe, que se listan los Parts criticos del 49 CFR. Si alguien edita el prompt y borra una regla, CI lo detecta.
- **Audit chain** ([test/audit-chain.test.js](test/audit-chain.test.js)) — `canonicalize` determinista, `computeRowHash` reproducible, sensibilidad a cambios en cualquier campo (cualquier mutacion historica rompe el hash).
- **Pricing** ([test/pricing.test.js](test/pricing.test.js)) — calculos de costo en ambos formatos (API Anthropic y DB), todos los modelos, edge cases.
- **Tools registry** ([test/tools-registry.test.js](test/tools-registry.test.js)) — todos los tools tienen schema valido, names unicos, y los que el system prompt nombra (`log_off_topic`, `log_decision`, etc) existen.

Tests con DB real (insert + verify chain + tamper detection) y tests behavioral contra Claude API quedan como suite de integracion separada — pendiente.

## Como agregar usuarios

Por ahora via SQL (Sprint 2 traera UI de admin):

```sql
-- Generar hash en Node:
-- node -e "console.log(require('bcrypt').hashSync('passInicial', 10))"
INSERT INTO users (email, full_name, password_hash, role)
VALUES ('juan.dispatcher@intelogix.mx', 'Juan Dispatcher', '$2b$10$...', 'dispatcher');
```

Roles validos: `dispatcher`, `supervisor`, `compliance`, `manager`, `admin`.

## Como agregar herramientas al agente

Cada tool es un objeto con `definition` (schema JSON Anthropic) y `handler` (async function).

1. Crear `src/agent/tools/mi-tool.js`:
```js
const miTool = {
  definition: {
    name: 'mi_tool',
    description: 'Que hace y cuando usarla',
    input_schema: { type: 'object', properties: {...}, required: [...] }
  },
  handler: async (input, context) => {
    // input es lo que el agente pasa
    // context = { user, conversationId }
    return { ... };
  }
};
module.exports = { miTool };
```

2. Registrar en `src/agent/tools/index.js` (en `TOOLS` y `TOOL_DEFINITIONS`).

3. Test: hacer una pregunta al agente que invoque la tool.

## Reglas duras del agente

Definidas en `src/agent/system-prompt.js`. **NO modificar sin review de compliance.** Las reglas:

1. Cita CFR siempre que afirme algo regulatorio
2. Rechaza ayudar a evadir/falsificar registros (y registra el intento)
3. NO toma decisiones, solo recomienda
4. NO habla con drivers directamente
5. Disclaimer legal en cada respuesta operacional
6. Marca nivel de confianza (real-time vs snapshot vs interpretacion)
7. Audit log obligatorio para decisiones operacionales

## Operacion

- **Logs del backend:** stdout/stderr (capturar con PM2 o systemd en VPS)
- **Audit log:** tabla `audit_log` (inmutable, retencion 730 dias por default)
- **Conversaciones:** tabla `conversations` + `messages` (incluye usage de tokens)
- **Costos Claude API:** ver `messages.tokens_*` por conversacion para tracking

## Costo operativo estimado

| Item | $/mes |
|---|---|
| VPS (DigitalOcean / Hetzner) | $20-60 |
| Claude API (con prompt caching) | $200-400 |
| Samsara | incluido en plan |
| **Total** | **~$220-460** |

## Roadmap

**v0.1 (este scaffold) - MVP funcional:**
- [x] Login, roles, chat, dashboard responsive
- [x] Agente con 13 tools (Samsara HOS, CFR, SMS, audit)
- [x] Schema completo, ingesta SMS
- [x] CFR index inicial (15 secciones clave)

**v0.2 - Sprint 1:**
- [ ] Sync background de Samsara (job cron, drivers/vehicles a DB)
- [ ] Admin UI para gestion de usuarios
- [ ] Notificaciones in-app cuando driver se acerca al limite
- [ ] Expandir CFR index a Parts 380-399 completo (vector DB)

**v0.3 - Sprint 2:**
- [ ] Reportes en PDF descargables desde la UI
- [ ] Webhooks de Samsara (HOS events push)
- [ ] BOTDOT-Hire (modulo de pre-screening de candidatos)

## Soporte / mantenimiento

- Repo: definir con equipo
- CI/CD: pendiente (recomendado: GitHub Actions deploy a VPS via SSH)
- Backup DB: cron diario de mysqldump a S3 / R2 (pendiente)

## Licencia / privacidad

Software interno de Intelogix. Datos de drivers, asignaciones y compliance son confidenciales. **No commitear .env, no commitear data/*.csv con datos reales.**

Esta herramienta no constituye asesoria legal. Para decisiones criticas, consultar compliance officer y/o abogado de transporte.
