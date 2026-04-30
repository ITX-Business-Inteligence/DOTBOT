// Tests de la logica pura del job de expiration alerts.
// La parte que toca DB / email queda fuera (smoke test integration).

require('./setup');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { bucketFor, urgencyForThreshold } = require('../src/jobs/expiration-alerts');

describe('bucketFor — agrupa dias en thresholds', () => {
  test('null o undefined → null', () => {
    assert.equal(bucketFor(null), null);
    assert.equal(bucketFor(undefined), null);
  });

  test('dias negativos → -1 (ya vencido)', () => {
    assert.equal(bucketFor(-1), -1);
    assert.equal(bucketFor(-100), -1);
  });

  test('vence hoy → 0', () => {
    assert.equal(bucketFor(0), 0);
  });

  test('1-7 dias → bucket 7', () => {
    assert.equal(bucketFor(1), 7);
    assert.equal(bucketFor(5), 7);
    assert.equal(bucketFor(7), 7);
  });

  test('8-14 dias → bucket 14', () => {
    assert.equal(bucketFor(8), 14);
    assert.equal(bucketFor(14), 14);
  });

  test('15-30 dias → bucket 30', () => {
    assert.equal(bucketFor(15), 30);
    assert.equal(bucketFor(30), 30);
  });

  test('31-60 dias → bucket 60', () => {
    assert.equal(bucketFor(31), 60);
    assert.equal(bucketFor(60), 60);
  });

  test('mas de 60 dias → null (fuera de horizonte)', () => {
    assert.equal(bucketFor(61), null);
    assert.equal(bucketFor(365), null);
  });
});

describe('urgencyForThreshold', () => {
  test('vencido → critical', () => {
    assert.equal(urgencyForThreshold(-1), 'critical');
  });

  test('hoy → critical', () => {
    assert.equal(urgencyForThreshold(0), 'critical');
  });

  test('≤7 → critical', () => {
    assert.equal(urgencyForThreshold(7), 'critical');
  });

  test('≤14 → high', () => {
    assert.equal(urgencyForThreshold(14), 'high');
  });

  test('≤30 → medium', () => {
    assert.equal(urgencyForThreshold(30), 'medium');
  });

  test('≤60 → low', () => {
    assert.equal(urgencyForThreshold(60), 'low');
  });
});
