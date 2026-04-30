// Tool para escalar a compliance cuando el bot no puede dar una
// recomendacion solida sobre un caso operacional.
//
// Flujo:
//   1. INSERT en `escalations` (status=pending)
//   2. audit_log via appendAudit (queda en la cadena tamper-evident)
//   3. Email a compliance (best-effort, no bloquea)
//   4. Devuelve al agente { escalated: true, escalation_id, message_to_user }
//      — el agente cierra su respuesta con esa frase

const { appendAudit } = require('../../db/audit-chain');
const { sendEmail } = require('../../utils/email');
const config = require('../../config');
const logger = require('../../utils/logger');
const db = require('../../db/pool');

const log = logger.child({ component: 'escalate' });

const REDIRECT_PHRASE =
  'Esta consulta requiere revision humana. Te conecto con compliance — ' +
  'un officer va a revisar tu caso y te contactara.';

const logEscalation = {
  definition: {
    name: 'escalate_to_compliance',
    description:
      'Crea una escalacion al equipo de compliance cuando NO podes dar una ' +
      'recomendacion solida sobre un caso operacional (asignacion, fitness, ' +
      'decision regulatoria) por falta de data o ambiguedad. NO usar para ' +
      'preguntas off-topic, evasion, o saludos — esas tienen sus propias ' +
      'tools (log_off_topic / log_refused_request). NO usar para preguntas ' +
      'puramente informativas que simplemente no tenes en tu base — esas ' +
      'respondelas con "no lo tengo, verifica en ecfr.gov". USAR cuando el ' +
      'usuario esta por tomar una decision con consecuencias y vos no tenes ' +
      'fundamento para guiarla.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Resumen breve del caso (que pregunta el usuario, sobre quien, en que contexto). 1-2 oraciones.',
        },
        category: {
          type: 'string',
          enum: [
            'missing_data',           // no tengo info del driver/vehiculo/load
            'ambiguous_compliance',   // CFR aplicable es ambiguo
            'user_requested',         // el usuario pidio humano explicitamente
            'complex_decision',       // caso complejo que requiere juicio
            'potential_violation',    // hay riesgo de violacion DOT real
            'other',
          ],
        },
        urgency: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description:
            'critical: violacion inminente o decision de minutos. ' +
            'high: decision pendiente del dia con riesgo regulatorio. ' +
            'medium: pregunta operacional con datos parciales. ' +
            'low: duda menor sin urgencia.',
        },
        what_was_missing: {
          type: 'string',
          description:
            'Que data o validacion te falto para responder vos solo. Util para que compliance entienda donde meter el patch.',
        },
      },
      required: ['summary', 'category', 'urgency'],
    },
  },
  handler: async (input, context) => {
    const userId = context?.user?.id || null;
    const conversationId = context?.conversationId || null;
    if (!userId) return { error: 'No se puede escalar sin user en contexto' };

    // 1. INSERT en escalations
    const result = await db.query(
      `INSERT INTO escalations
         (user_id, conversation_id, trigger_message, bot_reasoning, category, urgency, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        userId,
        conversationId,
        input.summary || '(sin resumen)',
        input.what_was_missing || null,
        input.category,
        input.urgency,
      ]
    );
    const escalationId = result.insertId;

    // 2. Audit en la cadena
    await appendAudit({
      user_id: userId,
      conversation_id: conversationId,
      action_type: 'escalation_created',
      subject_type: 'escalation',
      subject_id: String(escalationId),
      decision: 'informational',
      reasoning: `Bot escalo a compliance: [${input.category}/${input.urgency}] ${input.summary}`,
      evidence: input,
    });

    // 3. Email a compliance (async, NO bloquea — si falla, igual la
    //    escalacion ya esta en DB)
    sendEscalationEmail(escalationId, input, context).catch(err =>
      log.error({ err, escalation_id: escalationId }, 'email send failed')
    );

    return {
      escalated: true,
      escalation_id: escalationId,
      message_to_user: REDIRECT_PHRASE,
    };
  },
};

async function sendEscalationEmail(escalationId, input, context) {
  // Determinar destinatarios:
  //   1. Si BOTDOT_ESCALATIONS_TO esta seteado, esos emails (ej. alias)
  //   2. Sino, todos los usuarios con role=compliance activos
  let recipients = [];
  if (config.email.escalationsTo) {
    recipients = config.email.escalationsTo.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    const rows = await db.query(
      `SELECT email FROM users WHERE role = 'compliance' AND active = 1`
    );
    recipients = rows.map(r => r.email);
  }

  if (!recipients.length) {
    await db.query(
      `UPDATE escalations SET email_error = ? WHERE id = ?`,
      ['No hay usuarios con rol compliance activos para notificar', escalationId]
    );
    return;
  }

  const askerName = context?.user?.name || 'Usuario';
  const askerRole = context?.user?.role || '?';
  const askerEmail = context?.user?.email || '';
  const urgencyEmoji = { critical: '🚨', high: '⚠️', medium: '⚡', low: '📋' }[input.urgency] || '📋';

  const subject = `${urgencyEmoji} BOTDOT escalacion ${input.urgency.toUpperCase()} — ${input.category} — #${escalationId}`;

  const text =
`Una nueva escalacion fue creada por BOTDOT.

Usuario: ${askerName} (${askerRole}) <${askerEmail}>
Urgencia: ${input.urgency}
Categoria: ${input.category}
Escalacion ID: ${escalationId}

Resumen del caso:
${input.summary}

Lo que le falto al bot:
${input.what_was_missing || '(sin detalle)'}

Para revisar y resolver, abre el dashboard:
${config.publicUrl}/escalations.html

— BOTDOT (no respondas a este email, abre el dashboard)
`;

  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px">
  <h2 style="color:#0f172a">${urgencyEmoji} Escalacion ${input.urgency.toUpperCase()} — ${input.category}</h2>
  <p><b>Usuario:</b> ${escapeHtml(askerName)} (${askerRole}) &lt;${escapeHtml(askerEmail)}&gt;</p>
  <p><b>Escalacion ID:</b> #${escalationId}</p>
  <h3>Resumen del caso</h3>
  <p style="background:#f1f5f9;padding:12px;border-left:4px solid #2563eb">${escapeHtml(input.summary)}</p>
  <h3>Lo que le falto al bot</h3>
  <p>${escapeHtml(input.what_was_missing || '(sin detalle)')}</p>
  <p><a href="${config.publicUrl}/escalations.html"
        style="background:#2563eb;color:white;padding:10px 16px;border-radius:6px;text-decoration:none">
     Abrir dashboard de escalaciones
  </a></p>
  <hr><p style="font-size:12px;color:#64748b">BOTDOT — no respondas a este email.</p>
</div>`;

  const result = await sendEmail({ to: recipients, subject, text, html });
  await db.query(
    `UPDATE escalations
     SET email_sent_at = ?, email_recipients = ?, email_error = ?
     WHERE id = ?`,
    [
      result.sent ? new Date() : null,
      recipients.join(','),
      result.sent ? null : (result.error || 'unknown'),
      escalationId,
    ]
  );
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { escalateToCompliance: logEscalation, REDIRECT_PHRASE };
