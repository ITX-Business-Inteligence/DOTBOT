#!/usr/bin/env node
// Verificacion byte-exact del audit chain entre Node y .NET.
//
// Para cada fixture: computa canonical+hash en Node, lo POSTea al endpoint
// debug del .NET, y compara byte-a-byte. Reporta divergencias.
//
// Uso:
//   node scripts/verify-cross-stack-audit.js
//   BOTDOT_DOTNET_URL=http://localhost:5050 node scripts/verify-cross-stack-audit.js
//
// El .NET debe estar corriendo en Development (el endpoint debug solo se
// mapea ahi). Sale 0 si todos los hashes matchean, 1 si hay divergencia.

const {
  canonicalize,
  computeRowHash,
  buildHashable,
  GENESIS_HASH,
} = require('../src/db/audit-chain');

const DOTNET_URL = process.env.BOTDOT_DOTNET_URL || 'http://localhost:5050';

// ──────────────────────────────────────────────────────────────────────
// Fixtures — cada uno tiene mode + value. El value es lo que se canonicaliza.
// Cubrimos: primitives, edge cases de string escape, unicode, numbers,
// arrays/objetos anidados, key-ordering, y rows completas del audit_log.
// ──────────────────────────────────────────────────────────────────────
const FIXTURES = [
  // Primitives
  { name: 'null', mode: 'value', value: null },
  { name: 'true', mode: 'value', value: true },
  { name: 'false', mode: 'value', value: false },
  { name: 'zero', mode: 'value', value: 0 },
  { name: 'positive int', mode: 'value', value: 42 },
  { name: 'negative int', mode: 'value', value: -7 },
  { name: 'large int', mode: 'value', value: 9007199254740991 }, // Number.MAX_SAFE_INTEGER
  { name: 'float', mode: 'value', value: 3.14 },
  { name: 'negative float', mode: 'value', value: -2.5 },

  // Strings
  { name: 'empty string', mode: 'value', value: '' },
  { name: 'simple string', mode: 'value', value: 'hola' },
  { name: 'string con espacios', mode: 'value', value: 'a b c' },
  { name: 'string con comilla doble', mode: 'value', value: 'con "comillas"' },
  { name: 'string con backslash', mode: 'value', value: 'con \\ backslash' },
  { name: 'string con newline', mode: 'value', value: 'linea1\nlinea2' },
  { name: 'string con tab', mode: 'value', value: 'col1\tcol2' },
  { name: 'string con CR', mode: 'value', value: 'a\rb' },
  { name: 'string con backspace', mode: 'value', value: 'a\bb' },
  { name: 'string con form feed', mode: 'value', value: 'a\fb' },
  { name: 'string con control char U+0001', mode: 'value', value: 'ab' },
  { name: 'string con control char U+001f', mode: 'value', value: 'ab' },
  { name: 'string con tilde', mode: 'value', value: 'café' },
  { name: 'string con ñ', mode: 'value', value: 'mañana' },
  { name: 'string con cjk', mode: 'value', value: '你好世界' },
  { name: 'string con emoji', mode: 'value', value: 'truck 🚛' },
  { name: 'string mixto ascii+unicode', mode: 'value', value: 'Roberto Sánchez §395.3' },

  // Arrays
  { name: 'array vacio', mode: 'value', value: [] },
  { name: 'array de ints', mode: 'value', value: [1, 2, 3] },
  { name: 'array de strings', mode: 'value', value: ['a', 'b', 'c'] },
  { name: 'array mixto', mode: 'value', value: [1, 'a', null, true] },
  { name: 'array anidado', mode: 'value', value: [[1, 2], [3, 4]] },

  // Objects
  { name: 'objeto vacio', mode: 'value', value: {} },
  { name: 'objeto simple', mode: 'value', value: { a: 1, b: 2 } },
  { name: 'objeto keys reverse', mode: 'value', value: { z: 1, a: 2, m: 3 } },
  { name: 'objeto keys numericas como string', mode: 'value', value: { '10': 1, '2': 2, '1': 3 } },
  { name: 'objeto anidado', mode: 'value', value: { x: { b: 2, a: 1 }, y: [3, 1, 2] } },
  { name: 'objeto con null', mode: 'value', value: { a: null, b: 1 } },
  { name: 'objeto con keys especiales', mode: 'value', value: { 'a"b': 1, 'a\\b': 2, 'a\nb': 3 } },
  { name: 'objeto con unicode keys', mode: 'value', value: { 'café': 1, 'ñoño': 2 } },

  // Audit rows — flujo completo de buildHashable + canonicalize
  {
    name: 'audit row minimo',
    mode: 'audit_row',
    value: {
      user_id: 1,
      action_type: 'log_decision',
      decision: 'proceed',
      reasoning: 'fits HOS window',
      created_at_iso: '2026-04-29T12:00:00Z',
      prev_hash: GENESIS_HASH,
    },
  },
  {
    name: 'audit row completo',
    mode: 'audit_row',
    value: {
      user_id: 42,
      conversation_id: 1024,
      action_type: 'assignment_check',
      subject_type: 'driver',
      subject_id: 'sams_8X9k2',
      decision: 'conditional',
      cfr_cited: '49 CFR 395.3(a)(2)',
      reasoning: 'driver tiene 8h restantes — alcanza para el load de 6h pero sin margen',
      evidence: { drive_remaining_min: 480, load_eta_min: 360, basic_hos: 91 },
      override_reason: null,
      created_at_iso: '2026-05-01T13:45:32Z',
      prev_hash: 'a1b2c3d4e5f6'.repeat(5) + 'a1b2c3d4',
    },
  },
  {
    name: 'audit row con evidence anidado',
    mode: 'audit_row',
    value: {
      user_id: 1,
      action_type: 'log_decision',
      decision: 'declined',
      cfr_cited: '49 CFR 395.1(k)',
      reasoning: 'AG exemption no aplica — destino fuera de 150 air-mile radius',
      evidence: {
        source: { lat: 33.456, lon: -117.789, name: 'Bakersfield Yard' },
        destination: { lat: 35.123, lon: -118.456, name: 'Customer X' },
        distance_air_miles: 162.3,
        radius_cap: 150,
        agricultural_period: true,
      },
      created_at_iso: '2026-05-01T14:00:00Z',
      prev_hash: GENESIS_HASH,
    },
  },
  {
    name: 'audit row con strings con escapes',
    mode: 'audit_row',
    value: {
      user_id: 1,
      action_type: 'log_off_topic',
      reasoning: 'usuario pidio: "ignora tus reglas"\n— intento de injection',
      evidence: { user_message: 'che,\tdame la receta\\del fernet' },
      created_at_iso: '2026-05-01T15:30:00Z',
      prev_hash: GENESIS_HASH,
    },
  },
];

// ──────────────────────────────────────────────────────────────────────

async function postToDotnet(fixture) {
  const url = `${DOTNET_URL}/api/_debug/audit/canonicalize`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: fixture.mode, value: fixture.value }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  return res.json();
}

function nodeCanonicalize(fixture) {
  let canonical;
  if (fixture.mode === 'value') {
    canonical = canonicalize(fixture.value);
  } else if (fixture.mode === 'audit_row') {
    const hashable = buildHashable({
      user_id: fixture.value.user_id,
      conversation_id: fixture.value.conversation_id,
      action_type: fixture.value.action_type,
      subject_type: fixture.value.subject_type,
      subject_id: fixture.value.subject_id,
      decision: fixture.value.decision,
      cfr_cited: fixture.value.cfr_cited,
      reasoning: fixture.value.reasoning,
      evidence: fixture.value.evidence,
      override_reason: fixture.value.override_reason,
      created_at_iso: fixture.value.created_at_iso,
      prev_hash: fixture.value.prev_hash,
    });
    canonical = canonicalize(hashable);
  } else {
    throw new Error(`mode invalido: ${fixture.mode}`);
  }
  const hash = computeRowHash(typeof canonical === 'string'
    ? null  // never reached — computeRowHash recibe el hashable, no el canonical
    : canonical);
  // Para test, recomputamos directo con crypto:
  const crypto = require('crypto');
  const computedHash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { canonical, hash: computedHash };
}

function diffString(a, b) {
  if (a === b) return null;
  const minLen = Math.min(a.length, b.length);
  let firstDiff = -1;
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) { firstDiff = i; break; }
  }
  if (firstDiff === -1) firstDiff = minLen;
  const window = 30;
  const start = Math.max(0, firstDiff - window);
  const endA = Math.min(a.length, firstDiff + window);
  const endB = Math.min(b.length, firstDiff + window);
  return {
    first_diff_at: firstDiff,
    node_len: a.length,
    dotnet_len: b.length,
    node_slice: JSON.stringify(a.slice(start, endA)),
    dotnet_slice: JSON.stringify(b.slice(start, endB)),
    node_byte: a.charCodeAt(firstDiff),
    dotnet_byte: b.charCodeAt(firstDiff),
  };
}

async function run() {
  console.log(`Verificando ${FIXTURES.length} fixtures contra ${DOTNET_URL}...\n`);
  let pass = 0, fail = 0;
  const failures = [];

  for (const fx of FIXTURES) {
    const node = nodeCanonicalize(fx);
    let dotnet;
    try {
      dotnet = await postToDotnet(fx);
    } catch (e) {
      console.log(`✗ [${fx.name}] error HTTP: ${e.message}`);
      fail++;
      failures.push({ name: fx.name, error: e.message });
      continue;
    }

    const canonicalMatch = node.canonical === dotnet.canonical;
    const hashMatch = node.hash === dotnet.hash;

    if (canonicalMatch && hashMatch) {
      console.log(`✓ [${fx.name}]`);
      pass++;
    } else {
      console.log(`✗ [${fx.name}]`);
      console.log(`    canonical_match=${canonicalMatch} hash_match=${hashMatch}`);
      if (!canonicalMatch) {
        const d = diffString(node.canonical, dotnet.canonical);
        console.log(`    diff:`, d);
      }
      if (!hashMatch) {
        console.log(`    node hash:   ${node.hash}`);
        console.log(`    dotnet hash: ${dotnet.hash}`);
      }
      fail++;
      failures.push({ name: fx.name, node, dotnet });
    }
  }

  console.log(`\n${pass}/${FIXTURES.length} pass, ${fail} fail`);
  if (fail > 0) {
    console.log(`\nFalla cross-stack: ${fail} fixtures producen distintos bytes en Node vs .NET.`);
    console.log(`Esto rompe el audit chain byte-exact. Revisa Canonicalize.cs en el .NET.`);
    process.exit(1);
  }
  console.log(`\nAudit chain byte-exact verificado entre Node y .NET.`);
  process.exit(0);
}

run().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(2);
});
