// Sync de HOS clocks desde Samsara → tabla `driver_hos_cache`.
// Esta es la mas frecuente (cada 5 min por defecto) porque los clocks
// cambian continuamente con la actividad del driver.

const samsara = require('../integrations/samsara-client');
const db = require('../db/pool');
const { runSync } = require('./runner');

async function syncHosClocks() {
  return runSync('hos_clocks', async () => {
    const clocks = await samsara.getDriverHosClocks();
    let n = 0;
    for (const c of clocks) {
      const summary = samsara.summarizeHosClock(c);
      if (!summary || !summary.driverId) continue;
      await db.query(
        `INSERT INTO driver_hos_cache
           (samsara_driver_id, driver_name, clock_state,
            drive_used_min, drive_remaining_min,
            duty_used_min, duty_remaining_min,
            cycle_used_min, cycle_remaining_min,
            raw_clock_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE
           driver_name = VALUES(driver_name),
           clock_state = VALUES(clock_state),
           drive_used_min = VALUES(drive_used_min),
           drive_remaining_min = VALUES(drive_remaining_min),
           duty_used_min = VALUES(duty_used_min),
           duty_remaining_min = VALUES(duty_remaining_min),
           cycle_used_min = VALUES(cycle_used_min),
           cycle_remaining_min = VALUES(cycle_remaining_min),
           raw_clock_json = VALUES(raw_clock_json),
           fetched_at = VALUES(fetched_at)`,
        [
          summary.driverId,
          summary.driverName,
          summary.clockState,
          summary.drive.usedMin,
          summary.drive.remainingMin,
          summary.duty.usedMin,
          summary.duty.remainingMin,
          summary.cycle.usedMin,
          summary.cycle.remainingMin,
          JSON.stringify(c),
        ]
      );
      n++;
    }
    return n;
  });
}

module.exports = { syncHosClocks };
