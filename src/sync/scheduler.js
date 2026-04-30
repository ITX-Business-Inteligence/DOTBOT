// Scheduler de sync. Corre los handlers individuales en intervalos
// configurables. Se arranca desde server.js al boot.
//
// Estrategia simple: setInterval. Para single-VPS con 1 instancia esto
// alcanza. Si alguna vez se escala a multi-instancia, hay que migrar a
// algo como BullMQ/agenda con una cola compartida para evitar que cada
// instancia corra el sync en paralelo (lock distribuido).

const config = require('../config');
const logger = require('../utils/logger');
const { syncDrivers } = require('./drivers');
const { syncVehicles } = require('./vehicles');
const { syncHosClocks } = require('./hos');

const log = logger.child({ component: 'sync-scheduler' });

let timers = [];
let started = false;

function start() {
  if (started) return;
  if (!config.sync.enabled) {
    log.info('scheduler deshabilitado (BOTDOT_SYNC_ENABLED=false)');
    return;
  }
  started = true;

  const driverMs = config.sync.intervalDriversMin * 60 * 1000;
  const vehicleMs = config.sync.intervalVehiclesMin * 60 * 1000;
  const hosMs = config.sync.intervalHosMin * 60 * 1000;

  // Primera corrida diferida unos segundos para no bloquear el boot
  setTimeout(() => runSafe('drivers', syncDrivers), 2000);
  setTimeout(() => runSafe('vehicles', syncVehicles), 4000);
  setTimeout(() => runSafe('hos_clocks', syncHosClocks), 6000);

  // Periodicas
  timers.push(setInterval(() => runSafe('drivers', syncDrivers), driverMs));
  timers.push(setInterval(() => runSafe('vehicles', syncVehicles), vehicleMs));
  timers.push(setInterval(() => runSafe('hos_clocks', syncHosClocks), hosMs));

  log.info({
    drivers_min: config.sync.intervalDriversMin,
    vehicles_min: config.sync.intervalVehiclesMin,
    hos_min: config.sync.intervalHosMin,
  }, 'scheduler arrancado');
}

async function runSafe(name, fn) {
  try {
    const r = await fn();
    if (r && r.ok) {
      log.info({ resource: name, records: r.records, duration_ms: r.duration_ms }, `sync ${name} ok`);
    }
  } catch (err) {
    // El runner ya loggea, pero si algo escapa lo capturamos aqui para
    // que un error en un sync no cuelgue al proceso.
    log.error({ err, resource: name }, `sync ${name} uncaught`);
  }
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  started = false;
}

module.exports = { start, stop };
