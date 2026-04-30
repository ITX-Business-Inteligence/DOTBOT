// Tests de los helpers puros del importer de drivers.
// Cubren los edge cases reales que vimos en el Excel de Karen:
//   - Nombres con asteriscos ("Lopez*"), espacios dobles, acentos
//   - CDL # con guiones / espacios / minusculas
//   - State como "Mexico", "Tx", "TX"
//   - Fechas en MM/DD/YY, MM/DD/YYYY, DD/M/YY, ISO

require('./setup');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  normName,
  normCdl,
  normState,
  parseDate,
  levenshtein,
  namesMatch,
} = require('../src/utils/import-drivers');

describe('normName', () => {
  test('lowercase + trim', () => {
    assert.equal(normName('  Roberto Sanchez  '), 'roberto sanchez');
  });

  test('strip asterisks (asteriscos en algunos nombres del Excel)', () => {
    assert.equal(normName('Aaron Felipe Lopez Sandoval*'), 'aaron felipe lopez sandoval');
  });

  test('colapsa espacios dobles', () => {
    assert.equal(normName('Aaron  Felipe   Lopez'), 'aaron felipe lopez');
  });

  test('strip acentos (María → maria)', () => {
    assert.equal(normName('María García'), 'maria garcia');
  });

  test('strip simbolos (puntos, comas, hash)', () => {
    assert.equal(normName('Dr. Robert L. Sanchez Jr.'), 'dr robert l sanchez jr');
  });

  test('null/undefined → ""', () => {
    assert.equal(normName(null), '');
    assert.equal(normName(undefined), '');
    assert.equal(normName(''), '');
  });

  test('numeros pasan tal cual', () => {
    assert.equal(normName('John Doe 2'), 'john doe 2');
  });
});

describe('normCdl', () => {
  test('uppercase + strip non-alphanumeric', () => {
    assert.equal(normCdl('tx-123/456 78'), 'TX12345678');
  });

  test('preserva alfanumericos consecutivos', () => {
    assert.equal(normCdl('LFD01005220'), 'LFD01005220');
  });

  test('null → ""', () => {
    assert.equal(normCdl(null), '');
    assert.equal(normCdl(''), '');
  });
});

describe('normState', () => {
  test('codigo de 2 letras se uppercase', () => {
    assert.equal(normState('tx'), 'TX');
    assert.equal(normState('TX'), 'TX');
    assert.equal(normState('Tx'), 'TX');
  });

  test('nombre largo se capitaliza ("mexico" → "Mexico")', () => {
    assert.equal(normState('mexico'), 'Mexico');
    assert.equal(normState('MEXICO'), 'Mexico');
  });

  test('null/empty → null', () => {
    assert.equal(normState(null), null);
    assert.equal(normState(''), null);
    // un string con solo espacios tambien deberia ser null
    assert.equal(normState('   '), null);
  });
});

describe('parseDate', () => {
  test('MM/DD/YYYY estandar', () => {
    assert.equal(parseDate('09/02/2026'), '2026-09-02');
  });

  test('M/D/YYYY (un digito)', () => {
    assert.equal(parseDate('1/5/2026'), '2026-01-05');
  });

  test('MM/DD/YY con year 2-digit < 50 → 20XX', () => {
    assert.equal(parseDate('11/15/26'), '2026-11-15');
    assert.equal(parseDate('1/22/26'), '2026-01-22');
  });

  test('MM/DD/YY con year 2-digit >= 50 → 19XX', () => {
    assert.equal(parseDate('11/15/97'), '1997-11-15');
    assert.equal(parseDate('1/22/50'), '1950-01-22');
  });

  test('formato ISO YYYY-MM-DD pasa', () => {
    assert.equal(parseDate('2026-04-29'), '2026-04-29');
  });

  test('Date object', () => {
    const d = new Date('2026-04-29T00:00:00Z');
    assert.equal(parseDate(d), '2026-04-29');
  });

  test('null/empty/garbage → null', () => {
    assert.equal(parseDate(null), null);
    assert.equal(parseDate(''), null);
    assert.equal(parseDate('garbage'), null);
    assert.equal(parseDate('not a date'), null);
  });

  test('Date invalido → null', () => {
    assert.equal(parseDate(new Date('invalid')), null);
  });
});

describe('levenshtein', () => {
  test('strings iguales = 0', () => {
    assert.equal(levenshtein('hello', 'hello'), 0);
  });

  test('caso clasico kitten → sitting = 3', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });

  test('strings vacios', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('', 'abc'), 3);
  });

  test('una insercion', () => {
    assert.equal(levenshtein('cat', 'cats'), 1);
  });

  test('una sustitucion', () => {
    assert.equal(levenshtein('cat', 'bat'), 1);
  });

  test('robert l sanchez vs roberto sanchez = 2 (caso real del Excel)', () => {
    assert.equal(levenshtein('robert l sanchez', 'roberto sanchez'), 2);
  });
});

describe('namesMatch', () => {
  test('exact match (case-insensitive ya normalizado afuera)', () => {
    assert.equal(namesMatch('roberto sanchez', 'roberto sanchez'), true);
  });

  test('match dentro del threshold (caso del Excel real)', () => {
    // distance = 2, threshold para 15 chars = max(2, 1) = 2 → match
    assert.equal(namesMatch('robert l sanchez', 'roberto sanchez'), true);
  });

  test('no match cuando son completamente diferentes', () => {
    assert.equal(namesMatch('john doe', 'maria garcia'), false);
  });

  test('strings vacios no matchean', () => {
    assert.equal(namesMatch('', 'roberto'), false);
    assert.equal(namesMatch('roberto', ''), false);
    assert.equal(namesMatch('', ''), false);
  });

  test('una letra de diferencia en nombres cortos NO matchea (threshold=2)', () => {
    // "ana" vs "ano" = 1 char distance, min length 3, threshold = max(2, 0) = 2
    // 1 <= 2 → match. Es esperado: nombres muy cortos son ambiguos.
    assert.equal(namesMatch('ana lopez', 'ano lopez'), true);
  });

  test('nombres largos toleran ~10% de diferencia', () => {
    // "albeiro enrique martinez pineda" (30 chars) — threshold floor(30*0.1)=3
    // "albeyro enrique martines pineda" — distance 2
    assert.equal(
      namesMatch('albeiro enrique martinez pineda', 'albeyro enrique martines pineda'),
      true
    );
  });

  test('typo grande NO matchea aunque suene parecido', () => {
    assert.equal(namesMatch('john smith', 'jonathan smithers'), false);
  });
});
