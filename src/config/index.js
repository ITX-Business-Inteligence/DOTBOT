require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variable de entorno requerida: ${name}`);
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  },

  anthropic: {
    // Si BOTDOT_MOCK_LLM=true, no exigimos API key (no se va a llamar).
    apiKey: process.env.BOTDOT_MOCK_LLM === 'true'
      ? (process.env.ANTHROPIC_API_KEY || 'mock')
      : required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    modelHeavy: process.env.CLAUDE_MODEL_HEAVY || 'claude-opus-4-7',
    mock: process.env.BOTDOT_MOCK_LLM === 'true',
  },

  samsara: {
    // Si BOTDOT_MOCK_SAMSARA=true, no exigimos token (no se llama).
    token: process.env.BOTDOT_MOCK_SAMSARA === 'true'
      ? (process.env.SAMSARA_API_TOKEN || 'mock')
      : required('SAMSARA_API_TOKEN'),
    baseUrl: process.env.SAMSARA_BASE_URL || 'https://api.samsara.com',
    mock: process.env.BOTDOT_MOCK_SAMSARA === 'true',
  },

  sync: {
    // Habilitar el scheduler en background. Default: true en development
    // (con mock o real), pero ponelo en false si no queres jobs corriendo.
    enabled: process.env.BOTDOT_SYNC_ENABLED !== 'false',
    // Frecuencias en minutos. Drivers/vehicles cambian poco; HOS clocks
    // cambian continuamente.
    intervalDriversMin: parseInt(process.env.BOTDOT_SYNC_DRIVERS_MIN || '60', 10),
    intervalVehiclesMin: parseInt(process.env.BOTDOT_SYNC_VEHICLES_MIN || '60', 10),
    intervalHosMin: parseInt(process.env.BOTDOT_SYNC_HOS_MIN || '5', 10),
  },

  jobs: {
    // Scheduler de jobs proactivos (expiration-alerts, cfr-update).
    enabled: process.env.BOTDOT_JOBS_ENABLED !== 'false',
    // Hora del dia (HH:MM) para correr el scan de expirations. Por defecto
    // 6 AM. Si BOTDOT_ALERTS_INTERVAL_MIN > 0, ese override gana (modo dev).
    alertsAt: process.env.BOTDOT_ALERTS_AT || '06:00',
    // Para dev: correr cada N min en lugar de diario. 0 = usar alertsAt.
    alertsIntervalMin: parseInt(process.env.BOTDOT_ALERTS_INTERVAL_MIN || '0', 10),
    // CFR update: corre antes de alerts (4 AM por defecto) para que
    // expiration-alerts use texto fresco si el bot lo necesita.
    cfrUpdateAt: process.env.BOTDOT_CFR_UPDATE_AT || '04:00',
    cfrUpdateEnabled: process.env.BOTDOT_CFR_UPDATE_ENABLED !== 'false',
  },

  fmcsa: {
    usdot: process.env.FMCSA_USDOT || '2195271',
  },

  auth: {
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
    cookieSecret: required('COOKIE_SECRET'),
  },

  audit: {
    retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '730', 10),
  },

  log: {
    // trace | debug | info | warn | error | fatal | silent
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    // En dev usa pino-pretty (lectura humana). En prod, JSON estructurado a stdout.
    pretty: process.env.LOG_PRETTY === 'true' || (!process.env.LOG_PRETTY && process.env.NODE_ENV !== 'production'),
  },

  email: {
    // Si BOTDOT_MOCK_EMAIL=true, no se envia mail real — se loggea en stderr.
    // Util en dev sin SMTP. En prod debe estar en false con SMTP_* configurado.
    mock: process.env.BOTDOT_MOCK_EMAIL === 'true' || !process.env.BOTDOT_SMTP_HOST,
    smtp: {
      host: process.env.BOTDOT_SMTP_HOST || null,
      port: parseInt(process.env.BOTDOT_SMTP_PORT || '587', 10),
      secure: process.env.BOTDOT_SMTP_SECURE === 'true',
      user: process.env.BOTDOT_SMTP_USER || null,
      pass: process.env.BOTDOT_SMTP_PASS || null,
    },
    from: process.env.BOTDOT_SMTP_FROM || 'BOTDOT <noreply@intelogix.mx>',
    // Override opcional: lista CSV de emails a quien mandar TODAS las
    // escalaciones (ej. una alias compliance@intelogix.mx). Si esta vacio,
    // se envia a todos los usuarios con rol compliance activos.
    escalationsTo: process.env.BOTDOT_ESCALATIONS_TO || '',
  },

  chat: {
    // Cap diario por usuario (USD). 0 desactiva el cap. Ventana 24h rolling.
    userDailyBudgetUsd: parseFloat(process.env.BOTDOT_USER_DAILY_BUDGET_USD || '5'),
    // Cap diario organizacional (USD). 0 desactiva. Ventana 24h rolling.
    orgDailyBudgetUsd: parseFloat(process.env.BOTDOT_ORG_DAILY_BUDGET_USD || '25'),
    // Rate limit por usuario sobre /api/chat/send (req/min). 0 desactiva.
    userRateLimitPerMin: parseInt(process.env.BOTDOT_CHAT_RATE_LIMIT_PER_MIN || '30', 10),
  },
};
