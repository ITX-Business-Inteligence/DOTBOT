// Tools que consultan datos del SMS / BASICs / inspecciones / crashes.
// Lee de la DB poblada por src/utils/ingest-sms.js

const db = require('../../db/pool');

const queryBasicsStatus = {
  definition: {
    name: 'query_basics_status',
    description: 'Devuelve el estado actual de los 7 BASICs del carrier (score, threshold, alert, months in alert) basado en el snapshot mas reciente del SMS.',
    input_schema: { type: 'object', properties: {} },
  },
  handler: async () => {
    const rows = await db.query(
      `SELECT basic_name, measure, score_pct, threshold_pct, alert, months_in_alert,
              violations_count, oos_count, snapshot_date
       FROM sms_snapshots
       WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots)
       ORDER BY score_pct DESC`
    );
    if (!rows.length) return { error: 'No hay snapshots de SMS cargados. Ejecutar npm run ingest-sms.' };
    return { snapshot_date: rows[0].snapshot_date, basics: rows };
  },
};

const queryTopViolations = {
  definition: {
    name: 'query_top_violations',
    description: 'Top N violaciones por puntos totales en un BASIC (o todos). Util para Pareto y plan de mitigacion.',
    input_schema: {
      type: 'object',
      properties: {
        basic: { type: 'string', description: 'Nombre del BASIC o "all" para todos. Default all.' },
        limit: { type: 'integer', default: 15 },
      },
    },
  },
  handler: async ({ basic = 'all', limit = 15 }) => {
    const where = basic === 'all' ? '' : 'AND basic_name = ?';
    const params = basic === 'all' ? [limit] : [basic, limit];
    const rows = await db.query(
      `SELECT basic_name, violation_code, violation_group, description, count, oos_count, severity_weight, total_points
       FROM sms_violations
       WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_violations)
       ${where}
       ORDER BY total_points DESC
       LIMIT ?`,
      params
    );
    return { basic, count: rows.length, violations: rows };
  },
};

const queryDriverInspections = {
  definition: {
    name: 'query_driver_inspections',
    description: 'Lista inspecciones recientes de un driver (por nombre) con sus violaciones. Util para coaching y patrones.',
    input_schema: {
      type: 'object',
      properties: {
        driver_name: { type: 'string' },
        days: { type: 'integer', description: 'Ventana en dias. Default 365.', default: 365 },
      },
      required: ['driver_name'],
    },
  },
  handler: async ({ driver_name, days = 365 }) => {
    const rows = await db.query(
      `SELECT inspection_number, inspection_date, state, level, has_violation, has_oos, vehicle_vin
       FROM sms_inspections
       WHERE driver_name LIKE ? AND inspection_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY inspection_date DESC`,
      [`%${driver_name}%`, days]
    );
    return { driver_name, count: rows.length, inspections: rows };
  },
};

const queryDataQsCandidates = {
  definition: {
    name: 'query_dataqs_candidates',
    description: 'Lista crashes que NO han sido disputados via DataQs y que potencialmente podrian ser Not Preventable. Util para sweep de DataQs.',
    input_schema: { type: 'object', properties: {} },
  },
  handler: async () => {
    const rows = await db.query(
      `SELECT crash_number, crash_date, state, fatalities, injuries, tow_away, severity_weight, time_weight
       FROM sms_crashes
       WHERE dataqs_disputed = 0 AND (not_preventable IS NULL OR not_preventable = 0)
       ORDER BY crash_date DESC`
    );
    return {
      count: rows.length,
      crashes: rows,
      note: 'Cada crash debe ser revisado individualmente. DataQs no aplica si el preventability es claro.',
    };
  },
};

module.exports = {
  queryBasicsStatus,
  queryTopViolations,
  queryDriverInspections,
  queryDataQsCandidates,
};
