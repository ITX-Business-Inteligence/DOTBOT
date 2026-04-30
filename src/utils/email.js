// Wrapper de email usando nodemailer.
//
// En dev (BOTDOT_MOCK_EMAIL=true o SMTP no configurado) loggea a stderr
// en vez de enviar. En prod se conecta a SMTP real (gmail/outlook/SES/
// postmark — cualquiera que hable SMTP).
//
// Diseñado para ser fail-safe: si SMTP cae, NO bloqueamos al chat — el
// audit log y la tabla escalations son la fuente de verdad. Email es
// best-effort.

const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('./logger');

const log = logger.child({ component: 'email' });

let transporter = null;

function getTransporter() {
  if (config.email.mock) return null;
  if (transporter) return transporter;
  const { host, port, secure, user, pass } = config.email.smtp;
  transporter = nodemailer.createTransport({
    host, port, secure,
    auth: user && pass ? { user, pass } : undefined,
  });
  return transporter;
}

/**
 * Envia un email. Devuelve { sent, error } — nunca tira (fail-safe).
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.text       texto plano
 * @param {string} [opts.html]     opcional HTML
 */
async function sendEmail({ to, subject, text, html }) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  if (!recipients) return { sent: false, error: 'no recipients' };

  if (config.email.mock) {
    log.warn({ to: recipients, subject }, 'EMAIL MOCKED — would send');
    log.debug({ body: text }, 'EMAIL MOCKED body');
    return { sent: true, mocked: true };
  }

  try {
    const t = getTransporter();
    if (!t) return { sent: false, error: 'transporter not configured' };
    const info = await t.sendMail({
      from: config.email.from,
      to: recipients,
      subject,
      text,
      html,
    });
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    log.error({ err: e, to: recipients, subject }, 'send failed');
    return { sent: false, error: e.message };
  }
}

module.exports = { sendEmail };
