// Tools de auditoria. Cada decision operacional importante se registra aqui.
// El audit_log es inmutable - nunca actualizar/borrar registros.

const db = require('../../db/pool');

const logDecision = {
  definition: {
    name: 'log_decision',
    description: 'Registra una decision operacional en el audit log. Llamala SIEMPRE despues de recomendar una asignacion, rechazo, o cualquier decision con consecuencias regulatorias.',
    input_schema: {
      type: 'object',
      properties: {
        action_type: {
          type: 'string',
          description: 'Tipo de accion (ej. "assignment_check","driver_lookup","basic_review","coaching_note","dataqs_review")',
        },
        subject_type: {
          type: 'string',
          description: 'Tipo del sujeto afectado (driver, vehicle, load, basic, crash)',
        },
        subject_id: { type: 'string', description: 'Identificador del sujeto' },
        decision: {
          type: 'string',
          enum: ['proceed', 'conditional', 'decline', 'override', 'informational'],
        },
        cfr_cited: { type: 'string', description: 'CFR(s) citados separados por coma' },
        reasoning: { type: 'string', description: 'Razonamiento corto del agente' },
        evidence: {
          type: 'object',
          description: 'Evidencia estructurada (HOS snapshot, violaciones, datos)',
        },
      },
      required: ['action_type', 'decision', 'reasoning'],
    },
  },
  handler: async (input, context) => {
    const userId = context?.user?.id || null;
    const conversationId = context?.conversationId || null;
    if (!userId) return { error: 'No se puede registrar audit sin user en contexto' };

    const result = await db.query(
      `INSERT INTO audit_log
        (user_id, conversation_id, action_type, subject_type, subject_id, decision, cfr_cited, reasoning, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        conversationId,
        input.action_type,
        input.subject_type || null,
        input.subject_id || null,
        input.decision,
        input.cfr_cited || null,
        input.reasoning,
        input.evidence ? JSON.stringify(input.evidence) : null,
      ]
    );
    return { logged: true, audit_id: result.insertId };
  },
};

const logRefusedRequest = {
  definition: {
    name: 'log_refused_request',
    description: 'Registra cuando rechazas una solicitud que podria ser violacion (ej. "como hacer false log", "ayudame con PC abuse"). Esto protege al carrier mostrando que el sistema desincentiva activamente las violaciones.',
    input_schema: {
      type: 'object',
      properties: {
        request_summary: { type: 'string', description: 'Resumen de lo que el usuario pidio' },
        reason_refused: { type: 'string', description: 'Por que se rechazo (cita CFR si aplica)' },
        cfr_violated_if_done: { type: 'string', description: 'CFR que se hubiera violado si se hubiera hecho' },
      },
      required: ['request_summary', 'reason_refused'],
    },
  },
  handler: async (input, context) => {
    const userId = context?.user?.id || null;
    const conversationId = context?.conversationId || null;
    if (!userId) return { error: 'No se puede registrar refused request sin user' };

    const result = await db.query(
      `INSERT INTO audit_log
        (user_id, conversation_id, action_type, decision, cfr_cited, reasoning, evidence_json)
       VALUES (?, ?, 'refused_request', 'decline', ?, ?, ?)`,
      [
        userId,
        conversationId,
        input.cfr_violated_if_done || null,
        input.reason_refused,
        JSON.stringify({ request: input.request_summary }),
      ]
    );
    return { logged: true, audit_id: result.insertId };
  },
};

module.exports = { logDecision, logRefusedRequest };
