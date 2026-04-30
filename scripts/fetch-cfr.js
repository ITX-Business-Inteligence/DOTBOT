#!/usr/bin/env node
// CLI wrapper de src/jobs/cfr-update.js.
//
// Uso:
//   node scripts/fetch-cfr.js                # corre el flujo completo (DB + diff)
//   node scripts/fetch-cfr.js 2026-04-28     # forza una fecha de issue especifica
//
// El primer run con DB vacia funciona en modo "baseline": INSERT all sin
// emitir emails ni audit log. Los runs siguientes detectan diffs y notifican.

require('dotenv').config();
const { runCfrUpdate } = require('../src/jobs/cfr-update');
const { pool } = require('../src/db/pool');

(async () => {
  const issueDate = process.argv[2] || null;
  const r = await runCfrUpdate({ trigger: 'manual', issueDate });
  console.log('\n=== Resumen ===');
  console.log(JSON.stringify(r, null, 2));
  await pool.end();
  process.exit(0);
})().catch(e => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
