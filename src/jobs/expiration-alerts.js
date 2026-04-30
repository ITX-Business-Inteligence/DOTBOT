// Job de alertas proactivas de expiracion (CDL / medical card).
//
// Logica:
//   - Por cada driver activo con cdl_expiration o medical_card_expiration
//     en el horizonte, calcular dias_restantes y bucket-ear contra
//     thresholds: [60, 30, 14, 7, 0, -1] (0=hoy, -1=ya vencido).
//   - Solo el threshold MAS ALTO que el driver acaba de cruzar dispara
//     una nueva notificacion. UNIQUE(kind, subject_id, threshold) evita
//     duplicados en re-runs.
//   - Email a compliance + audit + INSERT a notifications.
//
// Cron: diario 6 AM por defecto. En dev se puede correr ad-hoc via
// /api/admin/jobs/run/expiration-alerts (admin only).

const db = require('../db/pool');
const config = require('../config');
const logger = require('../utils/logger');
const { sendEmail } = require('../utils/email');
const { appendAudit } = require('../db/audit-chain');

const log = logger.child({ job: 'expiration-alerts' });

// thresholds en dias. -1 significa "ya vencido (cualquier cantidad)".
const THRESHOLDS = [60, 30, 14, 7, 0, -1];

function urgencyForThreshold(t) {
  if (t < 0)   return 'critical'; // ya vencido
  if (t === 0) return 'critical'; // vence hoy
  if (t <= 7)  return 'critical';
  if (t <= 14) return 'high';
  if (t <= 30) return 'medium';
  return 'low';                    // 31-60
}

// Decide en que bucket cae un driver dado sus dias restantes. Solo el
// MAS ESTRICTO aplica (si quedan 25 dias, va al bucket 30, no al 60).
function bucketFor(days) {
  if (days == null) return null;
  if (days < 0)   return -1;
  if (days === 0) return 0;
  if (days <= 7)  return 7;
  if (days <= 14) return 14;
  if (days <= 30) return 30;
  if (days <= 60) return 60;
  return null;                     // fuera del horizonte
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

async function processOne({ driver, kind, expiration, days }) {
  const bucket = bucketFor(days);
  if (bucket === null) return null;  // fuera de horizonte

  const urgency = urgencyForThreshold(bucket);
  const isExpired = bucket < 0 || bucket === 0;
  const finalKind = isExpired
    ? (kind === 'cdl_expiring' ? 'cdl_expired' : 'medical_expired')
    : kind;

  const fieldLabel = kind === 'cdl_expiring' ? 'CDL' : 'Medical Card';
  const dayLabel = days < 0 ? `vencido hace ${Math.abs(days)} dias`
                  : days === 0 ? 'vence HOY'
                  : days === 1 ? 'vence manana'
                  : `vence en ${days} dias`;

  const title = `${fieldLabel} de ${driver.full_name}: ${dayLabel}`;
  const body =
    `Driver: ${driver.full_name} (id=${driver.id}, samsara_id=${driver.samsara_id || 'sin samsara_id'})\n` +
    `Campo: ${fieldLabel}\n` +
    `Fecha de expiracion: ${expiration}\n` +
    `Dias restantes: ${days}\n` +
    `Urgencia: ${urgency}\n` +
    `Threshold cruzado: ${bucket}d\n\n` +
    `Resolver / dismiss en: ${config.publicUrl}/notifications.html`;

  // INSERT con ON DUPLICATE KEY: si ya existe (kind, driver, threshold),
  // no hacemos nada — el UNIQUE garantiza unicidad por bucket.
  let inserted;
  try {
    const result = await db.query(
      `INSERT INTO notifications
        (kind, subject_type, subject_id, threshold, urgency, title, body)
       VALUES (?, 'driver', ?, ?, ?, ?, ?)`,
      [finalKind, driver.id, bucket, urgency, title, body]
    );
    inserted = result.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return null;  // ya notificado en este bucket
    throw e;
  }

  // Audit + email son best-effort; si fallan no rompemos el job
  try {
    await appendAudit({
      user_id: 1,                  // admin#1 como sistema (el job no tiene user)
      action_type: 'notification_emitted',
      subject_type: 'driver',
      subject_id: String(driver.id),
      decision: 'informational',
      reasoning: title,
      evidence: { kind: finalKind, threshold: bucket, urgency, expiration, days },
    });
  } catch (err) { log.error({ err }, 'audit failed'); }

  // Enviar email solo a critical / high. low/medium quedan en dashboard
  // para no spamear inbox de compliance.
  if (urgency === 'critical' || urgency === 'high') {
    try {
      const to = await getRecipients();
      if (to.length) {
        const subject = `${urgency === 'critical' ? '🚨' : '⚠️'} BOTDOT — ${title}`;
        const result = await sendEmail({ to, subject, text: body });
        await db.query(
          `UPDATE notifications
           SET email_sent_at = ?, email_recipients = ?, email_error = ?
           WHERE id = ?`,
          [
            result.sent ? new Date() : null,
            to.join(','),
            result.sent ? null : (result.error || 'unknown'),
            inserted,
          ]
        );
      }
    } catch (err) { log.error({ err }, 'email failed'); }
  }

  return inserted;
}

async function runExpirationAlerts() {
  const t0 = Date.now();
  const drivers = await db.query(
    `SELECT id, samsara_id, full_name, cdl_expiration, medical_card_expiration,
            DATEDIFF(cdl_expiration, CURDATE())          AS cdl_days,
            DATEDIFF(medical_card_expiration, CURDATE()) AS medical_days
     FROM drivers
     WHERE active = 1
       AND (
         (cdl_expiration IS NOT NULL AND cdl_expiration <= DATE_ADD(CURDATE(), INTERVAL 60 DAY))
         OR
         (medical_card_expiration IS NOT NULL AND medical_card_expiration <= DATE_ADD(CURDATE(), INTERVAL 60 DAY))
       )`
  );

  let inserted = 0;
  let scanned = drivers.length;

  for (const d of drivers) {
    if (d.cdl_expiration) {
      const id = await processOne({
        driver: d,
        kind: 'cdl_expiring',
        expiration: d.cdl_expiration,
        days: d.cdl_days,
      });
      if (id) inserted++;
    }
    if (d.medical_card_expiration) {
      const id = await processOne({
        driver: d,
        kind: 'medical_expiring',
        expiration: d.medical_card_expiration,
        days: d.medical_days,
      });
      if (id) inserted++;
    }
  }

  const elapsed = Date.now() - t0;
  log.info({ scanned, inserted, elapsed_ms: elapsed }, 'expiration scan completed');
  return { scanned, inserted, elapsed_ms: elapsed };
}

module.exports = { runExpirationAlerts, bucketFor, urgencyForThreshold };
