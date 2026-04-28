// Dashboard meta del propio BOTDOT: quien pregunta, cuando, que cuesta, que se rechaza.
// Acceso: solo admin / manager / compliance.

const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../db/pool');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'manager', 'compliance'));

// Pricing Claude (USD por 1M tokens) - mantener actualizado
const PRICING = {
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
  'claude-opus-4-7':   { input: 15, output: 75, cache_read: 1.50, cache_write: 18.75 },
};

function parsePeriod(p) {
  const map = { '7d': 7, '14d': 14, '30d': 30, '60d': 60, '90d': 90 };
  return map[p] || 30;
}

// ─── Overview / KPIs ─────────────────────────────────────────
router.get('/overview', async (req, res) => {
  const days = parsePeriod(req.query.period);

  const [convs] = await db.query(
    `SELECT COUNT(*) AS n FROM conversations WHERE started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const [userMsgs] = await db.query(
    `SELECT COUNT(*) AS n FROM messages WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const [activeUsers] = await db.query(
    `SELECT COUNT(DISTINCT user_id) AS n FROM conversations WHERE last_activity_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const [refused] = await db.query(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='refused_request' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const [decisions] = await db.query(
    `SELECT COUNT(*) AS n FROM audit_log WHERE decision IN ('proceed','conditional','decline','override') AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const [overrides] = await db.query(
    `SELECT COUNT(*) AS n FROM audit_log WHERE decision='override' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const [latency] = await db.query(
    `SELECT AVG(latency_ms) AS avg_ms, MAX(latency_ms) AS max_ms
     FROM messages WHERE latency_ms IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );

  res.json({
    period_days: days,
    conversations: convs.n,
    user_messages: userMsgs.n,
    active_users: activeUsers.n,
    refused_requests: refused.n,
    decisions: decisions.n,
    overrides: overrides.n,
    override_rate_pct: decisions.n ? Math.round((overrides.n / decisions.n) * 1000) / 10 : 0,
    avg_latency_ms: latency.avg_ms ? Math.round(latency.avg_ms) : null,
    max_latency_ms: latency.max_ms || null,
  });
});

// ─── Uso a lo largo del tiempo (diario) ──────────────────────
router.get('/usage-over-time', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT DATE(created_at) AS day,
            COUNT(*) AS messages,
            COUNT(DISTINCT conversation_id) AS conversations
     FROM messages
     WHERE role='user' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY day
     ORDER BY day ASC`,
    [days]
  );
  res.json({ period_days: days, series: rows });
});

// ─── Top usuarios por volumen ────────────────────────────────
router.get('/top-users', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const rows = await db.query(
    `SELECT u.id, u.full_name, u.role, u.email,
            COUNT(m.id) AS queries,
            COUNT(DISTINCT c.id) AS conversations,
            MAX(c.last_activity_at) AS last_active
     FROM users u
     JOIN conversations c ON c.user_id = u.id
     JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
     WHERE m.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY u.id
     ORDER BY queries DESC
     LIMIT ?`,
    [days, limit]
  );
  res.json({ users: rows });
});

// ─── Uso por rol ─────────────────────────────────────────────
router.get('/by-role', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT u.role, COUNT(m.id) AS queries, COUNT(DISTINCT u.id) AS users
     FROM users u
     JOIN conversations c ON c.user_id = u.id
     JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
     WHERE m.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY u.role
     ORDER BY queries DESC`,
    [days]
  );
  res.json({ by_role: rows });
});

// ─── Tools mas llamadas ──────────────────────────────────────
router.get('/top-tools', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(content_json,'$.name')) AS tool_name,
            COUNT(*) AS calls
     FROM messages
     WHERE role='tool_use' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY tool_name
     ORDER BY calls DESC
     LIMIT 30`,
    [days]
  );
  res.json({ tools: rows });
});

// ─── Decisiones (proceed / decline / conditional / override) ─
router.get('/decisions', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT decision, COUNT(*) AS count
     FROM audit_log
     WHERE decision IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY decision
     ORDER BY count DESC`,
    [days]
  );
  res.json({ decisions: rows });
});

// ─── Heatmap horario (hora x dia de la semana) ───────────────
router.get('/hour-heatmap', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT HOUR(created_at) AS hour,
            DAYOFWEEK(created_at) AS dow,
            COUNT(*) AS count
     FROM messages
     WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY hour, dow`,
    [days]
  );
  res.json({ heatmap: rows });
});

// ─── Topicos / preguntas frecuentes (naive: word frequency) ──
// MVP: tally de palabras significativas (>=4 letras, no stopwords) en mensajes user.
// Sprint 2: clustering semantico via Claude embeddings.
const STOPWORDS = new Set([
  'para','como','cual','cuanto','tiene','tengo','puede','puedo','sobre','desde','hasta',
  'pero','este','esta','estos','estas','aunque','tambien','cuando','donde','dame','quiero',
  'haz','hace','hoy','manana','ayer','nuestro','nuestros','algun','alguna','algunos','algunas',
  'todo','todos','toda','todas','muy','mucho','muchos','mucha','muchas','tanto','poco',
  'with','from','have','what','when','which','this','that','these','those','please',
  'driver','drivers','load','loads','vehicle','vehicles','operator','operators',
]);

router.get('/topics', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(content_json,'$.text')) AS text
     FROM messages
     WHERE role='user' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND JSON_EXTRACT(content_json,'$.text') IS NOT NULL`,
    [days]
  );
  const wordCount = new Map();
  for (const r of rows) {
    const t = (r.text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const words = t.split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOPWORDS.has(w));
    for (const w of words) wordCount.set(w, (wordCount.get(w) || 0) + 1);
  }
  const top = [...wordCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));

  // Top de "primeras 60 chars" como aproximacion de pregunta repetida
  const promptStarts = await db.query(
    `SELECT title, COUNT(*) AS count
     FROM conversations
     WHERE started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY title
     HAVING count > 1
     ORDER BY count DESC
     LIMIT 15`,
    [days]
  );

  res.json({
    period_days: days,
    sample_size: rows.length,
    top_words: top,
    repeated_prompts: promptStarts,
  });
});

// ─── Costos / tokens ─────────────────────────────────────────
router.get('/cost', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT
       COALESCE(SUM(tokens_input), 0) AS input_tokens,
       COALESCE(SUM(tokens_output), 0) AS output_tokens,
       COALESCE(SUM(tokens_cache_read), 0) AS cache_read_tokens,
       COALESCE(SUM(tokens_cache_create), 0) AS cache_create_tokens
     FROM messages
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  const t = rows[0];
  const p = PRICING['claude-sonnet-4-6'];
  const cost =
    (t.input_tokens / 1e6) * p.input +
    (t.output_tokens / 1e6) * p.output +
    (t.cache_read_tokens / 1e6) * p.cache_read +
    (t.cache_create_tokens / 1e6) * p.cache_write;

  res.json({
    period_days: days,
    tokens: t,
    estimated_cost_usd: Math.round(cost * 100) / 100,
    estimated_monthly_usd: Math.round((cost / days) * 30 * 100) / 100,
    pricing_basis: PRICING['claude-sonnet-4-6'],
  });
});

// ─── Refused requests recientes (los intentos que el bot bloqueo) ──
router.get('/refused', async (req, res) => {
  const days = parsePeriod(req.query.period);
  const rows = await db.query(
    `SELECT a.id, a.created_at, a.reasoning, a.cfr_cited, a.evidence_json,
            u.full_name, u.role
     FROM audit_log a JOIN users u ON u.id = a.user_id
     WHERE a.action_type='refused_request' AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY a.id DESC LIMIT 50`,
    [days]
  );
  res.json({ refused: rows });
});

module.exports = router;
