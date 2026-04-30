// Helper compartido para los sync handlers. Cada corrida queda registrada
// en sync_runs (start/finish/duration/status/records).

const db = require('../db/pool');
const logger = require('../utils/logger');
const { isMock } = require('../integrations/samsara-client');

const log = logger.child({ component: 'sync-runner' });

async function runSync(resource, fn) {
  const [insertResult] = await db.pool.execute(
    `INSERT INTO sync_runs (resource, status, source) VALUES (?, 'running', ?)`,
    [resource, isMock ? 'mock' : 'live']
  );
  const runId = insertResult.insertId;
  const t0 = Date.now();

  try {
    const records = await fn();
    const duration = Date.now() - t0;
    await db.query(
      `UPDATE sync_runs
       SET finished_at = CURRENT_TIMESTAMP(6), status = 'success',
           records_synced = ?, duration_ms = ?
       WHERE id = ?`,
      [records || 0, duration, runId]
    );
    return { ok: true, records, duration_ms: duration };
  } catch (e) {
    const duration = Date.now() - t0;
    await db.query(
      `UPDATE sync_runs
       SET finished_at = CURRENT_TIMESTAMP(6), status = 'error',
           duration_ms = ?, error_message = ?
       WHERE id = ?`,
      [duration, String(e.message || e).slice(0, 1000), runId]
    );
    log.error({ err: e, resource }, `sync ${resource} failed`);
    return { ok: false, error: e.message, duration_ms: duration };
  }
}

module.exports = { runSync };
