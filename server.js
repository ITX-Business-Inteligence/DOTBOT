const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const scheduler = require('./src/sync/scheduler');
const jobsScheduler = require('./src/jobs/scheduler');
const { pool } = require('./src/db/pool');

const app = express();

app.set('trust proxy', 1);

// Logger HTTP — agrega req.log a cada request con un id unico, y al
// terminar imprime una linea con method/url/status/duration. Roles 4xx/5xx
// se loggean como warn/error automaticamente.
app.use(pinoHttp({
  logger,
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} ${err?.message || ''}`,
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip || req.remoteAddress,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  customProps: (req) => ({
    user_id: req.user?.id || null,
    role: req.user?.role || null,
  }),
  autoLogging: {
    ignore: (req) => req.url === '/api/health',
  },
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // scriptSrc SIN 'unsafe-inline' — todos los scripts viven en archivos
      // bajo /public/js. Esto convierte un XSS escapado-faltante en HTML
      // de "JS arbitrario ejecutado" a "texto literal renderizado".
      scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net'],
      // styleSrc mantiene 'unsafe-inline' porque Tailwind CDN inyecta
      // estilos via JS y nuestros HTML usan style="..." en algunos lugares
      // (heatmap dinamico de analytics). El riesgo es menor que para scripts.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      // PWA: el browser necesita poder fetchear /manifest.json y registrar /sw.js
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(config.auth.cookieSecret));

// Health endpoint — durante shutdown devuelve 503 para que load balancers
// dejen de mandar trafico inmediatamente, sin esperar al SIGTERM full cycle.
let isShuttingDown = false;
app.get('/api/health', (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ ok: false, shutting_down: true, ts: new Date().toISOString() });
  }
  res.json({
    ok: true,
    env: config.env,
    mock_llm: !!config.anthropic.mock,
    mock_samsara: !!config.samsara.mock,
    sync_enabled: !!config.sync.enabled,
    ts: new Date().toISOString(),
  });
});

// Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/chat', require('./src/routes/chat'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/audit', require('./src/routes/audit'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/escalations', require('./src/routes/escalations'));
app.use('/api/notifications', require('./src/routes/notifications'));

// Static
app.use(express.static(path.join(__dirname, 'public')));

// 404 JSON para /api/* no existentes — antes que el SPA fallback se trague
// la request y devuelva el HTML del login con 200. Un cliente que pega a
// un endpoint API mal escrito tiene que ver un 404 estructurado, no la pagina.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Endpoint no encontrado: ${req.method} ${req.originalUrl}` });
});

// SPA fallback (solo HTML pages — no /api/*)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler — usa req.log si esta disponible (lleva request_id + user)
app.use((err, req, res, next) => {
  const log = req.log || logger;
  log.error({ err }, 'unhandled error in route');
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});

const httpServer = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env, url: config.publicUrl }, 'BOTDOT escuchando');

  if (config.env === 'production' && (config.anthropic.mock || config.samsara.mock)) {
    logger.warn(
      { mock_llm: config.anthropic.mock, mock_samsara: config.samsara.mock },
      '[WARNING] MOCK MODE EN PRODUCCION — verifica .env'
    );
  }

  scheduler.start();
  jobsScheduler.start();
});

// ────────────────────────────────────────────────────────────────
// Graceful shutdown
// ────────────────────────────────────────────────────────────────
//
// Comportamiento al recibir SIGTERM (pm2 restart, docker stop, kill PID)
// o SIGINT (Ctrl+C en dev):
//
//   1. /api/health responde 503 — load balancer empieza a draining
//   2. server.close() deja de aceptar requests nuevas, espera a que
//      las en-vuelo terminen (si las hay)
//   3. Schedulers de sync + jobs se detienen (clearInterval)
//   4. MySQL pool se cierra cuando todas las conexiones vuelven al pool
//   5. Logger flusha buffers
//   6. Exit code 0
//
// Si despues de SHUTDOWN_TIMEOUT_MS no se completo, force exit con 1.
// pm2 manda SIGKILL despues de su `kill_timeout` (4s default), asi que
// conviene mantener el shutdown < 4s en prod ajustando la config de pm2
// o configurando kill_timeout = 30000 en ecosystem.config.js.

const SHUTDOWN_TIMEOUT_MS = 30000;

// Helper: escribe a stderr sync (bypass pino-pretty worker thread que no
// flushea garantizado antes del exit). Asi siempre vemos el progreso del
// shutdown aunque el transport buffere.
function shutdownLog(msg) {
  process.stderr.write(`[shutdown] ${new Date().toISOString()} ${msg}\n`);
}

function gracefulShutdown(signal) {
  if (isShuttingDown) {
    shutdownLog(`segundo signal ${signal} recibido durante shutdown — force exit`);
    process.exit(1);
  }
  isShuttingDown = true;
  shutdownLog(`iniciando graceful shutdown (signal=${signal})`);
  logger.info({ signal }, 'iniciando graceful shutdown');

  const forceExitTimer = setTimeout(() => {
    logger.error({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'shutdown timeout — force exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  (async () => {
    try {
      // 1. Stop accepting new HTTP connections (espera in-flight).
      //    Si el server nunca llego a bindear (ej. EADDRINUSE), httpServer.listening=false.
      if (httpServer.listening) {
        await new Promise((resolve) => {
          httpServer.close(() => resolve());
          if (typeof httpServer.closeIdleConnections === 'function') {
            httpServer.closeIdleConnections();
          }
        });
        shutdownLog('http server closed');
      } else {
        shutdownLog('http server no estaba listening — skip close');
      }

      try { scheduler.stop(); } catch (e) { shutdownLog(`sync scheduler stop err: ${e.message}`); }
      try { jobsScheduler.stop(); } catch (e) { shutdownLog(`jobs scheduler stop err: ${e.message}`); }
      shutdownLog('schedulers stopped');

      try {
        await pool.end();
        shutdownLog('mysql pool closed');
      } catch (e) {
        shutdownLog(`mysql pool close failed: ${e.message}`);
      }

      if (typeof logger.flush === 'function') {
        try { logger.flush(); } catch {}
      }

      shutdownLog('shutdown completo, exiting');
      clearTimeout(forceExitTimer);
      // Delay mas largo (500ms) para que el worker thread de pino-pretty
      // alcance a flushear sus buffers antes del exit.
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  })();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — iniciando shutdown');
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason },
    'unhandledRejection — iniciando shutdown');
  gracefulShutdown('unhandledRejection');
});
