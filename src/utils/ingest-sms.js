// Ingesta de un SMS xlsx download a la DB.
// Lee los CSVs ya extraidos en data/ (generados por el script PowerShell)
// y los carga a sms_snapshots, sms_violations, sms_inspections, sms_crashes.
//
// Uso: node src/utils/ingest-sms.js [snapshot_date_yyyy-mm-dd]
// Si no se da fecha, usa la fecha de archivo del CSV.

const fs = require('fs');
const path = require('path');
const db = require('../db/pool');

const DATA_DIR = path.join(__dirname, '../../data');

function parseCsv(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`No se encontro ${filename}, salteando.`);
    return [];
  }
  let text = fs.readFileSync(filepath, 'utf8');
  // Strip UTF-8 BOM si esta presente — sino la primera key del header
  // sale como "﻿BASIC" y todos los lookups r.BASIC fallan silencioso.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] !== undefined ? fields[i] : null; });
    return obj;
  });
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

async function main() {
  const snapshotDate = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(`Ingestando snapshot ${snapshotDate}...`);

  // BASICs (con percentiles reales)
  const basics = parseCsv('agg_basic_with_percentile.csv');
  for (const r of basics) {
    await db.query(
      `INSERT INTO sms_snapshots (snapshot_date, basic_name, measure, score_pct, threshold_pct, alert, months_in_alert, violations_count, oos_count, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE measure=VALUES(measure), score_pct=VALUES(score_pct),
         threshold_pct=VALUES(threshold_pct), alert=VALUES(alert), months_in_alert=VALUES(months_in_alert),
         violations_count=VALUES(violations_count), oos_count=VALUES(oos_count)`,
      [
        snapshotDate,
        r.BASIC,
        parseFloat(r.Measure) || null,
        parseInt(r.Score_Pct) || null,
        parseInt(r.Threshold) || null,
        r.Alert === 'Alert' ? 1 : 0,
        parseInt(r.MonthsInAlert) || 0,
        parseInt(r.Violaciones) || 0,
        parseInt(r.OOS) || 0,
        'agg_basic_with_percentile.csv',
      ]
    );
  }
  console.log(`  BASICs: ${basics.length} cargados`);

  // Top violations
  const topViols = parseCsv('agg_top_viol.csv');
  for (const r of topViols) {
    await db.query(
      `INSERT INTO sms_violations (snapshot_date, basic_name, violation_code, violation_group, description, count, oos_count, severity_weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotDate,
        r.BASIC,
        r.Code,
        r.Group,
        r.Description,
        parseInt(r.Count) || 0,
        parseInt(r.OOS) || 0,
        parseInt(r.Sev) || 0,
      ]
    );
  }
  console.log(`  Top violations: ${topViols.length} cargadas`);

  // Crashes
  const crashes = parseCsv('agg_crashes.csv');
  for (const r of crashes) {
    if (!r.Reporte) continue;
    await db.query(
      `INSERT INTO sms_crashes (crash_number, crash_date, state, fatalities, injuries, tow_away, hm_released, not_preventable, severity_weight, time_weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE not_preventable=VALUES(not_preventable)`,
      [
        r.Reporte,
        new Date(r.Fecha).toISOString().slice(0, 10),
        r.Estado,
        parseInt(r.Fatales) || 0,
        parseInt(r.Lesionados) || 0,
        r.TowAway === 'Yes' ? 1 : 0,
        0,
        r.NotPreventable === 'Yes' ? 1 : null,
        parseInt(r.Severidad) || null,
        parseInt(r.TimeWeight) || null,
      ]
    );
  }
  console.log(`  Crashes: ${crashes.length} cargados`);

  console.log('Ingesta completada.');
  process.exit(0);
}

main().catch(e => {
  console.error('Error en ingesta:', e);
  process.exit(1);
});
