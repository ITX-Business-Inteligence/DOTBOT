// Tests de calculo de costo de Claude API.
// Si el pricing en anthropic.com cambia, hay que actualizar PRICING en
// src/utils/pricing.js Y estos tests.

require('./setup');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { costFromUsage, PRICING, getModelPricing } = require('../src/utils/pricing');

describe('costFromUsage — formatos aceptados', () => {
  test('formato API de Anthropic (input_tokens, output_tokens, ...)', () => {
    const cost = costFromUsage({
      input_tokens: 1_000_000,
      output_tokens: 0,
    }, 'claude-sonnet-4-6');
    assert.equal(cost, 3); // $3/Mtok input para Sonnet 4.6
  });

  test('formato DB (tokens_input, tokens_output, ...)', () => {
    const cost = costFromUsage({
      tokens_input: 1_000_000,
      tokens_output: 0,
    }, 'claude-sonnet-4-6');
    assert.equal(cost, 3);
  });

  test('formato Anthropic tiene precedencia si ambos presentes', () => {
    const cost = costFromUsage({
      input_tokens: 1_000_000,
      tokens_input: 5_000_000,    // ignorado
      output_tokens: 0,
    }, 'claude-sonnet-4-6');
    assert.equal(cost, 3);
  });
});

describe('costFromUsage — pricing por componente', () => {
  test('1M output tokens Sonnet = $15', () => {
    const cost = costFromUsage({ output_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    assert.equal(cost, 15);
  });

  test('1M cache_read tokens Sonnet = $0.30', () => {
    const cost = costFromUsage(
      { cache_read_input_tokens: 1_000_000 },
      'claude-sonnet-4-6'
    );
    assert.equal(cost, 0.30);
  });

  test('1M cache_creation tokens Sonnet = $3.75', () => {
    const cost = costFromUsage(
      { cache_creation_input_tokens: 1_000_000 },
      'claude-sonnet-4-6'
    );
    assert.equal(cost, 3.75);
  });

  test('combinado: 100k input + 50k output Sonnet', () => {
    const cost = costFromUsage({
      input_tokens: 100_000,
      output_tokens: 50_000,
    }, 'claude-sonnet-4-6');
    // 0.1*3 + 0.05*15 = 0.30 + 0.75 = 1.05
    assert.equal(Math.round(cost * 100) / 100, 1.05);
  });
});

describe('costFromUsage — modelos', () => {
  test('Opus 4.7 mas caro que Sonnet 4.6', () => {
    const sonnet = costFromUsage({ output_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    const opus = costFromUsage({ output_tokens: 1_000_000 }, 'claude-opus-4-7');
    assert.ok(opus > sonnet);
  });

  test('Haiku 4.5 mas barato que Sonnet 4.6', () => {
    const sonnet = costFromUsage({ output_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    const haiku = costFromUsage({ output_tokens: 1_000_000 }, 'claude-haiku-4-5');
    assert.ok(haiku < sonnet);
  });

  test('modelo desconocido cae al default sin tirar', () => {
    const cost = costFromUsage({ input_tokens: 1_000 }, 'claude-fake-99');
    assert.equal(typeof cost, 'number');
    assert.ok(cost >= 0);
  });
});

describe('costFromUsage — edge cases', () => {
  test('usage null devuelve 0', () => {
    assert.equal(costFromUsage(null, 'claude-sonnet-4-6'), 0);
  });

  test('usage undefined devuelve 0', () => {
    assert.equal(costFromUsage(undefined, 'claude-sonnet-4-6'), 0);
  });

  test('usage vacio devuelve 0', () => {
    assert.equal(costFromUsage({}, 'claude-sonnet-4-6'), 0);
  });

  test('campos null en usage tratados como 0', () => {
    const cost = costFromUsage({
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    }, 'claude-sonnet-4-6');
    assert.equal(cost, 0);
  });
});

describe('PRICING — tabla de precios', () => {
  test('todos los modelos tienen los 4 componentes', () => {
    for (const [model, pricing] of Object.entries(PRICING)) {
      assert.ok(typeof pricing.input === 'number',       `${model}: falta input`);
      assert.ok(typeof pricing.output === 'number',      `${model}: falta output`);
      assert.ok(typeof pricing.cache_read === 'number',  `${model}: falta cache_read`);
      assert.ok(typeof pricing.cache_write === 'number', `${model}: falta cache_write`);
    }
  });

  test('output siempre mas caro que input (regla de Anthropic)', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      assert.ok(p.output > p.input, `${model}: output deberia ser > input`);
    }
  });

  test('cache_read siempre mas barato que input (regla de Anthropic)', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      assert.ok(p.cache_read < p.input, `${model}: cache_read deberia ser < input`);
    }
  });

  test('Sonnet 4.6, Opus 4.7 y Haiku 4.5 estan en la tabla', () => {
    assert.ok(PRICING['claude-sonnet-4-6']);
    assert.ok(PRICING['claude-opus-4-7']);
    assert.ok(PRICING['claude-haiku-4-5']);
  });
});

describe('getModelPricing', () => {
  test('devuelve el objeto correcto para un modelo conocido', () => {
    const p = getModelPricing('claude-sonnet-4-6');
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
  });

  test('cae al default para un modelo desconocido sin tirar', () => {
    const p = getModelPricing('claude-fake-99');
    assert.ok(p);
    assert.equal(typeof p.input, 'number');
  });
});
