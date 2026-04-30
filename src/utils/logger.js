// Logger estructurado del proyecto. Usa pino — JSON en prod, pretty en dev.
//
// Uso basico (sin contexto):
//   const logger = require('./utils/logger');
//   logger.info('mensaje');
//   logger.error({ err }, 'algo fallo');
//
// Uso con contexto (recomendado para jobs / tools / requests):
//   const log = logger.child({ job: 'cfr-update', run_id: 5 });
//   log.info('start');
//   log.info({ sections_changed: 3 }, 'done');
//
// En requests HTTP, pino-http (configurado en server.js) crea automaticamente
// req.log con un request_id. authMiddleware lo enriquece con user_id y role
// asi cada log line del request lleva esa info.
//
// REDACT: passwords, cookies y headers sensibles se enmascaran automaticamente.
// Si pusieras un objeto con .password en el log, sale [REDACTED].

const pino = require('pino');
const config = require('./../config');

const REDACT_PATHS = [
  // Passwords en cualquier nivel
  '*.password',
  '*.password_hash',
  '*.current_password',
  '*.new_password',
  // Tokens
  '*.api_key',
  '*.api_token',
  '*.token',
  // Headers sensibles del request (con y sin prefix req.)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  // Body de cambio de password
  'body.current_password',
  'body.new_password',
  'body.password',
];

const baseOpts = {
  level: config.log.level,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  base: {
    service: 'botdot',
    env: config.env,
  },
  // Convertir Error en objeto con message + stack
  serializers: {
    err: pino.stdSerializers.err,
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.ip,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
};

const transport = config.log.pretty
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname,service,env',
      },
    })
  : undefined;

const logger = pino(baseOpts, transport);

module.exports = logger;
