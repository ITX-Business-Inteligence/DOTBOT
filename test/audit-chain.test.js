// Tests de la logica pura del hash chain de audit_log.
// No tocan DB. Verifican canonicalize, computeRowHash, isoSeconds.
//
// Para tests con DB real (insert + verify + tamper detection) hace falta
// una test DB y queda como suite separada. Si modificas alguna funcion
// aqui, los hashes calculados en filas existentes dejan de coincidir, asi
// que el cambio probablemente requiere una nueva schema_version en
// buildHashable.

require('./setup');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalize,
  computeRowHash,
  buildHashable,
  isoSeconds,
  GENESIS_HASH,
} = require('../src/db/audit-chain');

describe('canonicalize — determinismo', () => {
  test('orden de keys no afecta el output', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    assert.equal(a, b);
  });

  test('keys ordenadas alfabeticamente', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  test('null y undefined producen "null"', () => {
    assert.equal(canonicalize(null), 'null');
    assert.equal(canonicalize(undefined), 'null');
  });

  test('strings se escapan como JSON', () => {
    assert.equal(canonicalize('hola'), '"hola"');
    assert.equal(canonicalize('con "comillas"'), '"con \\"comillas\\""');
  });

  test('numeros se serializan crudos', () => {
    assert.equal(canonicalize(42), '42');
    assert.equal(canonicalize(-3.14), '-3.14');
    assert.equal(canonicalize(0), '0');
  });

  test('booleans correctos', () => {
    assert.equal(canonicalize(true), 'true');
    assert.equal(canonicalize(false), 'false');
  });

  test('arrays preservan orden', () => {
    assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
    assert.equal(canonicalize([1, 2, 3]), '[1,2,3]');
  });

  test('objetos anidados se canonicalizan recursivo', () => {
    const a = canonicalize({ x: { b: 2, a: 1 }, y: [3, 1, 2] });
    const b = canonicalize({ y: [3, 1, 2], x: { a: 1, b: 2 } });
    assert.equal(a, b);
  });

  test('Date se serializa como ISO string', () => {
    const d = new Date('2026-04-29T12:00:00Z');
    assert.equal(canonicalize(d), '"2026-04-29T12:00:00.000Z"');
  });

  test('numero no finito tira error', () => {
    assert.throws(() => canonicalize(Infinity));
    assert.throws(() => canonicalize(NaN));
  });
});

describe('computeRowHash', () => {
  function rowFor(overrides = {}) {
    return buildHashable({
      user_id: 1,
      conversation_id: 10,
      action_type: 'assignment_check',
      subject_type: 'driver',
      subject_id: 'sams_123',
      decision: 'proceed',
      cfr_cited: '49 CFR 395.3',
      reasoning: 'fits HOS window',
      evidence: { drive: 600 },
      override_reason: null,
      created_at_iso: '2026-04-29T12:00:00Z',
      prev_hash: GENESIS_HASH,
      ...overrides,
    });
  }

  test('produce SHA-256 hex de 64 chars', () => {
    const h = computeRowHash(rowFor());
    assert.match(h, /^[a-f0-9]{64}$/);
  });

  test('mismo input produce mismo hash (determinista)', () => {
    assert.equal(computeRowHash(rowFor()), computeRowHash(rowFor()));
  });

  test('cambiar prev_hash cambia el hash', () => {
    const a = computeRowHash(rowFor({ prev_hash: GENESIS_HASH }));
    const b = computeRowHash(rowFor({ prev_hash: 'a'.repeat(64) }));
    assert.notEqual(a, b);
  });

  test('cambiar reasoning cambia el hash', () => {
    const a = computeRowHash(rowFor({ reasoning: 'X' }));
    const b = computeRowHash(rowFor({ reasoning: 'Y' }));
    assert.notEqual(a, b);
  });

  test('cambiar evidence cambia el hash', () => {
    const a = computeRowHash(rowFor({ evidence: { x: 1 } }));
    const b = computeRowHash(rowFor({ evidence: { x: 2 } }));
    assert.notEqual(a, b);
  });

  test('cambiar created_at cambia el hash', () => {
    const a = computeRowHash(rowFor({ created_at_iso: '2026-04-29T12:00:00Z' }));
    const b = computeRowHash(rowFor({ created_at_iso: '2026-04-29T12:00:01Z' }));
    assert.notEqual(a, b);
  });

  test('orden de keys en evidence NO afecta el hash', () => {
    const a = computeRowHash(rowFor({ evidence: { a: 1, b: 2 } }));
    const b = computeRowHash(rowFor({ evidence: { b: 2, a: 1 } }));
    assert.equal(a, b);
  });
});

describe('buildHashable — schema_version invariante', () => {
  test('siempre incluye schema_version=1 (cambiar esto rompe verificacion historica)', () => {
    const h = buildHashable({
      user_id: 1,
      action_type: 'x',
      decision: 'proceed',
      reasoning: 'r',
      created_at_iso: '2026-01-01T00:00:00Z',
      prev_hash: GENESIS_HASH,
    });
    assert.equal(h.schema_version, 1);
  });

  test('campos faltantes vienen como null (no undefined)', () => {
    const h = buildHashable({
      user_id: 1,
      action_type: 'x',
      decision: 'proceed',
      reasoning: 'r',
      created_at_iso: '2026-01-01T00:00:00Z',
      prev_hash: GENESIS_HASH,
    });
    assert.equal(h.subject_type, null);
    assert.equal(h.subject_id, null);
    assert.equal(h.cfr_cited, null);
    assert.equal(h.evidence, null);
    assert.equal(h.override_reason, null);
    assert.equal(h.conversation_id, null);
  });
});

describe('isoSeconds', () => {
  test('trunca milisegundos a segundos', () => {
    assert.equal(isoSeconds(new Date('2026-04-29T12:34:56.789Z')), '2026-04-29T12:34:56Z');
  });

  test('Date sin fraccion se preserva', () => {
    assert.equal(isoSeconds(new Date('2026-04-29T12:34:56Z')), '2026-04-29T12:34:56Z');
  });

  test('roundtrip: parsear y volver a iso es estable', () => {
    const a = isoSeconds(new Date('2026-04-29T12:34:56.500Z'));
    const b = isoSeconds(new Date(a));
    assert.equal(a, b);
  });
});

describe('GENESIS_HASH', () => {
  test('es 64 ceros', () => {
    assert.equal(GENESIS_HASH, '0'.repeat(64));
    assert.equal(GENESIS_HASH.length, 64);
  });
});
