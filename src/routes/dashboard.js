const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../db/pool');

const router = express.Router();
router.use(authMiddleware);

// Snapshot mas reciente de BASICs
router.get('/basics', async (req, res) => {
  const rows = await db.query(
    `SELECT basic_name, score_pct, threshold_pct, alert, months_in_alert, violations_count
     FROM sms_snapshots
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots)
     ORDER BY score_pct DESC`
  );
  res.json({ basics: rows });
});

// KPIs de header
router.get('/kpis', async (req, res) => {
  const [basicAlertRow] = await db.query(
    `SELECT COUNT(*) AS cnt FROM sms_snapshots
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots)
     AND alert = 1`
  );
  const [crashRow] = await db.query(
    `SELECT COUNT(*) AS cnt FROM sms_crashes WHERE crash_date >= DATE_SUB(CURDATE(), INTERVAL 24 MONTH)`
  );
  const [dataqsRow] = await db.query(
    `SELECT COUNT(*) AS cnt FROM sms_crashes WHERE dataqs_disputed = 0 AND (not_preventable IS NULL OR not_preventable = 0)`
  );
  const [overridesRow] = await db.query(
    `SELECT COUNT(*) AS cnt FROM audit_log WHERE decision = 'override' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
  );
  res.json({
    basics_in_alert: basicAlertRow?.cnt ?? null,
    crashes_24m: crashRow?.cnt ?? null,
    dataqs_candidates: dataqsRow?.cnt ?? null,
    overrides_30d: overridesRow?.cnt ?? null,
  });
});

// Audit log con filtros (compliance/manager)
router.get('/audit', async (req, res) => {
  if (!['compliance', 'manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const rows = await db.query(
    `SELECT a.id, a.action_type, a.subject_type, a.subject_id, a.decision, a.cfr_cited,
            a.reasoning, a.created_at, u.full_name AS user_name, u.role AS user_role
     FROM audit_log a JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT ?`,
    [limit]
  );
  res.json({ entries: rows });
});

// Drivers cerca de limite (proxy a tool, simplificado para dashboard)
router.get('/drivers-near-limit', async (req, res) => {
  // Para MVP: lista vacia hasta que sync de Samsara este corriendo.
  // Cuando Samsara este integrado, el dashboard llama directo o usa un job background.
  res.json({ drivers: [], note: 'Pendiente integracion Samsara live' });
});

module.exports = router;
