// Smoke test del audit_log: inserta 3 filas via appendAudit (la unica
// ruta legitima de escritura) y deja la cadena armada para los tests
// manuales de inmutabilidad.

require('dotenv').config();
const { appendAudit } = require('../src/db/audit-chain');

(async () => {
  for (let i = 1; i <= 3; i++) {
    const r = await appendAudit({
      user_id: 1,
      conversation_id: null,
      action_type: 'smoke_test',
      decision: 'informational',
      reasoning: 'Entry de prueba #' + i,
      evidence: { i, ts: new Date().toISOString() },
    });
    console.log('Inserted audit_id=' + r.audit_id + ' row_hash=' + r.row_hash.slice(0, 16) + '...');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
