// Tools del agente que consultan Samsara y aplican reglas HOS (49 CFR 395).
//
// Lee preferentemente del cache local (driver_hos_cache, poblado por
// src/sync/hos.js cada 5 min). Si el cache no tiene la fila pedida, cae
// al live API. Esto desacopla el agente de la disponibilidad de Samsara
// y reduce latencia.

const samsara = require('../../integrations/samsara-client');
const db = require('../../db/pool');

// Cuanto puede tardar una fila del cache en estar "fresca". Si el sync
// corre cada 5 min, dejamos un colchon hasta 15 min antes de considerar
// el cache stale e ir al live.
const HOS_CACHE_STALE_MIN = 15;

function cachedRowToSummary(row) {
  return {
    driverId: row.samsara_driver_id,
    driverName: row.driver_name,
    clockState: row.clock_state,
    drive: { usedMin: row.drive_used_min, limitMin: 660, remainingMin: row.drive_remaining_min },
    duty:  { usedMin: row.duty_used_min,  limitMin: 840, remainingMin: row.duty_remaining_min },
    cycle: { usedMin: row.cycle_used_min, limitMin: 4200, remainingMin: row.cycle_remaining_min },
    timestamp: row.fetched_at,
    source: 'cache',
    cache_age_sec: row.staleness_sec,
  };
}

// ─── samsara_get_driver_hos ────────────────────────────────
const getDriverHos = {
  definition: {
    name: 'samsara_get_driver_hos',
    description: 'Consulta el estado HOS en tiempo real de un driver via Samsara API. Devuelve tiempos usados/disponibles para drive (11h), duty (14h) y cycle (70h).',
    input_schema: {
      type: 'object',
      properties: {
        driver_name_or_id: {
          type: 'string',
          description: 'Nombre completo del driver o samsara_id. El sistema buscara primero por samsara_id, luego por match exacto de nombre.',
        },
      },
      required: ['driver_name_or_id'],
    },
  },
  handler: async ({ driver_name_or_id }) => {
    let samsaraId = driver_name_or_id;
    let driverRow = await db.queryOne(
      'SELECT samsara_id, full_name FROM drivers WHERE samsara_id = ? OR full_name = ?',
      [driver_name_or_id, driver_name_or_id]
    );
    if (driverRow) samsaraId = driverRow.samsara_id;

    // Intentar cache primero
    const cached = await db.queryOne(
      `SELECT *, TIMESTAMPDIFF(SECOND, fetched_at, NOW()) AS staleness_sec
       FROM driver_hos_cache WHERE samsara_driver_id = ?`,
      [samsaraId]
    );
    if (cached && cached.staleness_sec / 60 <= HOS_CACHE_STALE_MIN) {
      return cachedRowToSummary(cached);
    }

    // Cache miss o stale → live
    const clock = await samsara.getDriverHosClock(samsaraId);
    if (!clock) return { error: `No se encontro HOS clock para ${driver_name_or_id}` };
    return { ...samsara.summarizeHosClock(clock), source: 'live' };
  },
};

// ─── samsara_search_driver ─────────────────────────────────
const searchDriver = {
  definition: {
    name: 'samsara_search_driver',
    description: 'Busca drivers por nombre parcial. Devuelve hasta 10 matches con samsara_id y CDL info.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto parcial del nombre' },
      },
      required: ['query'],
    },
  },
  handler: async ({ query }) => {
    const rows = await db.query(
      `SELECT samsara_id, full_name, cdl_number, cdl_state, cdl_expiration, medical_card_expiration, active
       FROM drivers WHERE full_name LIKE ? AND active = 1 LIMIT 10`,
      [`%${query}%`]
    );
    return { matches: rows };
  },
};

// ─── samsara_get_drivers_near_limit ───────────────────────
const getDriversNearLimit = {
  definition: {
    name: 'samsara_get_drivers_near_limit',
    description: 'Lista drivers que estan a menos de N minutos de algun limite HOS (drive 11h, duty 14h, cycle 70h). Util para alertas proactivas de supervisor.',
    input_schema: {
      type: 'object',
      properties: {
        threshold_minutes: { type: 'integer', description: 'Minutos restantes para considerar "cerca". Default 90.', default: 90 },
        limit_type: {
          type: 'string',
          enum: ['drive', 'duty', 'cycle', 'any'],
          description: 'Cual limite considerar. Default any.',
          default: 'any',
        },
      },
    },
  },
  handler: async ({ threshold_minutes = 90, limit_type = 'any' }) => {
    // Lee del cache. Si esta vacio, el primer sync todavia no corrio —
    // devolvemos lista vacia con nota explicativa.
    const rows = await db.query(
      `SELECT *, TIMESTAMPDIFF(SECOND, fetched_at, NOW()) AS staleness_sec
       FROM driver_hos_cache`
    );
    if (!rows.length) {
      return {
        count: 0,
        drivers: [],
        note: 'driver_hos_cache vacio. Esperar al primer sync o forzar via /api/admin/sync/run',
      };
    }
    const flagged = [];
    for (const r of rows) {
      const limits = {
        drive: r.drive_remaining_min,
        duty: r.duty_remaining_min,
        cycle: r.cycle_remaining_min,
      };
      const checks = limit_type === 'any' ? Object.entries(limits) : [[limit_type, limits[limit_type]]];
      for (const [key, remaining] of checks) {
        if (remaining != null && remaining <= threshold_minutes && remaining > 0) {
          flagged.push({
            driverName: r.driver_name,
            driverId: r.samsara_driver_id,
            limit: key,
            remainingMin: remaining,
            clockState: r.clock_state,
            fetched_at: r.fetched_at,
          });
          break;
        }
      }
    }
    flagged.sort((a, b) => a.remainingMin - b.remainingMin);
    const oldest = Math.max(...rows.map(r => r.staleness_sec || 0));
    return {
      count: flagged.length,
      drivers: flagged.slice(0, 50),
      source: 'cache',
      cache_oldest_age_sec: oldest,
    };
  },
};

// ─── samsara_get_vehicle_status ───────────────────────────
const getVehicleStatus = {
  definition: {
    name: 'samsara_get_vehicle_status',
    description: 'Consulta status de un vehiculo: annual inspection, OOS pendiente, mantenimiento.',
    input_schema: {
      type: 'object',
      properties: {
        vin_or_unit: { type: 'string', description: 'VIN o numero de unidad' },
      },
      required: ['vin_or_unit'],
    },
  },
  handler: async ({ vin_or_unit }) => {
    const v = await db.queryOne(
      `SELECT samsara_id, vin, unit_number, type, make, model, year, license_plate, license_state,
              annual_inspection_date, oos_status, active
       FROM vehicles WHERE vin = ? OR unit_number = ? LIMIT 1`,
      [vin_or_unit, vin_or_unit]
    );
    if (!v) return { error: `Vehiculo no encontrado: ${vin_or_unit}` };

    const today = new Date();
    const annualDate = v.annual_inspection_date ? new Date(v.annual_inspection_date) : null;
    const annualValid = annualDate ? (today - annualDate) / (1000 * 60 * 60 * 24) <= 365 : false;

    return {
      vehicle: v,
      annual_status: annualDate
        ? annualValid
          ? 'valid'
          : 'expired'
        : 'unknown',
      annual_days_remaining: annualDate
        ? Math.max(0, Math.round(365 - (today - annualDate) / (1000 * 60 * 60 * 24)))
        : null,
      oos: !!v.oos_status,
      cfr_relevant: ['396.17 (periodic inspection)', '396.21 (carrier responsibility for annual)'],
    };
  },
};

// ─── evaluateHosCompliance ────────────────────────────────
// Logica pura HOS extraida para testabilidad. Recibe un snapshot HOS
// (formato de samsara.summarizeHosClock) y los parametros de la load,
// devuelve la misma estructura que checkAssignmentCompliance pero sin
// tocar I/O. Tests en test/hos-rules.test.js.
function evaluateHosCompliance(hos, { estimated_drive_minutes, load_window_minutes, load_reference }) {
  const totalWindow = load_window_minutes || estimated_drive_minutes + 120;
  const violations = [];

  if (estimated_drive_minutes > hos.drive.remainingMin) {
    violations.push({
      cfr: '49 CFR 395.3(a)(3)',
      rule: 'Driving limit (11 horas)',
      gap_min: estimated_drive_minutes - hos.drive.remainingMin,
      detail: `Driver tiene ${hos.drive.remainingMin}min drive disponible. Load requiere ${estimated_drive_minutes}min.`,
    });
  }
  if (totalWindow > hos.duty.remainingMin) {
    violations.push({
      cfr: '49 CFR 395.3(a)(2)',
      rule: '14-hour duty limit',
      gap_min: totalWindow - hos.duty.remainingMin,
      detail: `Driver tiene ${hos.duty.remainingMin}min duty disponible. Ventana total ${totalWindow}min.`,
    });
  }
  if (totalWindow > hos.cycle.remainingMin) {
    violations.push({
      cfr: '49 CFR 395.3(b)',
      rule: '70-hour cycle limit',
      gap_min: totalWindow - hos.cycle.remainingMin,
      detail: `Driver tiene ${hos.cycle.remainingMin}min de ciclo. Ventana ${totalWindow}min.`,
    });
  }

  let decision = 'proceed';
  if (violations.length === 0) decision = 'proceed';
  else if (violations.every(v => v.gap_min < 60)) decision = 'conditional';
  else decision = 'decline';

  return {
    decision,
    violations,
    hos_snapshot: hos,
    load_reference: load_reference || null,
    cfr_basis: violations.map(v => v.cfr),
    disclaimer: 'Esto no constituye asesoria legal. La decision final es del dispatcher/supervisor.',
  };
}

// ─── check_assignment_compliance ──────────────────────────
const checkAssignmentCompliance = {
  definition: {
    name: 'check_assignment_compliance',
    description: 'Evalua si una asignacion propuesta (driver + load) es compliant con HOS. Aplica 49 CFR 395.3 (11hr/14hr/70hr) y verifica gap. Devuelve PROCEED/CONDITIONAL/DECLINE con razon y CFR citado.',
    input_schema: {
      type: 'object',
      properties: {
        driver_name_or_id: { type: 'string' },
        estimated_drive_minutes: { type: 'integer', description: 'Minutos estimados de manejo del load' },
        load_window_minutes: { type: 'integer', description: 'Ventana total disponible incluyendo paradas, pickup, delivery (default = drive_minutes + 120)' },
        load_reference: { type: 'string', description: 'ID/referencia de la load para audit' },
      },
      required: ['driver_name_or_id', 'estimated_drive_minutes'],
    },
  },
  handler: async (params) => {
    const hos = await getDriverHos.handler({ driver_name_or_id: params.driver_name_or_id });
    if (hos.error) return hos;
    return evaluateHosCompliance(hos, params);
  },
};

module.exports = {
  getDriverHos,
  searchDriver,
  getDriversNearLimit,
  getVehicleStatus,
  checkAssignmentCompliance,
  evaluateHosCompliance,
};
