#!/usr/bin/env node
// Recorre la cadena de hashes de audit_log y reporta cualquier ruptura.
// Uso:
//   node scripts/verify-audit-chain.js
//   node scripts/verify-audit-chain.js --from 1000 --to 2000
//
// Pensado para ejecutarse en cron diario en prod. Sale con codigo 0 si
// la cadena esta intacta, 1 si encuentra issues, 2 si hubo error tecnico.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { verifyChain } = require('../src/db/audit-chain');
const { pool } = require('../src/db/pool');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = parseInt(argv[++i], 10);
    else if (a === '--to') out.to = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Uso: node scripts/verify-audit-chain.js [--from ID] [--to ID] [--json]');
    process.exit(0);
  }

  const t0 = Date.now();
  const result = await verifyChain({
    from: args.from ?? null,
    to: args.to ?? null,
  });
  const elapsed = Date.now() - t0;

  if (args.json) {
    console.log(JSON.stringify({ ...result, elapsed_ms: elapsed }, null, 2));
  } else {
    console.log(`Filas verificadas: ${result.rows_checked}`);
    console.log(`Estado:            ${result.intact ? 'INTACTA' : 'COMPROMETIDA'}`);
    console.log(`Head audit_id:     ${result.head_audit_id ?? '(vacia)'}`);
    console.log(`Head row_hash:     ${result.head_hash}`);
    console.log(`Tiempo:            ${elapsed} ms`);
    if (!result.intact) {
      console.log('\nIssues encontrados:');
      for (const issue of result.issues) {
        console.log(`  audit_id=${issue.audit_id} type=${issue.type}`);
        if (issue.type === 'broken_link') {
          console.log(`    expected_prev_hash: ${issue.expected_prev_hash}`);
          console.log(`    actual_prev_hash:   ${issue.actual_prev_hash}`);
        } else if (issue.type === 'hash_mismatch') {
          console.log(`    stored_row_hash:     ${issue.stored_row_hash}`);
          console.log(`    recomputed_row_hash: ${issue.recomputed_row_hash}`);
        }
      }
    }
  }

  await pool.end();
  process.exit(result.intact ? 0 : 1);
}

main().catch(e => {
  console.error('Error verificando cadena:', e);
  process.exit(2);
});
