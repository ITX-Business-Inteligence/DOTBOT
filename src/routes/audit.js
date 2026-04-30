// Endpoints de integridad del audit_log.
// Acceso: solo admin / compliance — la verificacion es lo unico que prueba
// que la cadena no fue manipulada, no debe estar abierto al resto.

const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { verifyChain, getChainHead } = require('../db/audit-chain');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'compliance'));

// GET /api/audit/head — devuelve el row_hash mas reciente.
// Util para anclaje externo (p.ej. cron diario que copia el head a S3).
router.get('/head', async (req, res, next) => {
  try {
    const head = await getChainHead();
    res.json(head);
  } catch (e) { next(e); }
});

// GET /api/audit/verify — verifica un rango de la cadena.
//
// Sin parametros: verifica las ultimas MAX_ROWS_PER_REQUEST (1000) filas.
// Con ?from=<id>&to=<id>: verifica ese rango exacto, capeado a MAX_ROWS_PER_REQUEST.
// Con ?full=1: ignora el cap (uso forensic, puede ser caro). Solo admin.
//
// El cap previene que un solo request escanee 50k+ filas con 50k+ SHA-256
// (DoS interno). Para verificacion completa usar el script offline:
//   node scripts/verify-audit-chain.js
const MAX_ROWS_PER_REQUEST = 1000;

router.get('/verify', async (req, res, next) => {
  try {
    let from = req.query.from ? parseInt(req.query.from, 10) : null;
    let to = req.query.to ? parseInt(req.query.to, 10) : null;
    const full = req.query.full === '1';
    if (from !== null && Number.isNaN(from)) {
      return res.status(400).json({ error: 'from debe ser entero' });
    }
    if (to !== null && Number.isNaN(to)) {
      return res.status(400).json({ error: 'to debe ser entero' });
    }
    if (full && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'full=1 requiere rol admin' });
    }
    // Si no hay rango y no es full, capear a las ultimas MAX_ROWS filas.
    let capped = false;
    if (!full && from === null && to === null) {
      const head = await getChainHead();
      if (head.audit_id !== null && head.audit_id > MAX_ROWS_PER_REQUEST) {
        from = head.audit_id - MAX_ROWS_PER_REQUEST + 1;
        to = head.audit_id;
        capped = true;
      }
    } else if (!full && from !== null && to !== null && (to - from + 1) > MAX_ROWS_PER_REQUEST) {
      return res.status(400).json({
        error: `Rango excede ${MAX_ROWS_PER_REQUEST} filas. Usa rangos mas chicos o ?full=1 (admin).`,
      });
    }
    const result = await verifyChain({ from, to });
    if (capped) result.range_capped = true;
    res.status(result.intact ? 200 : 409).json(result);
  } catch (e) { next(e); }
});

module.exports = router;
