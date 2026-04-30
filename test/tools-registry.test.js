// Verifica que el registry de tools del agente este completo y que cada
// definition cumpla el schema esperado por la API de Anthropic.
//
// Si alguien agrega un tool al codigo pero olvida registrarlo en index.js
// (o viceversa), estos tests truenan en CI.

require('./setup');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TOOL_DEFINITIONS, executeTool } = require('../src/agent/tools');

describe('tool registry — estructura', () => {
  test('todos los tools tienen name, description, input_schema', () => {
    for (const def of TOOL_DEFINITIONS) {
      assert.ok(def.name, `Tool sin name: ${JSON.stringify(def).slice(0, 80)}`);
      assert.ok(def.description, `Tool ${def.name} sin description`);
      assert.ok(def.input_schema, `Tool ${def.name} sin input_schema`);
    }
  });

  test('input_schema es un object schema valido', () => {
    for (const def of TOOL_DEFINITIONS) {
      assert.equal(def.input_schema.type, 'object', `${def.name}: schema no es object`);
      assert.ok(def.input_schema.properties, `${def.name}: falta properties`);
    }
  });

  test('names son unicos (no hay duplicados en el registry)', () => {
    const names = TOOL_DEFINITIONS.map(d => d.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, `Duplicados: ${names.join(', ')}`);
  });

  test('descriptions son sustanciales (>30 chars)', () => {
    // Descriptions cortas son una bandera roja: el modelo no sabe cuando usar el tool.
    for (const def of TOOL_DEFINITIONS) {
      assert.ok(
        def.description.length > 30,
        `${def.name}: description muy corta: "${def.description}"`
      );
    }
  });
});

describe('tool registry — herramientas requeridas por el system prompt', () => {
  function hasTool(name) {
    return TOOL_DEFINITIONS.some(d => d.name === name);
  }

  // Las reglas del system prompt nombran explicitamente estos tools.
  // Si los borras, el agente recibe una instruccion sobre un tool que no
  // existe — comportamiento indefinido. No los borres sin actualizar prompt.
  test('log_decision (regla 9 — audit por defecto)', () => {
    assert.ok(hasTool('log_decision'));
  });

  test('log_refused_request (regla 4 — rechazos de evasion DOT)', () => {
    assert.ok(hasTool('log_refused_request'));
  });

  test('log_off_topic (regla 1 — rechazos de off-topic)', () => {
    assert.ok(hasTool('log_off_topic'));
  });

  test('search_cfr y get_cfr_section (regla 2 — citas CFR)', () => {
    assert.ok(hasTool('search_cfr'));
    assert.ok(hasTool('get_cfr_section'));
  });

  test('samsara_get_driver_hos (regla 2 — datos HOS verificados)', () => {
    assert.ok(hasTool('samsara_get_driver_hos'));
  });

  test('check_assignment_compliance (HOS rules engine)', () => {
    assert.ok(hasTool('check_assignment_compliance'));
  });

  test('escalate_to_compliance (regla 10 — handoff humano)', () => {
    assert.ok(hasTool('escalate_to_compliance'));
  });
});

describe('executeTool — error handling', () => {
  test('herramienta desconocida devuelve error en vez de tirar', async () => {
    const r = await executeTool('inexistente_xyz', {}, { user: { id: 1 } });
    assert.ok(r.error, 'Esperaba { error: ... }');
    assert.match(r.error, /desconocida/i);
  });
});
