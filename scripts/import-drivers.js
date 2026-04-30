#!/usr/bin/env node
// CLI wrapper de src/utils/import-drivers.js.
//
// Uso:
//   node scripts/import-drivers.js "data/imports/DOT Driver List.xlsx"
//     → dry-run: parsea, hace match, imprime preview pero NO toca DB
//
//   node scripts/import-drivers.js "data/imports/DOT Driver List.xlsx" --commit
//     → ejecuta el upsert + popula driver_import_discrepancies
//
// El dry-run es seguro de correr en cualquier momento. El --commit
// transaccional — si algo falla, rollback completo.

require('dotenv').config();
const path = require('path');
const { runImport } = require('../src/utils/import-drivers');
const { pool } = require('../src/db/pool');

(async () => {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const commit = args.includes('--commit');

  if (!file) {
    console.error('Uso: node scripts/import-drivers.js <ruta.xlsx> [--commit]');
    process.exit(1);
  }

  const t0 = Date.now();
  const result = await runImport(path.resolve(file), { commit });
  const elapsed = Date.now() - t0;

  console.log(`\n=== Import driver list ${commit ? '(COMMIT)' : '(dry-run)'} ===`);
  console.log(`Archivo: ${file}`);
  console.log(`Tiempo:  ${elapsed} ms`);
  console.log('\nResumen:');
  console.log(`  Excel Active:        ${result.summary.excel_active}`);
  console.log(`  Excel Terminated:    ${result.summary.excel_terminated}`);
  console.log(`  Drivers en Samsara:  ${result.summary.samsara_total}`);
  console.log(`  Match (en ambos):    ${result.summary.matched}`);
  console.log(`    - por CDL #:           ${result.summary.by_cdl}`);
  console.log(`    - por nombre fuzzy:    ${result.summary.by_name_fuzzy}`);
  console.log(`  Excel-only:          ${result.summary.excel_only}`);
  console.log(`  Samsara-only:        ${result.summary.samsara_only}`);
  console.log(`  Skip (sin nombre/CDL): ${result.summary.skipped_no_name_no_cdl}`);

  if (!commit) {
    if (result.matches && result.matches.length) {
      console.log('\nMuestra de matches:');
      for (const m of result.matches.slice(0, 10)) {
        console.log(`  fila ${m.excel_row} → driver_id=${m.driver_id} (${m.by})`);
        console.log(`    excel: "${m.excel_name}" → existing: "${m.existing_name}"`);
      }
    }
    if (result.excel_only_sample && result.excel_only_sample.length) {
      console.log('\nMuestra Excel-only (primeros 10):');
      for (const r of result.excel_only_sample.slice(0, 10)) {
        console.log(`  - ${r.full_name} (CDL ${r.cdl_number || 'sin CDL'}) — ${r._bucket}`);
      }
    }
    if (result.samsara_only_sample && result.samsara_only_sample.length) {
      console.log('\nMuestra Samsara-only (primeros 10):');
      for (const r of result.samsara_only_sample.slice(0, 10)) {
        console.log(`  - ${r.full_name} (samsara_id=${r.samsara_id})`);
      }
    }
    console.log('\nDry-run. Para ejecutar: agregar --commit');
  } else {
    console.log(`\nBatch: ${result.summary.batch_id}`);
    console.log(`Updates aplicados: ${result.matches_count}`);
    console.log(`Discrepancies registradas: ${result.excel_only_count + result.samsara_only_count}`);
  }

  await pool.end();
  process.exit(0);
})().catch(e => {
  console.error('Error en import:', e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
