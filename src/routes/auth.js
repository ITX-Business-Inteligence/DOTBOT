const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('../db/pool');
const { signToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos, espera 15 minutos.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });

  const user = await db.queryOne(
    'SELECT id, email, full_name, password_hash, role, active FROM users WHERE email = ?',
    [email.toLowerCase().trim()]
  );
  if (!user || !user.active) return res.status(401).json({ error: 'Credenciales invalidas' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciales invalidas' });

  await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

  const token = signToken(user);
  res.cookie('botdot_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({
    user: { id: user.id, email: user.email, name: user.full_name, role: user.role },
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('botdot_token');
  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
