// Pricing y queries de costo de Claude API.
// Fuente unica para analytics, budget caps y cualquier feature de billing.
// Mantener PRICING actualizado con anthropic.com/pricing.

const db = require('../db/pool');
const config = require('../config');
const logger = require('./logger');

// USD por 1M tokens. Mantener sincronizado con anthropic.com/pricing.
const PRICING = {
  'claude-sonnet-4-6': { input: 3,  output: 15, cache_read: 0.30, cache_write: 3.75 },
  'claude-opus-4-7':   { input: 15, output: 75, cache_read: 1.50, cache_write: 18.75 },
  'claude-haiku-4-5':  { input: 1,  output: 5,  cache_read: 0.10, cache_write: 1.25 },
};

const DEFAULT_MODEL = config.anthropic.model;

function getModelPricing(modelId) {
  const p = PRICING[modelId];
  if (!p) {
    // Fallback al modelo principal — mejor que tirar error y romper analytics
    // si alguien escribio mal el id en .env.
    logger.warn({ unknown_model: modelId, falling_back_to: DEFAULT_MODEL }, 'pricing desconocido para modelo, usando default');
    return PRICING[DEFAULT_MODEL] || PRICING['claude-sonnet-4-6'];
  }
  return p;
}

// Calcula USD a partir de un objeto de uso de la API de Anthropic.
// Acepta tanto el formato de Anthropic (input_tokens, output_tokens, ...)
// como el formato de DB (tokens_input, tokens_output, ...).
function costFromUsage(usage, modelId = DEFAULT_MODEL) {
  if (!usage) return 0;
  const p = getModelPricing(modelId);
  const input  = usage.input_tokens          ?? usage.tokens_input          ?? 0;
  const output = usage.output_tokens         ?? usage.tokens_output         ?? 0;
  const cRead  = usage.cache_read_input_tokens ?? usage.tokens_cache_read   ?? 0;
  const cWrite = usage.cache_creation_input_tokens ?? usage.tokens_cache_create ?? 0;
  return (
    (input  / 1e6) * p.input +
    (output / 1e6) * p.output +
    (cRead  / 1e6) * p.cache_read +
    (cWrite / 1e6) * p.cache_write
  );
}

// Suma de tokens × precio para un set arbitrario.
// Asume todos los mensajes usados con DEFAULT_MODEL — cuando se introduzca
// una columna `model` en la tabla `messages`, esta funcion debera agrupar.
async function spendUsd({ userId = null, hours = 24 } = {}) {
  const params = [hours];
  let join = '';
  let where = `m.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`;
  if (userId !== null) {
    join = `JOIN conversations c ON c.id = m.conversation_id`;
    where += ` AND c.user_id = ?`;
    params.push(userId);
  }
  const rows = await db.query(
    `SELECT
       COALESCE(SUM(m.tokens_input), 0)        AS tokens_input,
       COALESCE(SUM(m.tokens_output), 0)       AS tokens_output,
       COALESCE(SUM(m.tokens_cache_read), 0)   AS tokens_cache_read,
       COALESCE(SUM(m.tokens_cache_create), 0) AS tokens_cache_create
     FROM messages m
     ${join}
     WHERE ${where}`,
    params
  );
  return costFromUsage(rows[0], DEFAULT_MODEL);
}

module.exports = {
  PRICING,
  DEFAULT_MODEL,
  getModelPricing,
  costFromUsage,
  spendUsd,
};
