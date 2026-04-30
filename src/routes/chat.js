const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { chat, getOrCreateConversation, loadHistory } = require('../agent/claude');
const { checkBudget } = require('../utils/budget');
const { isInflight, markInflight, clearInflight } = require('../utils/inflight');
const {
  validateAttachments,
  sha256,
  MAX_FILES_PER_MESSAGE,
  MAX_BYTES_PER_FILE,
} = require('../utils/attachments');
const config = require('../config');
const db = require('../db/pool');

const router = express.Router();

router.use(authMiddleware);

// Rate limit por usuario sobre /send.
const sendRateLimit = config.chat.userRateLimitPerMin > 0
  ? rateLimit({
      windowMs: 60 * 1000,
      limit: config.chat.userRateLimitPerMin,
      keyGenerator: (req) => req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        error: `Demasiadas solicitudes. Espera unos segundos e intenta de nuevo.`,
      },
    })
  : (req, res, next) => next();

// Multer en memoria — los archivos van directo a Buffer y de ahi a base64
// para Claude. No tocamos disco. Los limites de aqui son la primera linea
// de defensa; validateAttachments hace la verificacion de tipo.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES_PER_FILE,
    files: MAX_FILES_PER_MESSAGE,
  },
});

// Listar conversaciones del usuario
router.get('/conversations', async (req, res) => {
  const rows = await db.query(
    `SELECT id, title, started_at, last_activity_at, message_count
     FROM conversations
     WHERE user_id = ?
     ORDER BY last_activity_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  res.json({ conversations: rows });
});

// Cargar mensajes de una conversacion
router.get('/conversations/:id/messages', async (req, res) => {
  const conv = await db.queryOne(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

  const rows = await db.query(
    `SELECT id, role, content_json, created_at
     FROM messages
     WHERE conversation_id = ?
     ORDER BY id ASC`,
    [req.params.id]
  );
  res.json({
    messages: rows.map(r => ({
      ...r,
      content: typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json,
    })),
  });
});

// Servir el blob de una attachment (para preview en el transcript). Solo
// el usuario duenno de la conversacion (o admin/compliance) lo puede ver.
router.get('/attachments/:id', async (req, res, next) => {
  try {
    const att = await db.queryOne(
      `SELECT a.id, a.user_id, a.mime_type, a.byte_size, a.content_blob, a.conversation_id, c.user_id AS conv_owner
       FROM message_attachments a
       JOIN conversations c ON c.id = a.conversation_id
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (!att) return res.status(404).json({ error: 'Adjunto no encontrado' });
    const isOwner = att.conv_owner === req.user.id;
    const isPrivileged = ['admin', 'compliance'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Length', att.byte_size);
    // no-store en lugar de private+max-age — un attachment puede contener
    // datos sensibles del compliance (screenshot de RODS, foto de DVIR, etc).
    // Si dos personas comparten una sesion del browser, el cache podia leakear.
    res.setHeader('Cache-Control', 'no-store');
    res.send(att.content_blob);
  } catch (e) { next(e); }
});

// Enviar mensaje al agente. Soporta multipart con campo "files" (0..N
// imagenes) y campo "message" / "conversation_id" como text fields.
router.post('/send', sendRateLimit, upload.array('files', MAX_FILES_PER_MESSAGE), async (req, res) => {
  const message = (req.body && req.body.message) || '';
  const conversation_id = req.body && req.body.conversation_id ? parseInt(req.body.conversation_id, 10) : null;
  const files = req.files || [];

  if ((!message || typeof message !== 'string') && files.length === 0) {
    return res.status(400).json({ error: 'Manda un texto, una imagen, o ambos.' });
  }

  // Validar attachments
  const v = validateAttachments(files);
  if (!v.ok) return res.status(400).json({ error: v.error });

  // Concurrency gate
  if (isInflight(req.user.id)) {
    return res.status(429).json({
      error: 'Ya tienes una solicitud en curso. Espera la respuesta antes de enviar otra.',
    });
  }

  // Budget gate
  let budget;
  try {
    budget = await checkBudget(req.user.id);
  } catch (err) {
    req.log.error({ err }, 'error consultando budget; fail-open');
    budget = { allowed: true };
  }
  if (!budget.allowed) {
    req.log.warn({
      event: 'budget_cap_hit',
      scope: budget.scope,
      user_spent_usd: budget.user_spent_usd,
      user_cap_usd: budget.user_cap_usd,
      org_spent_usd: budget.org_spent_usd,
      org_cap_usd: budget.org_cap_usd,
    }, 'budget cap hit');
    return res.status(429).json({
      error: 'Has alcanzado el limite de uso. Intenta mas tarde o contacta a un administrador si necesitas mas capacidad.',
    });
  }

  // Calcular sha256 de cada file antes de pasarselo a chat() — eso lo
  // necesita tanto chat (lo guarda en content_json) como el INSERT de
  // message_attachments.
  for (const f of files) f.sha256 = sha256(f.buffer);

  markInflight(req.user.id);
  try {
    const convId = await getOrCreateConversation(req.user.id, conversation_id, message.slice(0, 80) || `${files.length} imagen(es)`);

    const history = await loadHistory(convId);
    const result = await chat({
      user: req.user,
      conversationId: convId,
      userMessage: message,
      attachments: files,
      history: history.slice(0, -1),
    });

    // Persistir attachments DESPUES de chat() (que ya logueo el user
    // message y nos devolvio su id). Esto deja el message_id como FK valido.
    const attachmentRows = [];
    if (files.length > 0) {
      for (const f of files) {
        const ins = await db.query(
          `INSERT INTO message_attachments
             (message_id, conversation_id, user_id, mime_type, byte_size, sha256, storage_kind, content_blob)
           VALUES (?, ?, ?, ?, ?, ?, 'db', ?)`,
          [result.userMessageId, convId, req.user.id, f.mimetype, f.size, f.sha256, f.buffer]
        );
        attachmentRows.push({
          id: ins.insertId,
          mime_type: f.mimetype,
          byte_size: f.size,
          sha256: f.sha256,
          original_name: f.originalname,
        });
      }
    }

    res.json({
      conversation_id: convId,
      reply: result.text,
      iterations: result.iterations,
      tool_calls: result.toolCallsMade,
      attachments: attachmentRows,
    });
  } catch (e) {
    req.log.error({ err: e }, 'chat error');
    // Mapear errores comunes de la API de Anthropic a mensajes accionables.
    // El usuario nunca ve detalles tecnicos — pero diferenciar config vs
    // failure transitorio le ahorra horas de debugging al admin.
    if (e && e.status === 401) {
      return res.status(503).json({
        error: 'El servicio de IA no esta configurado correctamente. Contacta al administrador (ANTHROPIC_API_KEY invalida o no seteada).',
      });
    }
    if (e && e.status === 429) {
      return res.status(503).json({
        error: 'El servicio de IA esta saturado. Intenta de nuevo en unos segundos.',
      });
    }
    if (e && (e.status === 529 || e.status >= 500)) {
      return res.status(503).json({
        error: 'El servicio de IA esta temporalmente no disponible. Intenta de nuevo en unos minutos.',
      });
    }
    res.status(500).json({ error: 'Error procesando mensaje', detail: e.message });
  } finally {
    clearInflight(req.user.id);
  }
});

// Multer / Express error handler: convierte errores de tamano/cantidad de
// multer en 400 limpios (sino salen como 500 confusos).
router.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    let msg = err.message;
    if (err.code === 'LIMIT_FILE_SIZE') msg = `Una imagen excede el tamano maximo (${MAX_BYTES_PER_FILE / 1024 / 1024}MB).`;
    else if (err.code === 'LIMIT_FILE_COUNT') msg = `Maximo ${MAX_FILES_PER_MESSAGE} imagenes por mensaje.`;
    return res.status(400).json({ error: msg });
  }
  next(err);
});

module.exports = router;
