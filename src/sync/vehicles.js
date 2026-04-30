// Sync de vehicles desde Samsara → tabla local `vehicles`.
// Idempotente via ON DUPLICATE KEY UPDATE sobre samsara_id.

const samsara = require('../integrations/samsara-client');
const db = require('../db/pool');
const { runSync } = require('./runner');

async function syncVehicles() {
  return runSync('vehicles', async () => {
    const list = await samsara.listVehicles({ limit: 1000 });
    let n = 0;
    for (const v of list) {
      await db.query(
        `INSERT INTO vehicles
           (samsara_id, vin, unit_number, type, make, model, year,
            license_plate, license_state, annual_inspection_date,
            oos_status, active, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           vin = VALUES(vin),
           unit_number = VALUES(unit_number),
           type = VALUES(type),
           make = VALUES(make),
           model = VALUES(model),
           year = VALUES(year),
           license_plate = VALUES(license_plate),
           license_state = VALUES(license_state),
           annual_inspection_date = VALUES(annual_inspection_date),
           oos_status = VALUES(oos_status),
           active = VALUES(active),
           last_synced_at = VALUES(last_synced_at)`,
        [
          v.id,
          v.vin || '(sin VIN)',
          v.name || null,
          v.vehicleType || null,
          v.make || null,
          v.model || null,
          v.year || null,
          v.licensePlate || null,
          v.licenseState || null,
          v.annualInspectionDate || null,
          v.outOfService ? 1 : 0,
          1,
        ]
      );
      n++;
    }
    return n;
  });
}

module.exports = { syncVehicles };
