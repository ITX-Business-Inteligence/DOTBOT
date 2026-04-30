// Sync de drivers desde Samsara → tabla local `drivers`.
//
// Reglas de coexistencia con el Excel de compliance:
//   - Samsara es DUEÑO de: samsara_id, full_name (canonico), active.
//   - Excel/manual es DUEÑO de: cdl_*, medical_card_*, endorsements,
//     phone, hire_date, company, location, division, notes.
//
// Implementacion: si el row ya existia con data_source='excel' o
// 'samsara+excel' o 'manual', solo actualizamos los campos de identidad
// (samsara_id, full_name, active) y last_synced_at. Si era 'samsara' o
// fila nueva, escribimos todo lo que Samsara nos da.

const samsara = require('../integrations/samsara-client');
const db = require('../db/pool');
const { runSync } = require('./runner');

async function syncDrivers() {
  return runSync('drivers', async () => {
    const list = await samsara.listDrivers({ active: true, limit: 1000 });
    let n = 0;
    for (const d of list) {
      // Verificar si existe alguna fila ya enriquecida desde Excel/manual.
      // Match preferentemente por samsara_id, fallback por nombre exacto.
      const existing = await db.queryOne(
        `SELECT id, data_source FROM drivers
         WHERE samsara_id = ?
            OR (samsara_id IS NULL AND full_name = ?)
         LIMIT 1`,
        [d.id, d.name || '']
      );

      const ownsCompliance = existing && ['excel', 'samsara+excel', 'manual'].includes(existing.data_source);

      if (existing) {
        if (ownsCompliance) {
          // Solo identidad — no toques compliance fields
          await db.query(
            `UPDATE drivers SET
               samsara_id = ?,
               full_name = ?,
               active = ?,
               last_synced_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              d.id,
              d.name || existing.full_name,
              (d.driverActivationStatus || 'active') === 'active' ? 1 : 0,
              existing.id,
            ]
          );
        } else {
          // Samsara es la unica fuente — escribir todo
          await db.query(
            `UPDATE drivers SET
               samsara_id = ?,
               full_name = ?,
               cdl_number = ?,
               cdl_state = ?,
               cdl_expiration = ?,
               medical_card_expiration = ?,
               endorsements = ?,
               active = ?,
               data_source = 'samsara',
               last_synced_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              d.id, d.name || '(sin nombre)',
              d.licenseNumber || null,
              d.licenseState || null,
              d.licenseExpirationDate || null,
              d.medicalCard && d.medicalCard.expirationDate ? d.medicalCard.expirationDate : null,
              d.endorsements || null,
              (d.driverActivationStatus || 'active') === 'active' ? 1 : 0,
              existing.id,
            ]
          );
        }
      } else {
        // Fila nueva — INSERT con todo lo de Samsara
        await db.query(
          `INSERT INTO drivers
             (samsara_id, full_name, cdl_number, cdl_state, cdl_expiration,
              medical_card_expiration, endorsements, active, data_source, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'samsara', CURRENT_TIMESTAMP)`,
          [
            d.id,
            d.name || '(sin nombre)',
            d.licenseNumber || null,
            d.licenseState || null,
            d.licenseExpirationDate || null,
            d.medicalCard && d.medicalCard.expirationDate ? d.medicalCard.expirationDate : null,
            d.endorsements || null,
            (d.driverActivationStatus || 'active') === 'active' ? 1 : 0,
          ]
        );
      }
      n++;
    }
    return n;
  });
}

module.exports = { syncDrivers };
