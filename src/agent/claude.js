const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');
const { buildSystemPrompt } = require('./system-prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');
const { buildContentBlocks } = require('../utils/attachments');
const { MockClaude } = require('./mock-llm');
const db = require('../db/pool');

// Si BOTDOT_MOCK_LLM=true, usamos el mock que emula la API de Anthropic
// localmente — util cuando todavia no hay ANTHROPIC_API_KEY real, para
// validar UI flow, audit log, multipart, etc. Ver src/agent/mock-llm.js.
const client = config.anthropic.mock
  ? (logger.warn('[BOTDOT] MOCK LLM ACTIVO — las respuestas son simuladas, no llaman a Claude real.'),
     new MockClaude())
  : new Anthropic({ apiKey: config.anthropic.apiKey });

const MAX_TOOL_ITERATIONS = 8;

async function logMessage(conversationId, role, contentJson, usage = {}, latencyMs = null) {
  const result = await db.query(
    `INSERT INTO messages (conversation_id, role, content_json, tokens_input, tokens_output, tokens_cache_read, tokens_cache_create, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      conversationId,
      role,
      JSON.stringify(contentJson),
      usage.input_tokens || null,
      usage.output_tokens || null,
      usage.cache_read_input_tokens || null,
      usage.cache_creation_input_tokens || null,
      latencyMs,
    ]
  );
  await db.query(
    `UPDATE conversations SET last_activity_at = CURRENT_TIMESTAMP, message_count = message_count + 1 WHERE id = ?`,
    [conversationId]
  );
  return result.insertId;
}

/**
 * Ejecuta un turn del agente.
 *
 * @param {Object} opts
 * @param {Object} opts.user                 - { id, role, name, email }
 * @param {number} opts.conversationId
 * @param {string} opts.userMessage          - texto del usuario
 * @param {Array}  [opts.attachments=[]]     - archivos de multer ({mimetype,buffer,size,sha256,originalname})
 * @param {Array}  [opts.history=[]]         - mensajes previos en formato Anthropic
 *
 * Devuelve { text, iterations, toolCallsMade, history, userMessageId }.
 * El caller usa userMessageId para linkear filas en message_attachments.
 */
async function chat({ user, conversationId, userMessage, attachments = [], history = [] }) {
  const systemPrompt = buildSystemPrompt(user);

  // Anthropic content[] del turn actual: imagenes + texto.
  // Si no hay imagenes, dejamos el content como string (back-compat con
  // historial existente).
  const hasImages = attachments && attachments.length > 0;
  const userContentForApi = hasImages
    ? buildContentBlocks(userMessage, attachments)
    : userMessage;

  const messages = [
    ...history,
    { role: 'user', content: userContentForApi },
  ];

  // En DB guardamos solo metadata liviana de los adjuntos, no los bytes.
  // Los bytes viven en message_attachments.content_blob. El sha256 sirve
  // de puente.
  const userContentForLog = {
    text: userMessage,
    attachments: attachments.map(a => ({
      sha256: a.sha256,
      mime_type: a.mimetype,
      byte_size: a.size,
      original_name: a.originalname,
    })),
  };
  const userMessageId = await logMessage(conversationId, 'user', userContentForLog);

  let iterations = 0;
  let finalText = '';
  const toolCallsMade = [];

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const t0 = Date.now();

    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const latency = Date.now() - t0;
    await logMessage(conversationId, 'assistant', response.content, response.usage, latency);

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const tu of toolUseBlocks) {
        toolCallsMade.push({ name: tu.name, input: tu.input });
        try {
          const result = await executeTool(tu.name, tu.input, { user, conversationId });
          await logMessage(conversationId, 'tool_use', { name: tu.name, input: tu.input, result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        } catch (e) {
          await logMessage(conversationId, 'tool_use', { name: tu.name, input: tu.input, error: e.message });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ error: e.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    finalText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    messages.push({ role: 'assistant', content: response.content });
    break;
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    finalText += '\n\n[Aviso: limite de iteraciones de herramientas alcanzado. Si la respuesta esta incompleta, refina tu pregunta.]';
  }

  return {
    text: finalText,
    iterations,
    toolCallsMade,
    history: messages,
    userMessageId,
  };
}

async function getOrCreateConversation(userId, conversationId, title = null) {
  if (conversationId) {
    const conv = await db.queryOne(
      `SELECT id, user_id FROM conversations WHERE id = ? AND user_id = ?`,
      [conversationId, userId]
    );
    if (conv) return conv.id;
  }
  const result = await db.query(
    `INSERT INTO conversations (user_id, title) VALUES (?, ?)`,
    [userId, title || 'Nueva consulta']
  );
  return result.insertId;
}

/**
 * Carga el historial reciente. Las imagenes que el usuario subio en turns
 * pasados NO se reenvian a Claude (costo prohibitivo y rara vez utiles
 * para el seguimiento). Solo se reenvia el texto. Si el usuario quiere
 * referirse a la imagen, la sube de nuevo.
 */
async function loadHistory(conversationId, limit = 30) {
  const rows = await db.query(
    `SELECT role, content_json FROM messages
     WHERE conversation_id = ? AND role IN ('user','assistant')
     ORDER BY id ASC
     LIMIT ?`,
    [conversationId, limit]
  );
  return rows.map(r => {
    const content = typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json;
    if (r.role === 'user') {
      // tool_result blocks (cuando el tool loop empuja al user role) son arrays
      if (Array.isArray(content)) return { role: 'user', content };
      // Mensaje de usuario con texto + (opcionalmente) attachments. Solo
      // mandamos el texto. Si habia adjuntos, agregamos una linea
      // explicativa para que el modelo sepa que existieron.
      let text = content.text || JSON.stringify(content);
      if (content.attachments && content.attachments.length) {
        const desc = content.attachments
          .map(a => `${a.mime_type} ${Math.round((a.byte_size || 0) / 1024)}KB sha=${(a.sha256 || '').slice(0, 8)}`)
          .join(', ');
        text += `\n\n[En este turn el usuario adjunto ${content.attachments.length} imagen(es): ${desc}. No las tienes a la vista ahora; si necesitas verlas pide que las reenvie.]`;
      }
      return { role: 'user', content: text };
    }
    return { role: 'assistant', content };
  });
}

module.exports = { chat, getOrCreateConversation, loadHistory };
