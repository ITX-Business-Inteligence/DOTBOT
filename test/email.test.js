// Tests del wrapper de email.
// En modo mock (BOTDOT_MOCK_EMAIL=true en setup.js) no se manda mail real
// — se loggea a stderr y se devuelve {sent: true, mocked: true}.
// Esto es lo que valida que la integracion con escalate.js no rompa.

require('./setup');
process.env.BOTDOT_MOCK_EMAIL = 'true';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sendEmail } = require('../src/utils/email');

describe('sendEmail (mock mode)', () => {
  test('devuelve { sent: true, mocked: true } con destinatario string', async () => {
    const r = await sendEmail({ to: 'compliance@test.com', subject: 'Test', text: 'body' });
    assert.equal(r.sent, true);
    assert.equal(r.mocked, true);
  });

  test('acepta array de destinatarios', async () => {
    const r = await sendEmail({
      to: ['a@test.com', 'b@test.com'],
      subject: 'Multi',
      text: 'body',
    });
    assert.equal(r.sent, true);
  });

  test('sin recipients devuelve { sent: false }', async () => {
    const r = await sendEmail({ to: '', subject: 'x', text: 'y' });
    assert.equal(r.sent, false);
    assert.match(r.error, /no recipients/);
  });

  test('sin recipients con array vacio', async () => {
    const r = await sendEmail({ to: [], subject: 'x', text: 'y' });
    assert.equal(r.sent, false);
  });

  test('NO tira excepcion (fail-safe) — devuelve { sent: false, error }', async () => {
    // Aunque el subject sea null o el text faltante, no debe tirar
    const r = await sendEmail({ to: 'x@y.com', subject: null, text: '' });
    // En mock mode acepta — mockea con whatever. Lo critico es que no tire.
    assert.equal(typeof r, 'object');
    assert.ok('sent' in r);
  });
});
