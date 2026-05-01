#!/usr/bin/env node
// Verificacion cross-stack de las TOOL_DEFINITIONS del agent.
//
// Si Node y .NET definen las tools con schemas distintos, Claude responde
// diferente entre stacks (mismas preguntas, distintas tool calls). Eso
// rompe paridad funcional del agent silenciosamente.
//
// Para cada tool: canonicaliza el { name, description, input_schema } en
// ambos stacks con la misma funcion canonicalize() del audit (ya verificada
// byte-exact en Fase 3) y compara.
//
// Uso:
//   node scripts/verify-cross-stack-agent.js
//   BOTDOT_DOTNET_URL=http://localhost:5050 node scripts/verify-cross-stack-agent.js
//
// El .NET debe estar en Development (el endpoint /api/_debug/agent/tool-defs
// solo se mapea ahi). Sale 0 si hay paridad, 1 si hay drift.

const { TOOL_DEFINITIONS } = require('../src/agent/tools');
const { canonicalize } = require('../src/db/audit-chain');

const DOTNET_URL = process.env.BOTDOT_DOTNET_URL || 'http://localhost:5050';

function normalizeNodeDef(d) {
  // Asegurar el mismo shape que el .NET devuelve: { name, description, input_schema }
  return {
    name: d.name,
    description: d.description,
    input_schema: d.input_schema,
  };
}

async function fetchDotnetDefs() {
  const url = `${DOTNET_URL}/api/_debug/agent/tool-defs`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.tools;
}

function diffString(a, b) {
  if (a === b) return null;
  const minLen = Math.min(a.length, b.length);
  let firstDiff = -1;
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) { firstDiff = i; break; }
  }
  if (firstDiff === -1) firstDiff = minLen;
  const window = 60;
  const start = Math.max(0, firstDiff - window);
  const endA = Math.min(a.length, firstDiff + window);
  const endB = Math.min(b.length, firstDiff + window);
  return {
    first_diff_at: firstDiff,
    node_len: a.length,
    dotnet_len: b.length,
    node_slice: JSON.stringify(a.slice(start, endA)),
    dotnet_slice: JSON.stringify(b.slice(start, endB)),
  };
}

async function run() {
  console.log(`Verificando tool definitions cross-stack contra ${DOTNET_URL}...\n`);

  // Lado Node — orden alfabetico, normalizar shape.
  const nodeDefs = TOOL_DEFINITIONS.map(normalizeNodeDef)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  // Lado .NET — el endpoint ya devuelve ordenado por name (StringComparer.Ordinal).
  let dotnetDefs;
  try {
    dotnetDefs = await fetchDotnetDefs();
  } catch (e) {
    console.error('No pude obtener las tool defs del .NET:', e.message);
    console.error('Verifica que el .NET este corriendo en Development en ' + DOTNET_URL);
    process.exit(2);
  }

  console.log(`Node:   ${nodeDefs.length} tools`);
  console.log(`.NET:   ${dotnetDefs.length} tools\n`);

  if (nodeDefs.length !== dotnetDefs.length) {
    const nodeNames = new Set(nodeDefs.map(d => d.name));
    const dotnetNames = new Set(dotnetDefs.map(d => d.name));
    const onlyNode = [...nodeNames].filter(n => !dotnetNames.has(n));
    const onlyDotnet = [...dotnetNames].filter(n => !nodeNames.has(n));
    console.log('Diferencia en cantidad de tools:');
    if (onlyNode.length) console.log('  Solo en Node: ', onlyNode);
    if (onlyDotnet.length) console.log('  Solo en .NET: ', onlyDotnet);
    process.exit(1);
  }

  // Mapeamos por nombre para comparar pares
  const dotnetByName = new Map(dotnetDefs.map(d => [d.name, d]));
  let pass = 0, fail = 0;
  const failures = [];

  for (const nodeDef of nodeDefs) {
    const dotnetDef = dotnetByName.get(nodeDef.name);
    if (!dotnetDef) {
      console.log(`✗ [${nodeDef.name}] no existe en .NET`);
      fail++;
      failures.push({ name: nodeDef.name, error: 'missing in .NET' });
      continue;
    }

    const nodeCanon = canonicalize(nodeDef);
    const dotnetCanon = canonicalize(dotnetDef);

    if (nodeCanon === dotnetCanon) {
      console.log(`✓ [${nodeDef.name}]`);
      pass++;
    } else {
      console.log(`✗ [${nodeDef.name}] DRIFT`);
      const d = diffString(nodeCanon, dotnetCanon);
      console.log(`    diff:`, d);
      // Diff campo por campo para ayudar el debug
      for (const field of ['name', 'description', 'input_schema']) {
        const nf = canonicalize(nodeDef[field]);
        const df = canonicalize(dotnetDef[field]);
        if (nf !== df) {
          console.log(`    field "${field}" difiere:`);
          console.log(`      node:   ${nf.slice(0, 200)}${nf.length > 200 ? '...' : ''}`);
          console.log(`      dotnet: ${df.slice(0, 200)}${df.length > 200 ? '...' : ''}`);
        }
      }
      fail++;
      failures.push({ name: nodeDef.name });
    }
  }

  console.log(`\n${pass}/${nodeDefs.length} pass, ${fail} fail`);
  if (fail > 0) {
    console.log(`\nDrift detectado en tool definitions: el agent .NET y el agent Node`);
    console.log(`presentan distintas tools/schemas a Claude. Esto rompe paridad`);
    console.log(`funcional silenciosamente — Claude responde distinto entre stacks.`);
    console.log(`Revisa la tool que difiere en dotnet/BotDot.Web/Agent/Tools/.`);
    process.exit(1);
  }
  console.log(`\nTool definitions equivalentes byte-a-byte entre Node y .NET.`);
  process.exit(0);
}

run().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(2);
});
