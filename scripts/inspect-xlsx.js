// Script de inspeccion del Excel de drivers. Imprime sheets, headers
// y la primera fila para entender el shape antes de mapear al schema.
//
// Uso: node scripts/inspect-xlsx.js "data/imports/DOT Driver List.xlsx"

const ExcelJS = require('exceljs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/inspect-xlsx.js <path-al-xlsx>');
  process.exit(1);
}

function cellDisplay(cell) {
  const v = cell?.value;
  if (v == null) return '(null)';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (v.result !== undefined) return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text).join('');
    return JSON.stringify(v);
  }
  return String(v);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));

  console.log(`\nArchivo: ${file}`);
  console.log(`Sheets:  ${wb.worksheets.length} (${wb.worksheets.map(w => w.name).join(', ')})`);

  for (const ws of wb.worksheets) {
    console.log(`\n========== Sheet: "${ws.name}" ==========`);
    console.log(`Range: ${ws.dimensions?.model?.address || '?'}  (${ws.rowCount} filas, ${ws.columnCount} cols)`);

    if (ws.rowCount === 0) { console.log('(vacio)'); continue; }

    const headerRow = ws.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber - 1] = cell.value != null ? String(cell.value) : null;
    });

    console.log(`\nHeaders (fila 1):`);
    headers.forEach((h, i) => console.log(`  [${i}] ${h ?? '(vacio)'}`));

    // Hasta 2 filas de muestra
    for (let rn = 2; rn <= Math.min(3, ws.rowCount); rn++) {
      const row = ws.getRow(rn);
      console.log(`\nMuestra fila ${rn}:`);
      headers.forEach((h, i) => {
        const cell = row.getCell(i + 1);
        console.log(`  ${h ?? '[col' + i + ']'}: ${cellDisplay(cell)}`);
      });
    }

    console.log(`\nTotal data rows (excluyendo header): ${ws.rowCount - 1}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
