// Tests de la logica HOS pura (49 CFR 395.3).
// Estos tests son CRITICOS — una recomendacion HOS incorrecta pone al
// carrier en violacion. Si modificas evaluateHosCompliance, todos estos
// tests deben seguir pasando.

require('./setup');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHosCompliance } = require('../src/agent/tools/samsara');

function freshDriver(overrides = {}) {
  return {
    driverName: 'Test Driver',
    driverId: 'sams_001',
    clockState: 'on_duty',
    drive: { remainingMin: 11 * 60, ...overrides.drive },
    duty:  { remainingMin: 14 * 60, ...overrides.duty },
    cycle: { remainingMin: 70 * 60, ...overrides.cycle },
  };
}

describe('evaluateHosCompliance — escenarios PROCEED', () => {
  test('driver fresco con load chico = proceed sin violaciones', () => {
    const r = evaluateHosCompliance(freshDriver(), { estimated_drive_minutes: 60 });
    assert.equal(r.decision, 'proceed');
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.cfr_basis, []);
  });

  test('driver fresco aprovechando casi todo el dia = proceed', () => {
    const r = evaluateHosCompliance(freshDriver(), {
      estimated_drive_minutes: 10 * 60,        // 10 horas drive
      load_window_minutes: 13 * 60,            // 13 horas window (cabe en 14)
    });
    assert.equal(r.decision, 'proceed');
    assert.equal(r.violations.length, 0);
  });

  test('window default = drive + 120min cuando no se especifica', () => {
    // 8h drive + 2h default buffer = 10h window. Driver fresh tiene 14h duty: cabe.
    const r = evaluateHosCompliance(freshDriver(), { estimated_drive_minutes: 8 * 60 });
    assert.equal(r.decision, 'proceed');
  });
});

describe('evaluateHosCompliance — escenarios DECLINE', () => {
  test('drive limit excedido por mas de 60min = decline con cita 395.3(a)(3)', () => {
    const hos = freshDriver({ drive: { remainingMin: 30 } });
    const r = evaluateHosCompliance(hos, { estimated_drive_minutes: 200 });
    assert.equal(r.decision, 'decline');
    const v = r.violations.find(v => v.cfr === '49 CFR 395.3(a)(3)');
    assert.ok(v, 'falta violacion de drive limit');
    assert.equal(v.gap_min, 170);
    assert.equal(v.rule, 'Driving limit (11 horas)');
  });

  test('duty limit excedido = decline con cita 395.3(a)(2)', () => {
    const hos = freshDriver({ duty: { remainingMin: 60 } });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 30,
      load_window_minutes: 4 * 60,  // 4 horas window contra 1h disponible
    });
    assert.equal(r.decision, 'decline');
    const v = r.violations.find(v => v.cfr === '49 CFR 395.3(a)(2)');
    assert.ok(v);
    assert.equal(v.gap_min, 4 * 60 - 60);
  });

  test('cycle limit excedido = decline con cita 395.3(b)', () => {
    const hos = freshDriver({ cycle: { remainingMin: 30 } });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 60,
      load_window_minutes: 3 * 60,
    });
    assert.equal(r.decision, 'decline');
    const v = r.violations.find(v => v.cfr === '49 CFR 395.3(b)');
    assert.ok(v);
  });

  test('multiples violaciones simultaneas = todas las CFR aparecen en cfr_basis', () => {
    const hos = freshDriver({
      drive: { remainingMin: 30 },
      duty: { remainingMin: 60 },
      cycle: { remainingMin: 90 },
    });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 5 * 60,
      load_window_minutes: 8 * 60,
    });
    assert.equal(r.decision, 'decline');
    assert.equal(r.violations.length, 3);
    assert.ok(r.cfr_basis.includes('49 CFR 395.3(a)(3)'));
    assert.ok(r.cfr_basis.includes('49 CFR 395.3(a)(2)'));
    assert.ok(r.cfr_basis.includes('49 CFR 395.3(b)'));
  });
});

describe('evaluateHosCompliance — escenarios CONDITIONAL', () => {
  test('todas las violaciones < 60min = conditional', () => {
    const hos = freshDriver({
      drive: { remainingMin: 60 },
      duty: { remainingMin: 90 },
    });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 80,            // gap 20
      load_window_minutes: 130,               // gap 40
    });
    assert.equal(r.decision, 'conditional');
    assert.ok(r.violations.every(v => v.gap_min < 60));
  });

  test('frontera: gap exactamente 59 = conditional', () => {
    const hos = freshDriver({ drive: { remainingMin: 100 } });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 159,
      load_window_minutes: 200,
    });
    assert.equal(r.decision, 'conditional');
  });

  test('frontera: gap 60 = decline (no conditional)', () => {
    const hos = freshDriver({ drive: { remainingMin: 100 } });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 160,
      load_window_minutes: 200,
    });
    assert.equal(r.decision, 'decline');
  });

  test('una violacion <60 y otra >60 = decline (no conditional)', () => {
    const hos = freshDriver({
      drive: { remainingMin: 100 },     // gap 30 (< 60)
      duty: { remainingMin: 100 },      // gap 100 (>= 60)
    });
    const r = evaluateHosCompliance(hos, {
      estimated_drive_minutes: 130,
      load_window_minutes: 200,
    });
    assert.equal(r.decision, 'decline');
  });
});

describe('evaluateHosCompliance — output structure', () => {
  test('siempre devuelve disclaimer legal', () => {
    const r = evaluateHosCompliance(freshDriver(), { estimated_drive_minutes: 60 });
    assert.match(r.disclaimer, /no constituye asesoria legal/);
  });

  test('hos_snapshot pasa el snapshot completo (para audit_log)', () => {
    const hos = freshDriver();
    const r = evaluateHosCompliance(hos, { estimated_drive_minutes: 60 });
    assert.equal(r.hos_snapshot, hos);
  });

  test('load_reference se preserva', () => {
    const r = evaluateHosCompliance(freshDriver(), {
      estimated_drive_minutes: 60,
      load_reference: 'LOAD-12345',
    });
    assert.equal(r.load_reference, 'LOAD-12345');
  });

  test('load_reference null cuando no se pasa', () => {
    const r = evaluateHosCompliance(freshDriver(), { estimated_drive_minutes: 60 });
    assert.equal(r.load_reference, null);
  });

  test('cada violacion incluye detail descriptivo', () => {
    const hos = freshDriver({ drive: { remainingMin: 30 } });
    const r = evaluateHosCompliance(hos, { estimated_drive_minutes: 200 });
    for (const v of r.violations) {
      assert.ok(typeof v.detail === 'string' && v.detail.length > 0);
      assert.ok(typeof v.rule === 'string' && v.rule.length > 0);
      assert.ok(typeof v.gap_min === 'number' && v.gap_min > 0);
    }
  });
});
