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

  test('Robert L Sanchez NO matchea Roberto Sanchez (token count distinto)', () => {
    // Bug detectado en uso real: tokens diferentes (3 vs 2) — son personas
    // distintas aunque char-similar. Algoritmo viejo (threshold 10%) los
    // matcheaba (false positive); el algoritmo token-by-token los rechaza.
    assert.equal(namesMatch('robert l sanchez', 'roberto sanchez'), false);
  });

  test('no match cuando son completamente diferentes', () => {
    assert.equal(namesMatch('john doe', 'maria garcia'), false);
  });

  test('strings vacios no matchean', () => {
    assert.equal(namesMatch('', 'roberto'), false);
    assert.equal(namesMatch('roberto', ''), false);
    assert.equal(namesMatch('', ''), false);
  });

  test('typo de una letra por token matchea (martinez/martines, albeiro/albeyro)', () => {
    // Cada token con distancia 1, mismo numero de tokens → match.
    assert.equal(
      namesMatch('albeiro enrique martinez pineda', 'albeyro enrique martines pineda'),
      true
    );
  });

  test('typo simple en un solo token matchea', () => {
    // "ana lopez" ↔ "ano lopez": ana/ano dist 1 + lopez exact → match
    assert.equal(namesMatch('ana lopez', 'ano lopez'), true);
  });

  test('apellidos distintos NO matchean (Hernandez vs Sanchez)', () => {
    // Token de apellido difiere mas alla de typo → no match.
    assert.equal(namesMatch('roberto hernandez', 'roberto sanchez'), false);
  });

  test('initials (1 char) requieren match exacto', () => {
    // "Juan L Perez" vs "Juan F Perez": L y F son tokens cortos, no toleran sustitucion
    assert.equal(namesMatch('juan l perez', 'juan f perez'), false);
  });

  test('typo grande NO matchea aunque suene parecido', () => {
    assert.equal(namesMatch('john smith', 'jonathan smithers'), false);
  });
});
