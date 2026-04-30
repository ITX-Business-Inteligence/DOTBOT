// Scheduler de jobs proactivos (separado del scheduler de Samsara sync).
//
// Hoy: solo expiration-alerts.
// Manana: cualquier otro job recurrente (cleanup de audit > 730 dias,
// reportes mensuales, etc.).
//
// Frecuencia: por defecto diaria a las 6 AM (config.jobs.alertsAt).
// En dev, usar BOTDOT_ALERTS_INTERVAL_MIN=5 para que corra cada 5 min y
// verifiques el flow.

const config = require('../config');
const logger = require('../utils/logger');
const { runExpirationAlerts } = require('./expiration-alerts');
const { runCfrUpdate } = require('./cfr-update');

const log = logger.child({ component: 'jobs-scheduler' });

let timers = [];
let started = false;

function msUntilNextDailyRun(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function start() {
  if (started) return;
  if (!config.jobs.enabled) {
    log.info('[jobs] scheduler deshabilitado (BOTDOT_JOBS_ENABLED=false)');
    return;
  }
  started = true;

  if (config.jobs.alertsIntervalMin > 0) {
    // Modo dev: corre cada N min (el CFR update no usa este modo, es muy
    // pesado para correrlo cada 5 min — solo manual via UI o restart).
    const ms = config.jobs.alertsIntervalMin * 60 * 1000;
    setTimeout(() => safeRun('expiration-alerts', runExpirationAlerts), 5000);
    timers.push(setInterval(() => safeRun('expiration-alerts', runExpirationAlerts), ms));
    log.info(`[jobs] expiration-alerts cada ${config.jobs.alertsIntervalMin} min (modo interval)`);
  } else {
    // Modo prod: diario a la hora configurada
    const [h, m] = (config.jobs.alertsAt || '06:00').split(':').map(n => parseInt(n, 10));
    scheduleDaily('expiration-alerts', runExpirationAlerts, h, m);
    log.info(`[jobs] expiration-alerts diario a las ${h}:${String(m).padStart(2, '0')}`);
  }

  // CFR update: diario a las 4 AM (antes que alerts a las 6 AM)
  if (config.jobs.cfrUpdateEnabled) {
    const [h, m] = (config.jobs.cfrUpdateAt || '04:00').split(':').map(n => parseInt(n, 10));
    scheduleDaily('cfr-update', () => runCfrUpdate({ trigger: 'cron' }), h, m);
    log.info(`[jobs] cfr-update diario a las ${h}:${String(m).padStart(2, '0')}`);
  }
}

function scheduleDaily(name, fn, hour, minute) {
  const delay = msUntilNextDailyRun(hour, minute);
  setTimeout(async () => {
    await safeRun(name, fn);
    timers.push(setInterval(() => safeRun(name, fn), 24 * 60 * 60 * 1000));
  }, delay);
}

async function safeRun(name, fn) {
  try {
    await fn();
  } catch (err) {
    log.error({ err, job: name }, `[jobs:${name}] failed`);
  }
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  started = false;
}

module.exports = {
  start, stop,
  runExpirationAlertsNow: () => runExpirationAlerts(),
  runCfrUpdateNow: (opts) => runCfrUpdate(opts),
};
