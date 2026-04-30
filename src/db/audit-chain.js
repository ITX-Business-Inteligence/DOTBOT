// Hash chain tamper-evident para audit_log.
//
// Cada fila guarda:
//   prev_hash = row_hash de la fila anterior (o GENESIS_HASH para la primera)
//   row_hash  = SHA-256( prev_hash || canonical(contenido_de_esta_fila) )
//
// Si alguien modifica una fila historica, su row_hash deja de cuadrar Y
// rompe la cadena de todas las filas posteriores. La verificacion lo detecta.
//
// Concurrencia: usamos GET_LOCK a nivel de servidor MySQL para serializar
// las inserciones — sostener un lock named en la misma conexion donde corre
// la transaccion garantiza que no haya forks de cadena.

const crypto = require('crypto');
const db = require('./pool');

const GENESIS_HASH = '0'.repeat(64);
const CHAIN_LOCK_NAME = 'botdot_audit_chain';

// Serializacion canonica determinista (independiente del orden de keys que
// devuelva MySQL JSON o el cliente). NO usar JSON.stringify directo porque
// el orden de keys puede variar.
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Numero no finito en canonical');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k =>
      JSON.stringify(k) + ':' + canonicalize(value[k])
    ).join(',') + '}';
  }
  throw new Error(`Tipo no canonicalizable: ${typeof value}`);
}

// mysql2 puede entregar columnas JSON ya parseadas (objeto) o como string crudo.
// Normalizamos a objeto JS para que canonicalize() produzca el mismo bytes
// independiente de como MySQL haya re-formateado el JSON.
function parseJsonColumn(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// Trunca a precision de segundos para que el hash no dependa de fractional
// seconds — algunas instalaciones de MySQL tienen DATETIME (sin fraccion) y
// otras DATETIME(6); queremos que el hash sea estable cualquiera que sea.
function isoSeconds(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
    .toISOString()
    .slice(0, 19) + 'Z';
}

// Construye el objeto que se canonicaliza y se hashea. Esta funcion es la
// "definicion" de la cadena: cualquier cambio aqui rompe la verificacion
// de filas existentes. Si alguna vez hace falta cambiarla, hay que versionar
// el algoritmo (ej. agregando un campo schema_version al hashable).
function buildHashable({
  user_id, conversation_id, action_type, subject_type, subject_id,
  decision, cfr_cited, reasoning, evidence, override_reason,
  created_at_iso, prev_hash,
}) {
  return {
    schema_version: 1,
    user_id: user_id ?? null,
    conversation_id: conversation_id ?? null,
    action_type: action_type ?? null,
    subject_type: subject_type ?? null,
    subject_id: subject_id ?? null,
    decision: decision ?? null,
    cfr_cited: cfr_cited ?? null,
    reasoning: reasoning ?? null,
    evidence: evidence ?? null,
    override_reason: override_reason ?? null,
    created_at: created_at_iso,
    prev_hash,
  };
}

function computeRowHash(hashable) {
  const canonical = canonicalize(hashable);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// Inserta una fila en audit_log calculando prev_hash y row_hash. Usa
// GET_LOCK + transaccion para serializar inserciones concurrentes.
async function appendAudit(row) {
  return db.transaction(async (conn) => {
    const [lockRows] = await conn.execute(
      `SELECT GET_LOCK(?, 10) AS got`, [CHAIN_LOCK_NAME]
    );
    if (lockRows[0].got !== 1) {
      throw new Error('No se pudo adquirir lock de la cadena de audit (timeout)');
    }
    try {
      // Leer el head actual de la cadena
      const [headRows] = await conn.execute(
        `SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`
      );
      const prevHash = headRows[0]?.row_hash || GENESIS_HASH;

      // Timestamp en JS, truncado a segundos para estabilidad
      const now = new Date();
      const createdAtIso = isoSeconds(now);
      const createdAtForDb = createdAtIso.replace('T', ' ').replace('Z', ''); // 'YYYY-MM-DD HH:MM:SS'

      // evidence_json se guarda como JSON en la DB (puede normalizarse) pero
      // el hash usa la representacion canonica del objeto JS, asi el roundtrip
      // siempre cuadra.
      const evidenceObj = row.evidence ?? null;
      const evidenceForDb = evidenceObj === null ? null : JSON.stringify(evidenceObj);

      const hashable = buildHashable({
        user_id: row.user_id,
        conversation_id: row.conversation_id,
        action_type: row.action_type,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        decision: row.decision,
        cfr_cited: row.cfr_cited,
        reasoning: row.reasoning,
        evidence: evidenceObj,
        override_reason: row.override_reason,
        created_at_iso: createdAtIso,
        prev_hash: prevHash,
      });
      const rowHash = computeRowHash(hashable);

      const [result] = await conn.execute(
        `INSERT INTO audit_log
           (user_id, conversation_id, action_type, subject_type, subject_id,
            decision, cfr_cited, reasoning, evidence_json, override_reason,
            created_at, prev_hash, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.user_id,
          row.conversation_id ?? null,
          row.action_type,
          row.subject_type ?? null,
          row.subject_id ?? null,
          row.decision ?? null,
          row.cfr_cited ?? null,
          row.reasoning ?? null,
          evidenceForDb,
          row.override_reason ?? null,
          createdAtForDb,
          prevHash,
          rowHash,
        ]
      );
      return { audit_id: result.insertId, row_hash: rowHash, prev_hash: prevHash };
    } finally {
      await conn.execute(`SELECT RELEASE_LOCK(?)`, [CHAIN_LOCK_NAME]);
    }
  });
}

// Recorre la cadena en orden de id ASC y verifica:
//   - prev_hash de cada fila == row_hash de la anterior
//   - row_hash recalculado == row_hash almacenado
// Devuelve un array de issues; vacio = cadena intacta.
async function verifyChain({ from = null, to = null } = {}) {
  const where = [];
  const params = [];
  if (from !== null) { where.push('id >= ?'); params.push(from); }
  if (to !== null)   { where.push('id <= ?'); params.push(to); }
  const sql =
    `SELECT id, user_id, conversation_id, action_type, subject_type, subject_id,
            decision, cfr_cited, reasoning, evidence_json, override_reason,
            created_at, prev_hash, row_hash
     FROM audit_log
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id ASC`;
  const rows = await db.query(sql, params);

  let expectedPrev = from === null ? GENESIS_HASH : null;
  const issues = [];

  for (const r of rows) {
    if (expectedPrev !== null && r.prev_hash !== expectedPrev) {
      issues.push({
        audit_id: r.id,
        type: 'broken_link',
        expected_prev_hash: expectedPrev,
        actual_prev_hash: r.prev_hash,
      });
    }

    const evidenceObj = parseJsonColumn(r.evidence_json);
    const createdAtDate = r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    const hashable = buildHashable({
      user_id: r.user_id,
      conversation_id: r.conversation_id,
      action_type: r.action_type,
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      decision: r.decision,
      cfr_cited: r.cfr_cited,
      reasoning: r.reasoning,
      evidence: evidenceObj,
      override_reason: r.override_reason,
      created_at_iso: isoSeconds(createdAtDate),
      prev_hash: r.prev_hash,
    });
    const recomputed = computeRowHash(hashable);
    if (recomputed !== r.row_hash) {
      issues.push({
        audit_id: r.id,
        type: 'hash_mismatch',
        stored_row_hash: r.row_hash,
        recomputed_row_hash: recomputed,
      });
    }

    expectedPrev = r.row_hash;
  }

  return {
    rows_checked: rows.length,
    intact: issues.length === 0,
    head_hash: expectedPrev || GENESIS_HASH,
    head_audit_id: rows.length ? rows[rows.length - 1].id : null,
    issues,
  };
}

// Devuelve el head actual de la cadena (util para anclaje externo).
async function getChainHead() {
  const last = await db.queryOne(
    `SELECT id, row_hash, created_at FROM audit_log ORDER BY id DESC LIMIT 1`
  );
  if (!last) return { audit_id: null, row_hash: GENESIS_HASH, created_at: null };
  return { audit_id: last.id, row_hash: last.row_hash, created_at: last.created_at };
}

module.exports = {
  appendAudit,
  verifyChain,
  getChainHead,
  // exportados para tests / debug
  GENESIS_HASH,
  canonicalize,
  computeRowHash,
  buildHashable,
  isoSeconds,
};
