// Endpoints del dashboard de notifications (alertas proactivas de
// expiration). Acceso: compliance / manager / admin.

const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { appendAudit } = require('../db/audit-chain');
const db = require('../db/pool');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'compliance', 'manager'));

// Badge en header — solo cuenta active
router.get('/badge-count', async (req, res, next) => {
  try {
    const [row] = await db.query(
      `SELECT COUNT(*) AS n FROM notifications WHERE status = 'active'`
    );
    res.json({ count: row.n, ts: new Date().toISOString() });
  } catch (e) { next(e); }
});

// Listar — con filtros de status / urgency / kind
const VALID_NOTIF_STATUS = new Set(['active', 'dismissed', 'resolved']);
const VALID_NOTIF_URGENCY = new Set(['low', 'medium', 'high', 'critical']);
const VALID_NOTIF_KIND = new Set(['cdl_expiring', 'medical_expiring', 'cdl_expired', 'medical_expired']);

router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status;
    const urgency = req.query.urgency;
    const kind = req.query.kind;
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);

    // Validar que los filtros sean valores conocidos. Si vienen vacios pasan
    // como "sin filtro" (no se agregan al WHERE). Si vienen invalidos, 400.
    if (status && !VALID_NOTIF_STATUS.has(status)) {
      return res.status(400).json({ error: `status invalido. Validos: ${[...VALID_NOTIF_STATUS].join(', ')}` });
    }
    if (urgency && !VALID_NOTIF_URGENCY.has(urgency)) {
      return res.status(400).json({ error: `urgency invalido. Validos: ${[...VALID_NOTIF_URGENCY].join(', ')}` });
    }
    if (kind && !VALID_NOTIF_KIND.has(kind)) {
      return res.status(400).json({ error: `kind invalido. Validos: ${[...VALID_NOTIF_KIND].join(', ')}` });
    }

    const where = [];
    const params = [];
    if (status)  { where.push('n.status = ?');  params.push(status); }
    if (urgency) { where.push('n.urgency = ?'); params.push(urgency); }
    if (kind)    { where.push('n.kind = ?');    params.push(kind); }

    const sql =
      `SELECT n.*,
              d.full_name AS driver_name,
              d.cdl_number, d.cdl_state, d.cdl_expiration,
              d.medical_card_expiration, d.location, d.company,
              dis.full_name AS dismissed_by_name
       FROM notifications n
       LEFT JOIN drivers d ON d.id = n.subject_id AND n.subject_type = 'driver'
       LEFT JOIN users dis ON dis.id = n.dismissed_by_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY
         CASE n.status
           WHEN 'active' THEN 0 WHEN 'dismissed' THEN 1 WHEN 'resolved' THEN 2
         END ASC,
         FIELD(n.urgency, 'critical', 'high', 'medium', 'low'),
         n.threshold ASC,
         n.created_at DESC
       LIMIT ?`;
    params.push(limit);

    const rows = await db.query(sql, params);
    res.json({ notifications: rows });
  } catch (e) { next(e); }
});

// Dismiss — marcar como atendida con nota
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });
    const note = (req.body && req.body.note) || null;

    const target = await db.queryOne(`SELECT * FROM notifications WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: 'Notificacion no encontrada' });
    if (target.status !== 'active') return res.status(400).json({ error: 'Notificacion ya no esta activa' });

    await db.query(
      `UPDATE notifications
       SET status = 'dismissed',
           dismissed_at = CURRENT_TIMESTAMP,
           dismissed_by_user_id = ?,
           dismissal_note = ?
       WHERE id = ?`,
      [req.user.id, note, id]
    );

    await appendAudit({
      user_id: req.user.id,
      action_type: 'notification_dismissed',
      subject_type: 'notification',
      subject_id: String(id),
      decision: 'informational',
      reasoning: `${req.user.email} dismissed notification ${target.kind} para subject_id=${target.subject_id}`,
      evidence: { note, before: { status: target.status } },
    });

    res.json({ dismissed: true });
  } catch (e) { next(e); }
});

// Trigger manual del job — admin only. Util para testing y forzar un
// re-scan despues de actualizar drivers.
router.post('/run-job', requireRole('admin'), async (req, res, next) => {
  try {
    const { runExpirationAlerts } = require('../jobs/expiration-alerts');
    const result = await runExpirationAlerts();
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
