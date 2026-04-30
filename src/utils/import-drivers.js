// Importer de drivers desde el Excel "DOT Driver List.xlsx" de compliance.
//
// Estrategia (acordada con el usuario):
//   1. Para cada fila del Excel, intentar match contra `drivers` existentes
//      (que vienen de Samsara sync) — primero por CDL #, despues fuzzy por
//      nombre normalizado.
//   2. Solo importar (UPDATE compliance fields) los que CRUZAN — los que
//      estan en Samsara Y en el Excel.
//   3. Excel-only y Samsara-only quedan en driver_import_discrepancies
//      para que compliance los revise.
//
// Por eso en dev (con MockSamsara) vas a ver 0 matches: los 10 nombres
// mock no estan en el Excel real. En prod con Samsara real, va a producir
// la interseccion verdadera.

const ExcelJS = require('exceljs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/pool');

const SHEET_ACTIVE = 'Active Drivers';
const SHEET_TERMINATED = 'Terminated Drivers';

// Columnas exactas del Excel (con espacios raros y typos preservados).
// Si Karen renombra alguna columna, hay que ajustar acá.
const COL = {
  status:       'Status',
  name:         'Employee  Name',           // doble espacio en el header real
  dob:          'DOB',
  cdl_number:   'CDL #',
  endorsements: 'Endorsements',
  cdl_state:    'State',
  cdl_expire:   'CDL Expire',
  med_expire:   'Medical Card Expire',
  company:      'Company',
  location:     'Location',
  division:     'Division',
  hire_date:    'Hire Date ',                // trailing space
  phone:        'Phone',
  notes:        'Notes',
  more_notes:   'ADDITIONAL NOTES',
};

// ─── Normalizacion ──────────────────────────────────────────────

function normName(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // sacar acentos
    .toLowerCase()
    .replace(/[\*\.,;:#]/g, ' ')                       // sacar simbolos
    .replace(/\s+/g, ' ')                              // colapsar espacios
    .trim();
}

function normCdl(s) {
  if (!s) return '';
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normState(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;            // whitespace puro → null
  if (t.length <= 3) return t.toUpperCase();
  // "mexico" → "Mexico"
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// Parsea una fecha tipo "09/02/2026", "11/15/97", "1/22/26" en MM/DD/YYYY.
// Si el year es de 2 digitos: <50 → 20XX, ≥50 → 19XX.
// Devuelve string 'YYYY-MM-DD' o null si no parsea.
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  // Aceptar MM/DD/YYYY, MM/DD/YY, M/D/YY, etc.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) {
    // Tambien aceptar YYYY-MM-DD (formato ISO)
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return null;
  }
  let [, mo, d, y] = m;
  if (y.length === 2) y = parseInt(y) < 50 ? '20' + y : '19' + y;
  const mm = String(mo).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

// Distancia Levenshtein simple (max ~50 chars en nombres, no es bottleneck).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Threshold de match fuzzy: distancia <= max(2, 10% del largo del nombre)
function namesMatch(normA, normB) {
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const threshold = Math.max(2, Math.floor(Math.min(normA.length, normB.length) * 0.1));
  return levenshtein(normA, normB) <= threshold;
}

// ─── Parsing del xlsx ───────────────────────────────────────────
//
// Migrado de `xlsx` (sheetjs) a `exceljs` por CVE de prototype pollution
// en xlsx@0.18.5 (npm). exceljs es async por naturaleza.

// exceljs devuelve cell.value en distintas formas dependiendo del contenido.
// Normalizamos a un valor "scalar" que el resto del pipeline pueda tratar
// como string/number/Date.
function cellValue(cell) {
  const v = cell?.value;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v;
  // Hyperlink: { text, hyperlink }
  if (typeof v.text === 'string') return v.text;
  // Formula: { result, formula } — usamos el resultado evaluado
  if (v.result !== undefined) {
    return v.result instanceof Date ? v.result : (v.result?.text ?? v.result);
  }
  // Rich text: { richText: [{ text, font }, ...] }
  if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text).join('');
  // Shared formula u otro caso raro — fallback a string
  return String(v);
}

async function readExcel(filepath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filepath);
  const out = { active: [], terminated: [] };

  for (const [sheetName, bucket] of [[SHEET_ACTIVE, 'active'], [SHEET_TERMINATED, 'terminated']]) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;

    // Header: primera fila. Mapeamos colNumber → header name.
    const headerRow = ws.getRow(1);
    const headers = {};   // colNumber (1-based) → string
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const h = cellValue(cell);
      headers[colNumber] = h != null ? String(h) : null;
    });
    // Inverso: name → colNumber (para acceso por nombre como hacia sheet_to_json)
    const colByName = {};
    for (const [num, name] of Object.entries(headers)) {
      if (name) colByName[name] = parseInt(num, 10);
    }
    const get = (row, headerName) => {
      const c = colByName[headerName];
      return c ? cellValue(row.getCell(c)) : null;
    };

    // Iterar filas de datos (desde la 2 hasta rowCount)
    for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
      const row = ws.getRow(rowNum);

      const nameRaw = get(row, COL.name);
      const cdlRaw  = get(row, COL.cdl_number);
      const name = nameRaw != null ? String(nameRaw).trim() : '';
      const cdl  = cdlRaw  != null ? String(cdlRaw).trim()  : '';
      if (!name && !cdl) continue;     // fila vacia, skip

      const status     = get(row, COL.status);
      const endor      = get(row, COL.endorsements);
      const company    = get(row, COL.company);
      const location   = get(row, COL.location);
      const division   = get(row, COL.division);
      const phone      = get(row, COL.phone);
      const notesA     = get(row, COL.notes);
      const notesB     = get(row, COL.more_notes);

      out[bucket].push({
        excel_row: rowNum,
        status:        status != null ? String(status).trim() : null,
        full_name:     name || null,
        cdl_number:    cdl ? cdl.toUpperCase() : null,
        endorsements:  endor != null ? String(endor).trim() : null,
        cdl_state:     normState(get(row, COL.cdl_state)),
        cdl_expiration: parseDate(get(row, COL.cdl_expire)),
        medical_card_expiration: parseDate(get(row, COL.med_expire)),
        company:       company != null ? String(company).trim() : null,
        location:      location != null ? String(location).trim() : null,
        division:      division != null ? String(division).trim() : null,
        hire_date:     parseDate(get(row, COL.hire_date)),
        phone:         phone != null ? String(phone).trim() : null,
        notes:         joinNotes(notesA, notesB),
        _norm_name:    normName(name),
        _norm_cdl:     normCdl(cdl),
      });
    }
  }
  return out;
}

function joinNotes(a, b) {
  const parts = [a, b].filter(x => x != null && String(x).trim());
  return parts.length ? parts.map(s => String(s).trim()).join(' | ') : null;
}

// ─── Match contra drivers existentes ────────────────────────────

async function loadExistingDrivers() {
  const rows = await db.query(
    `SELECT id, samsara_id, full_name, cdl_number, data_source
     FROM drivers`
  );
  return rows.map(r => ({
    ...r,
    _norm_name: normName(r.full_name),
    _norm_cdl: normCdl(r.cdl_number),
  }));
}

function findMatch(excelRow, existing) {
  // Prioridad 1: CDL # exacto (despues de normalizar)
  if (excelRow._norm_cdl) {
    const byCdl = existing.find(e => e._norm_cdl && e._norm_cdl === excelRow._norm_cdl);
    if (byCdl) return { match: byCdl, by: 'cdl_number' };
  }
  // Prioridad 2: nombre fuzzy
  if (excelRow._norm_name) {
    const byName = existing.find(e => namesMatch(excelRow._norm_name, e._norm_name));
    if (byName) return { match: byName, by: 'name_fuzzy' };
  }
  return null;
}

// ─── Pipeline principal ─────────────────────────────────────────

async function runImport(filepath, { commit = false, importedByUserId = null } = {}) {
  const fullPath = path.resolve(filepath);
  const data = await readExcel(fullPath);
  const allExcel = [...data.active.map(r => ({ ...r, _bucket: 'active' })),
                    ...data.terminated.map(r => ({ ...r, _bucket: 'terminated' }))];
  const existing = await loadExistingDrivers();
  const matchedDriverIds = new Set();

  const summary = {
    excel_active: data.active.length,
    excel_terminated: data.terminated.length,
    samsara_total: existing.length,
    matched: 0,
    excel_only: 0,
    samsara_only: 0,
    skipped_no_name_no_cdl: 0,
    by_cdl: 0,
    by_name_fuzzy: 0,
  };
  const matches = [];     // [{ excel_row, driver_id, by, fields_to_update }]
  const excelOnly = [];   // rows del Excel que no matchean

  for (const excel of allExcel) {
    if (!excel._norm_name && !excel._norm_cdl) {
      summary.skipped_no_name_no_cdl++;
      continue;
    }
    const m = findMatch(excel, existing);
    if (m) {
      summary.matched++;
      summary[m.by === 'cdl_number' ? 'by_cdl' : 'by_name_fuzzy']++;
      matchedDriverIds.add(m.match.id);
      matches.push({
        excel_row: excel.excel_row,
        driver_id: m.match.id,
        existing_name: m.match.full_name,
        excel_name: excel.full_name,
        by: m.by,
        active: excel._bucket === 'active' && /active/i.test(excel.status || 'active') ? 1 : 0,
        fields: {
          cdl_number: excel.cdl_number,
          cdl_state: excel.cdl_state,
          cdl_expiration: excel.cdl_expiration,
          medical_card_expiration: excel.medical_card_expiration,
          endorsements: excel.endorsements,
          phone: excel.phone,
          hire_date: excel.hire_date,
          company: excel.company,
          location: excel.location,
          division: excel.division,
          notes: excel.notes,
        },
      });
    } else {
      summary.excel_only++;
      excelOnly.push(excel);
    }
  }

  // Samsara-only: drivers en `existing` (que vienen de Samsara) que no
  // matchearon con ninguna fila del Excel.
  const samsaraOnly = existing.filter(e =>
    e.data_source !== 'excel' &&         // los que ya vinieron de Excel ignorar
    !matchedDriverIds.has(e.id)
  );
  summary.samsara_only = samsaraOnly.length;

  if (!commit) {
    return { summary, matches: matches.slice(0, 20), excel_only_sample: excelOnly.slice(0, 10), samsara_only_sample: samsaraOnly.slice(0, 10), commit: false };
  }

  // ─── Commit transaccional ───────────────────────────────────
  const batchId = 'imp_' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '_' + crypto.randomBytes(3).toString('hex');

  await db.transaction(async (conn) => {
    for (const m of matches) {
      const newSource = await getMergedSource(conn, m.driver_id);
      await conn.execute(
        `UPDATE drivers SET
           cdl_number = COALESCE(?, cdl_number),
           cdl_state = COALESCE(?, cdl_state),
           cdl_expiration = COALESCE(?, cdl_expiration),
           medical_card_expiration = COALESCE(?, medical_card_expiration),
           endorsements = COALESCE(?, endorsements),
           phone = COALESCE(?, phone),
           hire_date = COALESCE(?, hire_date),
           company = COALESCE(?, company),
           location = COALESCE(?, location),
           division = COALESCE(?, division),
           notes = COALESCE(?, notes),
           active = ?,
           data_source = ?,
           last_synced_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          m.fields.cdl_number, m.fields.cdl_state, m.fields.cdl_expiration,
          m.fields.medical_card_expiration, m.fields.endorsements,
          m.fields.phone, m.fields.hire_date, m.fields.company, m.fields.location,
          m.fields.division, m.fields.notes,
          m.active, newSource, m.driver_id,
        ]
      );
    }

    // Limpiar discrepancies viejas (regenerar cada import)
    await conn.execute(`DELETE FROM driver_import_discrepancies`);

    // Excel-only
    for (const r of excelOnly) {
      await conn.execute(
        `INSERT INTO driver_import_discrepancies
          (source, full_name, cdl_number, raw_row_json, reason, import_batch)
         VALUES ('excel_only', ?, ?, ?, ?, ?)`,
        [
          r.full_name,
          r.cdl_number,
          JSON.stringify({
            row: r.excel_row, status: r.status, bucket: r._bucket,
            cdl_expire: r.cdl_expiration, med_expire: r.medical_card_expiration,
          }),
          r._bucket === 'terminated'
            ? 'En Excel como Terminated, no esta en Samsara (esperado)'
            : 'En Excel como Active, NO esta en Samsara — verificar si esta trabajando',
          batchId,
        ]
      );
    }

    // Samsara-only
    for (const s of samsaraOnly) {
      await conn.execute(
        `INSERT INTO driver_import_discrepancies
          (source, full_name, cdl_number, raw_row_json, reason, import_batch)
         VALUES ('samsara_only', ?, ?, ?, ?, ?)`,
        [
          s.full_name,
          s.cdl_number,
          JSON.stringify({ samsara_id: s.samsara_id, driver_id: s.id }),
          'En Samsara (activo), NO esta en el Excel de compliance — falta cargar sus datos',
          batchId,
        ]
      );
    }
  });

  summary.batch_id = batchId;
  return { summary, matches_count: matches.length, excel_only_count: excelOnly.length, samsara_only_count: samsaraOnly.length, commit: true };
}

// Si un driver ya tenia data_source 'samsara' y le aplicamos Excel,
// queda 'samsara+excel' (mejor de los dos mundos).
async function getMergedSource(conn, driverId) {
  const [[row]] = await conn.execute(`SELECT data_source FROM drivers WHERE id = ?`, [driverId]);
  if (!row) return 'excel';
  if (row.data_source === 'samsara' || row.data_source === 'samsara+excel') return 'samsara+excel';
  return 'excel';
}

module.exports = {
  runImport,
  // exportados para tests / debug
  normName,
  normCdl,
  normState,
  parseDate,
  levenshtein,
  namesMatch,
};
