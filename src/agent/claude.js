const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { buildSystemPrompt } = require('./system-prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');
const db = require('../db/pool');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const MAX_TOOL_ITERATIONS = 8;

async function logMessage(conversationId, role, contentJson, usage = {}, latencyMs = null) {
  await db.query(
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
}

/**
 * Ejecuta un turn del agente: recibe un mensaje del usuario, llama a Claude, ejecuta tools si las pide,
 * itera hasta que Claude termina de responder, y devuelve el texto final + metadata.
 */
async function chat({ user, conversationId, userMessage, history = [] }) {
  const systemPrompt = buildSystemPrompt(user);

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  await logMessage(conversationId, 'user', { text: userMessage });

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

    // Si terminó sin tool use, recolectamos texto final
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    // tool_use: ejecutamos cada tool y armamos los tool_results
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

    // Otros stop_reason (max_tokens, etc.) cortamos aqui
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
  };
}

/**
 * Crea o continua una conversacion. Si conversationId es null crea una nueva.
 */
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
 * Carga el historial reciente (mensajes user/assistant solamente, en formato Anthropic) para una conversacion.
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
      // Si es objeto {text}, lo convertimos a string. Si es array (tool_results), lo dejamos.
      if (Array.isArray(content)) return { role: 'user', content };
      return { role: 'user', content: content.text || JSON.stringify(content) };
    }
    return { role: 'assistant', content };
  });
}

module.exports = { chat, getOrCreateConversation, loadHistory };
