const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../db/pool');

const router = express.Router();
router.use(authMiddleware);

// BASICs scores y KPIs ejecutivos del carrier estan reservados a roles
// management — son metricas que un dispatcher no necesita para su trabajo
// diario y que la empresa tipicamente reserva a compliance/manager.
const requireManagement = requireRole('admin', 'compliance', 'manager');

// Snapshot mas reciente de BASICs
router.get('/basics', requireManagement, async (req, res) => {
  const rows = await db.query(
    `SELECT basic_name, score_pct, threshold_pct, alert, months_in_alert, violations_count
     FROM sms_snapshots
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM sms_snapshots)
     ORDER BY score_pct DESC`
  );
  res.json({ basics: rows });
});

// KPIs de header (basics_in_alert, dataqs_candidates, crashes_24m, overrides_30d)
router.get('/kpis', requireManagement, async (req, res) => {
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

// Audit log con filtros (compliance/manager/admin)
router.get('/audit', requireManagement, async (req, res) => {
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

// Drivers en riesgo por CDL o medical card expirations.
// Visible para CUALQUIER rol autenticado — un dispatcher tambien necesita
// saber si el driver que esta por asignar tiene problemas de compliance.
router.get('/drivers-at-risk', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 100);
    const horizonDays = Math.min(parseInt(req.query.horizon_days || '60', 10), 365);

    // Selecciona drivers cuyo CDL o medical card vencen dentro del horizonte
    // (o ya vencieron). Calcula dias restantes y la fecha mas proxima.
    const rows = await db.query(
      `SELECT
         id, samsara_id, full_name,
         cdl_number, cdl_state, cdl_expiration,
         medical_card_expiration,
         DATEDIFF(cdl_expiration, CURDATE())              AS cdl_days,
         DATEDIFF(medical_card_expiration, CURDATE())     AS medical_days
       FROM drivers
       WHERE active = 1
         AND (
           (cdl_expiration IS NOT NULL AND cdl_expiration <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
           OR
           (medical_card_expiration IS NOT NULL AND medical_card_expiration <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
         )
       ORDER BY LEAST(
         IFNULL(DATEDIFF(cdl_expiration, CURDATE()), 9999),
         IFNULL(DATEDIFF(medical_card_expiration, CURDATE()), 9999)
       ) ASC
       LIMIT ?`,
      [horizonDays, horizonDays, limit + 1]   // +1 para saber si hay mas
    );

    const hasMore = rows.length > limit;
    const drivers = rows.slice(0, limit).map(r => {
      // Decidir cual es la expiracion mas proxima (la critica)
      const cdlD = r.cdl_days != null ? r.cdl_days : Infinity;
      const medD = r.medical_days != null ? r.medical_days : Infinity;
      const soonestKind = cdlD <= medD ? 'cdl' : 'medical';
      const soonestDays = Math.min(cdlD, medD);
      return {
        id: r.id,
        samsara_id: r.samsara_id,
        full_name: r.full_name,
        cdl_number: r.cdl_number,
        cdl_expiration: r.cdl_expiration,
        cdl_days: r.cdl_days,
        medical_card_expiration: r.medical_card_expiration,
        medical_days: r.medical_days,
        soonest_kind: soonestKind,
        soonest_days: soonestDays === Infinity ? null : soonestDays,
      };
    });

    // Total al riesgo (sin limit) — para el "+ N mas"
    const [totalRow] = await db.query(
      `SELECT COUNT(*) AS n FROM drivers
       WHERE active = 1
         AND (
           (cdl_expiration IS NOT NULL AND cdl_expiration <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
           OR
           (medical_card_expiration IS NOT NULL AND medical_card_expiration <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
         )`,
      [horizonDays, horizonDays]
    );

    res.json({
      drivers,
      total_at_risk: totalRow.n,
      shown: drivers.length,
      has_more: hasMore,
      horizon_days: horizonDays,
    });
  } catch (e) { next(e); }
});

module.exports = router;
