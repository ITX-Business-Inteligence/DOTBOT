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
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    modelHeavy: process.env.CLAUDE_MODEL_HEAVY || 'claude-opus-4-7',
  },

  samsara: {
    token: required('SAMSARA_API_TOKEN'),
    baseUrl: process.env.SAMSARA_BASE_URL || 'https://api.samsara.com',
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
};
