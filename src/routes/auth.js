const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('../db/pool');
const { signToken, authMiddleware } = require('../middleware/auth');
const { appendAudit } = require('../db/audit-chain');

const router = express.Router();

// Despues de N intentos fallidos consecutivos sobre la misma cuenta,
// la bloqueamos. Solo un admin puede desbloquearla desde /users.html.
const MAX_FAILED_LOGINS = 10;

// bcrypt cost factor — 12 es el minimum recomendado en 2026 para nuevos
// hashes (≈250ms en hardware moderno). bcrypt.compare funciona contra
// hashes de cualquier cost, asi que passwords viejas (cost 10) siguen
// validando hasta que el usuario cambie su password — momento en el cual
// se rehashea con BCRYPT_COST.
const BCRYPT_COST = 12;

// Rate limit IP-based como capa adicional. Mas permisivo que el lockout
// por-cuenta (que es la defensa primaria) — evita molestar a usuarios
// legitimos compartiendo IP de oficina.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos desde esta IP, espera 15 minutos.' },
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });

    const user = await db.queryOne(
      `SELECT id, email, full_name, password_hash, role, active,
              failed_login_count, locked_at, must_change_password
       FROM users WHERE email = ?`,
      [email.toLowerCase().trim()]
    );

    // Mensaje generico cuando no existe el usuario — evita leak de quien
    // existe / no existe en el sistema.
    if (!user) return res.status(401).json({ error: 'Credenciales invalidas' });

    if (user.locked_at) {
      // Contesta diferente para que el usuario sepa por que no entra y
      // contacte al admin. El attacker ya sabe que la cuenta existe; el
      // lockout es la defensa, no la ofuscacion.
      return res.status(423).json({
        error: 'Cuenta bloqueada por intentos fallidos. Contacta al administrador para desbloquearla.',
      });
    }
    if (!user.active) return res.status(401).json({ error: 'Credenciales invalidas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const newCount = user.failed_login_count + 1;
      const willLock = newCount >= MAX_FAILED_LOGINS;
      await db.query(
        `UPDATE users SET
           failed_login_count = ?,
           last_failed_login_at = CURRENT_TIMESTAMP,
           locked_at = ${willLock ? 'CURRENT_TIMESTAMP' : 'locked_at'}
         WHERE id = ?`,
        [newCount, user.id]
      );
      if (willLock) {
        // Audit: la cuenta se bloqueo. Importante para forensics.
        // Si appendAudit falla, NO swallow silently — log FATAL para que un
        // operador vea que la cadena de audit tuvo un problema. El 423
        // se devuelve igual (no es ofuscar al usuario), pero queda visible
        // que faltaria la fila en audit_log.
        try {
          await appendAudit({
            user_id: user.id,
            action_type: 'account_locked',
            subject_type: 'user',
            subject_id: String(user.id),
            decision: 'informational',
            reasoning: `Cuenta ${user.email} bloqueada tras ${MAX_FAILED_LOGINS} intentos fallidos consecutivos`,
            evidence: { trigger: 'failed_login_threshold', threshold: MAX_FAILED_LOGINS, ip: req.ip },
          });
        } catch (auditErr) {
          (req.log || console).error(
            { err: auditErr, event: 'audit_chain_failure', context: 'account_locked', user_id: user.id, email: user.email },
            'CRITICAL: audit chain INSERT fallo en account_locked — investigar inmediatamente'
          );
          // Tambien escribir directo a stderr para garantizar visibilidad
          // si el transport de pino esta caido o buffereando.
          process.stderr.write(
            `[CRITICAL audit] ${new Date().toISOString()} account_locked audit failed for user_id=${user.id}: ${auditErr.message}\n`
          );
        }
        return res.status(423).json({
          error: `Cuenta bloqueada tras ${MAX_FAILED_LOGINS} intentos fallidos. Contacta al administrador.`,
        });
      }
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    // Login OK — reset el counter
    await db.query(
      `UPDATE users SET
         failed_login_count = 0,
         last_failed_login_at = NULL,
         last_login_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [user.id]
    );

    const token = signToken(user);
    res.cookie('botdot_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',  // CSRF defense via SameSite — la app es 100% misma origen
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({
      user: { id: user.id, email: user.email, name: user.full_name, role: user.role },
      must_change_password: !!user.must_change_password,
    });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('botdot_token');
  res.json({ ok: true });
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    // Re-leemos must_change_password de DB porque el JWT no lo tiene.
    const row = await db.queryOne(
      `SELECT must_change_password FROM users WHERE id = ?`,
      [req.user.id]
    );
    res.json({
      user: { ...req.user, must_change_password: !!(row && row.must_change_password) },
    });
  } catch (e) { next(e); }
});

// Cambio de password por el propio usuario. Requerido despues de un
// admin-reset. Tambien lo puede usar cualquier usuario para rotar la suya.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, espera 15 minutos.' },
});

router.post('/change-password', authMiddleware, changePasswordLimiter, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password y new_password requeridos' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'La nueva password debe tener al menos 8 caracteres' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'La nueva password debe ser distinta a la actual' });
    }

    const row = await db.queryOne(
      `SELECT id, email, password_hash FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!row) return res.status(401).json({ error: 'Sesion invalida' });

    const ok = await bcrypt.compare(current_password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Password actual incorrecta' });

    const newHash = await bcrypt.hash(new_password, BCRYPT_COST);
    await db.query(
      `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`,
      [newHash, row.id]
    );

    await appendAudit({
      user_id: row.id,
      action_type: 'password_changed_by_user',
      subject_type: 'user',
      subject_id: String(row.id),
      decision: 'informational',
      reasoning: `${row.email} cambio su password (self-service)`,
      evidence: {},
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
