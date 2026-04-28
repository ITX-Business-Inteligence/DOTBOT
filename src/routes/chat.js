const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { chat, getOrCreateConversation, loadHistory } = require('../agent/claude');
const db = require('../db/pool');

const router = express.Router();

router.use(authMiddleware);

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

// Enviar mensaje al agente
router.post('/send', async (req, res) => {
  const { conversation_id, message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requerido (string)' });
  }

  try {
    const convId = await getOrCreateConversation(req.user.id, conversation_id, message.slice(0, 80));
    const history = await loadHistory(convId);
    const result = await chat({
      user: req.user,
      conversationId: convId,
      userMessage: message,
      history: history.slice(0, -1), // history ya incluye el mensaje actual si lo agregamos despues; eliminarlo aqui
    });
    res.json({
      conversation_id: convId,
      reply: result.text,
      iterations: result.iterations,
      tool_calls: result.toolCallsMade,
    });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: 'Error procesando mensaje', detail: e.message });
  }
});

module.exports = router;
