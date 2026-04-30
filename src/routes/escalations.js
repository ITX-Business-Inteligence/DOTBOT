// Endpoints para el dashboard de escalaciones.
// Acceso: compliance / manager / admin (los que pueden recibir y resolver
// escalaciones).

const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { appendAudit } = require('../db/audit-chain');
const db = require('../db/pool');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'compliance', 'manager'));

const VALID_STATUS = ['pending', 'assigned', 'in_progress', 'resolved'];

// Conteo para el badge en header. Solo cuenta no-resueltas.
router.get('/badge-count', async (req, res, next) => {
  try {
    const [row] = await db.query(
      `SELECT COUNT(*) AS n FROM escalations WHERE status != 'resolved'`
    );
    res.json({ count: row.n, ts: new Date().toISOString() });
  } catch (e) { next(e); }
});

// Listar — con filtros de status / urgency / search
router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status;
    const urgency = req.query.urgency;
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

    const where = [];
    const params = [];
    if (status && VALID_STATUS.includes(status)) {
      where.push('e.status = ?'); params.push(status);
    }
    if (urgency && ['low','medium','high','critical'].includes(urgency)) {
      where.push('e.urgency = ?'); params.push(urgency);
    }

    const sql =
      `SELECT e.*, u.full_name AS user_name, u.role AS user_role, u.email AS user_email,
              au.full_name AS assigned_name
       FROM escalations e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN users au ON au.id = e.assigned_to_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY
         CASE e.status
           WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1
           WHEN 'assigned' THEN 2 WHEN 'resolved' THEN 3
         END ASC,
         FIELD(e.urgency, 'critical', 'high', 'medium', 'low'),
         e.created_at DESC
       LIMIT ?`;
    params.push(limit);
    const rows = await db.query(sql, params);
    res.json({ escalations: rows });
  } catch (e) { next(e); }
});

// Asignar / actualizar status / resolver
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });

    const target = await db.queryOne(`SELECT * FROM escalations WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: 'No encontrada' });

    const { status, assigned_to_user_id, resolution_notes } = req.body || {};
    const updates = [];
    const params = [];
    if (status !== undefined) {
      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: `status invalido: ${status}` });
      }
      updates.push('status = ?'); params.push(status);
      if (status === 'resolved') {
        updates.push('resolved_at = CURRENT_TIMESTAMP');
        updates.push('resolved_by_user_id = ?'); params.push(req.user.id);
      }
    }
    if (assigned_to_user_id !== undefined) {
      if (assigned_to_user_id) {
        const u = await db.queryOne(
          `SELECT id FROM users WHERE id = ? AND role IN ('admin','compliance','manager')`,
          [assigned_to_user_id]
        );
        if (!u) return res.status(400).json({ error: 'Solo se puede asignar a admin/compliance/manager' });
      }
      updates.push('assigned_to_user_id = ?'); params.push(assigned_to_user_id || null);
      // Auto-promover de pending a assigned cuando se asigna
      if (assigned_to_user_id && target.status === 'pending') {
        updates.push("status = 'assigned'");
      }
    }
    if (resolution_notes !== undefined) {
      updates.push('resolution_notes = ?'); params.push(resolution_notes || null);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

    params.push(id);
    await db.query(`UPDATE escalations SET ${updates.join(', ')} WHERE id = ?`, params);

    await appendAudit({
      user_id: req.user.id,
      action_type: 'escalation_update',
      subject_type: 'escalation',
      subject_id: String(id),
      decision: 'informational',
      reasoning: `${req.user.email} actualizo escalacion #${id}`,
      evidence: { changes: req.body, before: target },
    });

    const updated = await db.queryOne(`SELECT * FROM escalations WHERE id = ?`, [id]);
    res.json({ escalation: updated });
  } catch (e) { next(e); }
});

module.exports = router;
