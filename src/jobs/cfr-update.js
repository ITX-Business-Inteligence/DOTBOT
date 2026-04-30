// Job de actualizacion del CFR.
//
// Flujo:
//   1. Fetch de Parts 380-399 desde eCFR.gov
//   2. Para cada seccion: comparar content_hash con la version actual en DB
//      - Hash igual → unchanged (no hace nada)
//      - Hash distinto → INSERT new version, marcar la vieja superseded
//      - Section nueva → INSERT como nueva
//   3. Si hubo cambios (no en baseline): email a compliance + audit log
//   4. Regenerar data/cfrs/cfr-index.json desde DB para que el bot lo use
//
// Modos:
//   - baseline: primer run cuando cfr_versions esta vacia. INSERT all sin
//     audit/email (es la carga inicial, no son "cambios").
//   - update: runs subsiguientes. INSERT solo lo nuevo/cambiado, audit/email.

const fs = require('fs');
const path = require('path');
const db = require('../db/pool');
const config = require('../config');
const logger = require('../utils/logger');
const { fetchAllParts } = require('../utils/cfr-fetcher');
const { sendEmail } = require('../utils/email');
const { appendAudit } = require('../db/audit-chain');

const log = logger.child({ job: 'cfr-update' });

const CFR_INDEX_PATH = path.join(__dirname, '..', '..', 'data', 'cfrs', 'cfr-index.json');

async function isBaseline() {
  const [row] = await db.query(`SELECT COUNT(*) AS n FROM cfr_versions`);
  return row.n === 0;
}

async function getCurrentByHash() {
  const rows = await db.query(
    `SELECT id, section, content_hash FROM cfr_versions WHERE is_current = 1`
  );
  const map = new Map();
  for (const r of rows) map.set(r.section, r);
  return map;
}

async function regenerateJsonFromDb() {
  const rows = await db.query(
    `SELECT section, part, title, text, keywords_json
     FROM cfr_versions
     WHERE is_current = 1
     ORDER BY part ASC, section ASC`
  );
  const out = rows.map(r => ({
    section: r.section,
    part: r.part,
    title: r.title,
    text: r.text,
    keywords: r.keywords_json ? JSON.parse(r.keywords_json) : [],
  }));
  fs.mkdirSync(path.dirname(CFR_INDEX_PATH), { recursive: true });
  fs.writeFileSync(CFR_INDEX_PATH, JSON.stringify(out));
  return out.length;
}

async function getRecipients() {
  if (config.email.escalationsTo) {
    return config.email.escalationsTo.split(',').map(s => s.trim()).filter(Boolean);
  }
  const rows = await db.query(
    `SELECT email FROM users WHERE role = 'compliance' AND active = 1`
  );
  return rows.map(r => r.email);
}

async function sendChangesEmail(runId, changes, addedSections, issueDate) {
  if (!changes.length && !addedSections.length) return;
  const to = await getRecipients();
  if (!to.length) return;

  const totalNotices = changes.length + addedSections.length;
  const subject = `🚨 BOTDOT — ${totalNotices} cambios en 49 CFR (issue ${issueDate})`;

  const linesChanged = changes.map(c =>
    `  • ${c.section}: ${c.title}\n    (texto modificado vs version del ${c.previous_fetched_at})`
  ).join('\n');
  const linesAdded = addedSections.map(s =>
    `  • ${s.section}: ${s.title}\n    (NUEVA seccion)`
  ).join('\n');

  const text =
`Cambios detectados en 49 CFR Parts 380-399 (issue ${issueDate}):

${changes.length} secciones modificadas:
${linesChanged || '  (ninguna)'}

${addedSections.length} secciones nuevas:
${linesAdded || '  (ninguna)'}

El bot ya esta usando las versiones nuevas. Las versiones anteriores quedan en
el historial (cfr_versions) para audit trail.

Revisar impacto operacional en: ${config.publicUrl}/settings.html#sistema

— BOTDOT (no respondas a este email)
`;

  const result = await sendEmail({ to, subject, text });
  if (result.sent) {
    await db.query(
      `UPDATE cfr_fetch_runs SET email_sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [runId]
    );
  }
}

/**
 * Corre el flujo completo. Devuelve { run_id, status, summary }.
 * Si esta corriendo en baseline, NO emite emails ni audit (carga inicial).
 */
async function runCfrUpdate({ trigger = 'cron', issueDate = null } = {}) {
  const baseline = await isBaseline();
  const triggerSource = baseline ? 'baseline' : trigger;

  // Crear run record
  const [insertResult] = await db.pool.execute(
    `INSERT INTO cfr_fetch_runs (status, trigger_source) VALUES ('running', ?)`,
    [triggerSource]
  );
  const runId = insertResult.insertId;
  const t0 = Date.now();

  try {
    const fetchResult = await fetchAllParts({ issueDate, log: m => log.info(m) });
    const fetched = fetchResult.sections;
    const issue = fetchResult.issue_date;

    const currentMap = await getCurrentByHash();

    let added = 0, changed = 0, unchanged = 0;
    const changes = [];       // { section, title, previous_fetched_at }
    const addedSections = []; // { section, title }

    await db.transaction(async (conn) => {
      for (const sec of fetched) {
        const existing = currentMap.get(sec.section);

        if (existing && existing.content_hash === sec.content_hash) {
          unchanged++;
          continue;
        }

        if (existing) {
          // Cambio: marcar la vieja como superseded
          await conn.execute(
            `UPDATE cfr_versions
             SET is_current = 0, superseded_at = CURRENT_TIMESTAMP(6)
             WHERE id = ?`,
            [existing.id]
          );
          // Capturar info de la version vieja para el email
          const [[old]] = await conn.execute(
            `SELECT title, fetched_at FROM cfr_versions WHERE id = ?`,
            [existing.id]
          );
          changes.push({
            section: sec.section,
            title: sec.title,
            previous_fetched_at: old.fetched_at,
          });
          changed++;
        } else {
          addedSections.push({ section: sec.section, title: sec.title });
          added++;
        }

        await conn.execute(
          `INSERT INTO cfr_versions
             (section, part, title, text, keywords_json, content_hash, issue_date, is_current)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE
             is_current = 1,
             superseded_at = NULL`,
          [
            sec.section, sec.part, sec.title, sec.text,
            JSON.stringify(sec.keywords || []), sec.content_hash,
            issue,
          ]
        );
      }
    });

    // Regenerar JSON consumido por cfr.js
    await regenerateJsonFromDb();

    const duration = Date.now() - t0;
    const finalStatus = (changes.length === 0 && added === 0) ? 'noop' : 'success';

    await db.query(
      `UPDATE cfr_fetch_runs
       SET finished_at = CURRENT_TIMESTAMP(6),
           issue_date = ?,
           status = ?,
           parts_fetched = ?,
           sections_total = ?,
           sections_added = ?,
           sections_changed = ?,
           sections_unchanged = ?,
           duration_ms = ?
       WHERE id = ?`,
      [issue, finalStatus, 18, fetched.length, added, changed, unchanged, duration, runId]
    );

    // En baseline NO mandamos email ni audit (es la carga inicial)
    if (!baseline && (changes.length > 0 || addedSections.length > 0)) {
      // Audit log
      try {
        await appendAudit({
          user_id: 1,
          action_type: 'cfr_update',
          subject_type: 'cfr',
          subject_id: issue,
          decision: 'informational',
          reasoning: `CFR update aplicado: ${changes.length} secciones modificadas, ${added} nuevas (issue ${issue})`,
          evidence: {
            issue_date: issue,
            changes: changes.map(c => ({ section: c.section, title: c.title })),
            added: addedSections,
            unchanged_count: unchanged,
          },
        });
      } catch (err) { log.error({ err }, 'audit failed'); }

      // Email a compliance
      try {
        await sendChangesEmail(runId, changes, addedSections, issue);
      } catch (err) { log.error({ err }, 'email failed'); }
    }

    return {
      run_id: runId,
      status: finalStatus,
      issue_date: issue,
      sections_total: fetched.length,
      sections_added: added,
      sections_changed: changed,
      sections_unchanged: unchanged,
      duration_ms: duration,
      baseline,
    };
  } catch (e) {
    const duration = Date.now() - t0;
    await db.query(
      `UPDATE cfr_fetch_runs
       SET finished_at = CURRENT_TIMESTAMP(6), status = 'error',
           duration_ms = ?, error_message = ?
       WHERE id = ?`,
      [duration, String(e.message || e).slice(0, 1000), runId]
    );
    log.error({ err: e }, 'update failed');
    throw e;
  }
}

module.exports = { runCfrUpdate, regenerateJsonFromDb, isBaseline };
