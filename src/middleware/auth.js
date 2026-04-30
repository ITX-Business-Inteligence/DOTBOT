const jwt = require('jsonwebtoken');
const config = require('../config');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.full_name },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.auth.jwtSecret);
}

function authMiddleware(req, res, next) {
  // Solo aceptamos token via cookie httpOnly. Removimos Bearer header
  // intencionalmente: la app es 100% misma-origen y un cookie httpOnly
  // es mas seguro (no accesible a JS, immune a XSS-token-theft). Aceptar
  // Bearer ampliaba surface area sin uso real.
  const token = req.cookies?.botdot_token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = verifyToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      name: payload.name,
    };
    // Enriquecer el logger del request: a partir de aqui, cada req.log.*
    // dentro del request lleva user_id + role (defense in depth de audit).
    if (req.log && typeof req.log.child === 'function') {
      req.log = req.log.child({ user_id: req.user.id, role: req.user.role });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado para este recurso' });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, authMiddleware, requireRole };
