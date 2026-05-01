// Endpoints de administracion: ABM de usuarios.
// Acceso: SOLO admin. Cada mutacion se registra en audit_log.

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { appendAudit } = require('../db/audit-chain');
const db = require('../db/pool');

const router = express.Router();
router.use(authMiddleware);

// Helpers de gating. Aplicamos por-ruta porque el router mezcla admin-only
// (gestion de usuarios, sync) con admin/compliance (drivers + import) y
// admin/compliance/manager (CFR audit). Un router.use(requireRole('admin'))
// global bloqueaba a compliance de los endpoints que el codigo per-ruta
// pretendia abrir.
const requireAdmin = requireRole('admin');
const requireAdminOrCompliance = requireRole('admin', 'compliance');
const requireMgmt = requireRole('admin', 'compliance', 'manager');

const VALID_ROLES = ['dispatcher', 'supervisor', 'compliance', 'manager', 'admin'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

// Genera una password de ~12 chars con un caracter especial al final.
// Formato pensado para que sea facil de leer/dictar al usuario, pero
// suficientemente fuerte para uso interno.
function generatePassword() {
  const base = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '');
  return base.slice(0, 11) + '!';
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    active: !!row.active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    locked_at: row.locked_at,
    failed_login_count: row.failed_login_count || 0,
    must_change_password: !!row.must_change_password,
  };
}

// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT id, email, full_name, role, active, last_login_at, created_at,
              locked_at, failed_login_count, must_change_password
       FROM users
       ORDER BY active DESC, role ASC, full_name ASC`
    );
    res.json({ users: rows.map(sanitizeUser) });
  } catch (e) { next(e); }
});

// POST /api/admin/users { email, full_name, password, role }
router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const { email, full_name, password, role } = req.body || {};
    if (!email || !full_name || !password || !role) {
      return res.status(400).json({ error: 'email, full_name, password y role son requeridos' });
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'email invalido' });
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role invalido. Validos: ${VALID_ROLES.join(', ')}` });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `password debe tener al menos ${MIN_PASSWORD_LEN} caracteres` });
    }

    const hash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = await db.query(
        `INSERT INTO users (email, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)`,
        [email, full_name, hash, role]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: `Ya existe un usuario con email ${email}` });
      }
      throw e;
    }

    await appendAudit({
      user_id: req.user.id,
      action_type: 'user_management',
      subject_type: 'user',
      subject_id: String(result.insertId),
      decision: 'informational',
      reasoning: `Admin ${req.user.email} creo usuario ${email} con rol ${role}`,
      evidence: { action: 'create', email, full_name, role },
    });

    const created = await db.queryOne(
      `SELECT id, email, full_name, role, active, last_login_at, created_at FROM users WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ user: sanitizeUser(created) });
  } catch (e) { next(e); }
});

// PATCH /api/admin/users/:id { full_name?, email?, role?, active? }
// (password se cambia en endpoint dedicado abajo)
router.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });

    const target = await db.queryOne(`SELECT id, email, role, active FROM users WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { full_name, email, role, active } = req.body || {};

    // Self-protection: no podes cambiarte tu propio rol ni desactivarte
    if (id === req.user.id) {
      if (role && role !== target.role) {
        return res.status(400).json({ error: 'No puedes cambiar tu propio rol. Pide a otro admin.' });
      }
      if (active === false || active === 0) {
        return res.status(400).json({ error: 'No puedes desactivar tu propio usuario.' });
      }
    }

    // Last admin protection: no podes degradar/desactivar al ultimo admin activo
    const willLoseAdmin =
      (role !== undefined && role !== 'admin' && target.role === 'admin') ||
      ((active === false || active === 0) && target.role === 'admin' && target.active);
    if (willLoseAdmin) {
      const [adminCount] = await db.query(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`,
        [id]
      );
      if (adminCount.n === 0) {
        return res.status(400).json({ error: 'No puedes degradar/desactivar al ultimo admin activo.' });
      }
    }

    const updates = [];
    const params = [];
    if (full_name !== undefined) { updates.push('full_name = ?'); params.push(full_name); }
    if (email !== undefined) {
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'email invalido' });
      updates.push('email = ?'); params.push(email);
    }
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'role invalido' });
      updates.push('role = ?'); params.push(role);
    }
    if (active !== undefined) {
      updates.push('active = ?'); params.push(active ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

    params.push(id);
    try {
      await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
      }
      throw e;
    }

    await appendAudit({
      user_id: req.user.id,
      action_type: 'user_management',
      subject_type: 'user',
      subject_id: String(id),
      decision: 'informational',
      reasoning: `Admin ${req.user.email} edito usuario id=${id} (${target.email})`,
      evidence: { action: 'update', changes: req.body, before: target },
    });

    const updated = await db.queryOne(
      `SELECT id, email, full_name, role, active, last_login_at, created_at FROM users WHERE id = ?`,
      [id]
    );
    res.json({ user: sanitizeUser(updated) });
  } catch (e) { next(e); }
});

// POST /api/admin/users/:id/reset-password { password? }
// Si no se manda password, se genera una random. Se devuelve en plain text
// UNA SOLA VEZ para que admin la comparta con el usuario por canal seguro.
router.post('/users/:id/reset-password', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });

    const target = await db.queryOne(`SELECT id, email FROM users WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { password } = req.body || {};
    let newPassword;
    if (password) {
      if (password.length < MIN_PASSWORD_LEN) {
        return res.status(400).json({ error: `password debe tener al menos ${MIN_PASSWORD_LEN} caracteres` });
      }
      newPassword = password;
    } else {
      newPassword = generatePassword();
    }

    const hash = await bcrypt.hash(newPassword, 12);
    // Reset tambien:
    //   - desbloquea la cuenta (locked_at = NULL, contador = 0)
    //   - fuerza al usuario a cambiar la password en el proximo login
    await db.query(
      `UPDATE users SET
         password_hash = ?,
         must_change_password = 1,
         locked_at = NULL,
         failed_login_count = 0
       WHERE id = ?`,
      [hash, id]
    );

    await appendAudit({
      user_id: req.user.id,
      action_type: 'user_management',
      subject_type: 'user',
      subject_id: String(id),
      decision: 'informational',
      reasoning: `Admin ${req.user.email} hizo password reset a usuario id=${id} (${target.email})`,
      evidence: { action: 'password_reset', generated: !password },
    });

    res.json({
      password: newPassword,
      hint: 'Compartelo por canal seguro. El usuario debera cambiarla en su proximo login.',
    });
  } catch (e) { next(e); }
});

// Desbloquear cuenta tras un lockout por intentos fallidos. Solo admin.
router.post('/users/:id/unlock', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });

    const target = await db.queryOne(`SELECT id, email, locked_at FROM users WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!target.locked_at) return res.status(400).json({ error: 'La cuenta no esta bloqueada' });

    await db.query(
      `UPDATE users SET locked_at = NULL, failed_login_count = 0 WHERE id = ?`,
      [id]
    );

    await appendAudit({
      user_id: req.user.id,
      action_type: 'user_management',
      subject_type: 'user',
      subject_id: String(id),
      decision: 'informational',
      reasoning: `Admin ${req.user.email} desbloqueo cuenta de ${target.email}`,
      evidence: { action: 'unlock', was_locked_at: target.locked_at },
    });

    res.json({ unlocked: true });
  } catch (e) { next(e); }
});

// Borrado fisico no — los users se referencian desde conversations,
// audit_log, message_attachments. La forma correcta de "borrar" es
// PATCH active=0.
router.delete('/users/:id', requireAdmin, (req, res) => {
  res.status(405).json({
    error: 'Borrado fisico no permitido. Usa PATCH con active=false para desactivar el usuario.',
  });
});

// ─── Drivers (lista, edit individual, import Excel) ────────────
// requireAdminOrCompliance se define al inicio del router.

const multer = require('multer');
const fs = require('fs');
const path = require('path');
// Hardening:
//   1. fileFilter — solo aceptar xlsx/xls/csv (no .exe, .html, etc).
//   2. Sanitizar originalname — sacar path traversal y caracteres raros
//      antes de armar el filename de disco.
//   3. fileSize cap = 20MB.
//
// Cleanup del archivo despues del proceso esta en el handler (success +
// error paths). Si por bug no se borra, no es leak — la carpeta no se
// sirve estatica y solo admin/compliance puede listarla.
const ALLOWED_IMPORT_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',  // .xlsx
  'application/vnd.ms-excel',                                            // .xls (legacy)
  'text/csv',
  'application/csv',
]);
const ALLOWED_IMPORT_EXT = new Set(['.xlsx', '.xls', '.csv']);

function sanitizeImportFilename(originalname) {
  // path.basename: previene `../` y rutas absolutas (Linux + Windows).
  // replace: solo permitimos alfanumerico, dot, dash, underscore.
  const base = path.basename(String(originalname || 'upload'));
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'upload';
}

const driverImportUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', '..', 'data', 'imports'),
    filename: (req, file, cb) => cb(null, `import_${Date.now()}_${sanitizeImportFilename(file.originalname)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const mimeOk = ALLOWED_IMPORT_MIME.has(file.mimetype);
    const extOk = ALLOWED_IMPORT_EXT.has(ext);
    // Aceptar si MIME O extension coinciden — algunos browsers mandan
    // application/octet-stream para .xlsx, igual lo dejamos pasar si la
    // extension es valida. exceljs rechaza despues si el contenido no es
    // un xlsx real.
    if (mimeOk || extOk) return cb(null, true);
    cb(new Error(`Tipo de archivo no permitido: ${file.mimetype} (${ext}). Solo .xlsx, .xls o .csv.`));
  },
});

const { runImport } = require('../utils/import-drivers');

router.get('/drivers', requireAdminOrCompliance, async (req, res, next) => {
  try {
    const showAll = req.query.show === 'all';
    const where = showAll ? '' : 'WHERE active = 1';
    const rows = await db.query(
      `SELECT id, samsara_id, full_name, cdl_number, cdl_state, cdl_expiration,
              medical_card_expiration, endorsements, phone, hire_date,
              company, location, division, active, data_source, match_confidence, last_synced_at,
              DATEDIFF(cdl_expiration, CURDATE()) AS cdl_days,
              DATEDIFF(medical_card_expiration, CURDATE()) AS medical_days
       FROM drivers ${where}
       ORDER BY active DESC, full_name ASC
       LIMIT 2000`
    );
    res.json({ drivers: rows });
  } catch (e) { next(e); }
});

// Length caps por campo. Match contra el schema de drivers (varchar/text)
// — defensa contra payloads enormes que llenen DB innecesariamente.
const DRIVER_FIELD_MAX = {
  cdl_number: 32,
  cdl_state: 64,         // NOT NULL widened en migration 005
  endorsements: 64,
  phone: 32,
  company: 128,
  location: 128,
  division: 128,
  notes: 4000,           // text con cap razonable
};

router.patch('/drivers/:id', requireAdminOrCompliance, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });
    const target = await db.queryOne(`SELECT * FROM drivers WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: 'Driver no encontrado' });

    const allowed = ['cdl_number', 'cdl_state', 'cdl_expiration', 'medical_card_expiration',
                     'endorsements', 'phone', 'hire_date', 'company', 'location', 'division',
                     'notes', 'active'];
    const updates = [];
    const params = [];
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        let v = req.body[k];
        // Validar length caps en strings
        if (DRIVER_FIELD_MAX[k] !== undefined && typeof v === 'string' && v.length > DRIVER_FIELD_MAX[k]) {
          return res.status(400).json({ error: `${k} excede ${DRIVER_FIELD_MAX[k]} caracteres` });
        }
        // Validar fechas con regex basico — mysql tira error oscuro si vienen mal
        if ((k === 'cdl_expiration' || k === 'medical_card_expiration' || k === 'hire_date')
            && v != null && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
          return res.status(400).json({ error: `${k} debe ser YYYY-MM-DD` });
        }
        updates.push(`${k} = ?`);
        params.push(k === 'active' ? (v ? 1 : 0) : (v === '' ? null : v));
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

    // Si el editor toca compliance fields, marcar data_source con 'manual'
    // para que la siguiente import no pisotee la edicion.
    const touchedCompliance = updates.some(u =>
      /cdl_|medical_card_|endorsements|phone|hire_date|company|location|division|notes/.test(u)
    );
    if (touchedCompliance) {
      const newSrc = target.data_source === 'samsara' ? 'samsara+excel' : 'manual';
      updates.push('data_source = ?');
      params.push(newSrc);
      // Admin/compliance edito a mano → confirma la vinculacion. Bumpear
      // confidence a 'manual' para que el badge de warning desaparezca.
      updates.push('match_confidence = ?');
      params.push('manual');
    }
    params.push(id);

    await db.query(`UPDATE drivers SET ${updates.join(', ')} WHERE id = ?`, params);

    const { appendAudit } = require('../db/audit-chain');
    await appendAudit({
      user_id: req.user.id,
      action_type: 'driver_management',
      subject_type: 'driver',
      subject_id: String(id),
      decision: 'informational',
      reasoning: `${req.user.email} edito driver ${target.full_name} (id=${id})`,
      evidence: { changes: req.body, before: target },
    });

    const updated = await db.queryOne(`SELECT * FROM drivers WHERE id = ?`, [id]);
    res.json({ driver: updated });
  } catch (e) { next(e); }
});

// POST /api/admin/drivers/import — multipart con campo "file" (xlsx).
//   ?dry=1 → preview sin commit (default)
//   ?commit=1 → ejecuta el upsert + popula discrepancies
router.post(
  '/drivers/import',
  requireAdminOrCompliance,
  driverImportUpload.single('file'),
  async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo (campo "file")' });
    const filePath = req.file.path;
    try {
      const commit = req.query.commit === '1';
      const result = await runImport(filePath, { commit, importedByUserId: req.user.id });

      if (commit) {
        const { appendAudit } = require('../db/audit-chain');
        await appendAudit({
          user_id: req.user.id,
          action_type: 'driver_management',
          subject_type: 'import_batch',
          subject_id: result.summary.batch_id || 'unknown',
          decision: 'informational',
          reasoning: `${req.user.email} importo Excel: ${result.matches_count} updates, ${result.excel_only_count + result.samsara_only_count} discrepancies`,
          evidence: { summary: result.summary, filename: req.file.originalname },
        });
      }
      // Cleanup SIEMPRE — dry-run o commit, success o error. Una vez que
      // las discrepancies y los UPDATE estan en DB no necesitamos el xlsx.
      fs.unlink(filePath, () => {});
      res.json(result);
    } catch (err) {
      req.log.error({ err, filename: req.file?.originalname }, 'driver import failed');
      fs.unlink(filePath, () => {});
      res.status(500).json({ error: err.message || 'Error procesando el Excel' });
    }
  }
);

// Error handler local para multer en /drivers/import — convierte errores
// de multer (size/count/fileFilter) en 400 limpios.
router.use('/drivers/import', (err, req, res, next) => {
  if (err && (err.name === 'MulterError' || /Tipo de archivo no permitido/.test(err.message))) {
    let msg = err.message;
    if (err.code === 'LIMIT_FILE_SIZE') msg = `El archivo excede 20MB.`;
    return res.status(400).json({ error: msg });
  }
  next(err);
});

router.get('/drivers/discrepancies', requireAdminOrCompliance, async (req, res, next) => {
  try {
    const source = req.query.source;  // 'excel_only' | 'samsara_only' | undefined
    const includeResolved = req.query.resolved === '1';
    const where = [];
    const params = [];
    if (source) { where.push('source = ?'); params.push(source); }
    if (!includeResolved) where.push('resolved_at IS NULL');
    const sql = `SELECT * FROM driver_import_discrepancies
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT 500`;
    const rows = await db.query(sql, params);
    res.json({ discrepancies: rows });
  } catch (e) { next(e); }
});

router.post('/drivers/discrepancies/:id/resolve', requireAdminOrCompliance, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const note = (req.body && req.body.note) || null;
    const result = await db.query(
      `UPDATE driver_import_discrepancies
       SET resolved_at = CURRENT_TIMESTAMP,
           resolved_by_user_id = ?,
           resolution_note = ?
       WHERE id = ? AND resolved_at IS NULL`,
      [req.user.id, note, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Discrepancia no encontrada o ya resuelta' });
    }
    res.json({ resolved: true });
  } catch (e) { next(e); }
});

// ─── Sync de Samsara ───────────────────────────────────────────
// GET /api/admin/sync/status — ultimas N corridas de cada resource.
router.get('/sync/status', requireAdmin, async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT id, resource, started_at, finished_at, status, records_synced,
              duration_ms, source, LEFT(error_message, 200) AS error_message
       FROM sync_runs
       ORDER BY id DESC
       LIMIT 30`
    );
    // Tambien metricas: ultima corrida exitosa por resource
    const lastSuccess = await db.query(
      `SELECT resource, MAX(finished_at) AS last_success_at
       FROM sync_runs WHERE status = 'success' GROUP BY resource`
    );
    res.json({ runs: rows, last_success: lastSuccess });
  } catch (e) { next(e); }
});

// ─── CFR auto-update ───────────────────────────────────────────
// Ver historial de fetch runs (admin/compliance/manager)
router.get('/cfr/runs', requireRole('admin', 'compliance', 'manager'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 200);
    const rows = await db.query(
      `SELECT id, started_at, finished_at, issue_date, status, trigger_source,
              parts_fetched, sections_total, sections_added, sections_changed,
              sections_unchanged, duration_ms, email_sent_at,
              LEFT(error_message, 300) AS error_message
       FROM cfr_fetch_runs
       ORDER BY started_at DESC
       LIMIT ?`,
      [limit]
    );
    // Resumen: ultima corrida exitosa, total secciones vigentes
    const [last] = await db.query(
      `SELECT MAX(started_at) AS last_started, MAX(issue_date) AS last_issue_date
       FROM cfr_fetch_runs WHERE status IN ('success','noop')`
    );
    const [count] = await db.query(
      `SELECT COUNT(*) AS n FROM cfr_versions WHERE is_current = 1`
    );
    res.json({
      runs: rows,
      last_run: last,
      sections_current: count.n,
    });
  } catch (e) { next(e); }
});

// Historial de versiones de una seccion (audit trail)
router.get('/cfr/versions/:section', requireRole('admin', 'compliance', 'manager'), async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT id, section, part, title, content_hash, issue_date,
              fetched_at, is_current, superseded_at,
              LEFT(text, 200) AS text_excerpt
       FROM cfr_versions
       WHERE section = ?
       ORDER BY fetched_at DESC`,
      [req.params.section]
    );
    res.json({ section: req.params.section, versions: rows });
  } catch (e) { next(e); }
});

// Forzar un run ad-hoc (admin only)
router.post('/cfr/run', requireRole('admin'), async (req, res, next) => {
  try {
    const { runCfrUpdate } = require('../jobs/cfr-update');
    const r = await runCfrUpdate({ trigger: 'manual' });
    res.json(r);
  } catch (e) { next(e); }
});

// POST /api/admin/sync/run/:resource — fuerza una corrida ad-hoc.
// Util para testing y para cuando vos sabes que algo cambio en Samsara
// y queres reflejarlo sin esperar al siguiente tick del scheduler.
router.post('/sync/run/:resource', requireAdmin, async (req, res, next) => {
  try {
    const handlers = {
      drivers: () => require('../sync/drivers').syncDrivers(),
      vehicles: () => require('../sync/vehicles').syncVehicles(),
      hos_clocks: () => require('../sync/hos').syncHosClocks(),
    };
    const fn = handlers[req.params.resource];
    if (!fn) {
      return res.status(400).json({
        error: `Resource invalido. Usa: ${Object.keys(handlers).join(', ')}`,
      });
    }
    const result = await fn();
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
