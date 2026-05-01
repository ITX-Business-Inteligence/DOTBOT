#!/usr/bin/env node
// Verificacion cross-stack de las rutas /api/* registradas.
//
// Si Node tiene una ruta que .NET no tiene (o viceversa), un cliente
// que use ese endpoint en un stack falla en el otro. Este script atrapa
// ese drift.
//
// Para Node: parseamos los src/routes/*.js con regex extrayendo cada
// router.get/post/put/delete/patch. Cada archivo se monta con un prefix
// que lee del server.js (app.use('/api/auth', authRouter), etc).
//
// Para .NET: GET al endpoint debug /api/_debug/routes que devuelve lo
// realmente registrado en runtime (EndpointDataSource).
//
// Sale 0 si las dos listas son identicas, 1 si hay drift.

const fs = require('fs');
const path = require('path');

const DOTNET_URL = process.env.BOTDOT_DOTNET_URL || 'http://localhost:5050';

// Mapeo archivo → prefix usado en server.js. Lo leemos del server real para
// evitar drift entre este script y la realidad.
function readServerPrefixes() {
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const prefixes = {};
  // Regex: app.use('/api/xxx', require('./src/routes/yyy'))
  const re = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"]\.\/src\/routes\/([^'"]+)['"]\s*\)\s*\)/g;
  let m;
  while ((m = re.exec(serverJs)) !== null) {
    const prefix = m[1];
    const file = m[2].replace(/\.js$/, '') + '.js';
    prefixes[file] = prefix;
  }
  return prefixes;
}

function extractNodeRoutes() {
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const prefixes = readServerPrefixes();
  const routes = [];

  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.js')) continue;
    const prefix = prefixes[file];
    if (!prefix) {
      // Puede ser un archivo helper/admin sub-modulo; lo skipeamos.
      continue;
    }
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    // Regex captura: router.get('/path', ...) | router.post(...)
    // Tambien admin sub-routers (ej. router.use('/sub', subRouter)) los manejamos
    // recursivamente — pero por ahora extraemos directos.
    const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      let subpath = m[2];
      // Combinar prefix con subpath. Normalizar / dobles.
      let full = (prefix + subpath).replace(/\/+/g, '/');
      // Express ':param' → ASP.NET '{param}' para comparacion homogenea
      full = full.replace(/:([a-zA-Z_]\w*)\??/g, '{$1}');
      routes.push({ method, path: full });
    }
  }

  // Buscar tambien sub-routers (admin tiene admin/users, admin/drivers, etc)
  // Patron: router.use('/sub', subRouter)
  const adminFile = path.join(routesDir, 'admin.js');
  if (fs.existsSync(adminFile)) {
    const adminContent = fs.readFileSync(adminFile, 'utf8');
    // Buscar require('./admin/users') etc
    const subRe = /router\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
    let m;
    while ((m = subRe.exec(adminContent)) !== null) {
      const subPrefix = m[1];
      let subFile = m[2];
      if (!subFile.endsWith('.js')) subFile += '.js';
      // Resolver path relativo
      const subFullPath = path.resolve(path.join(routesDir, subFile));
      if (!fs.existsSync(subFullPath)) continue;
      const subContent = fs.readFileSync(subFullPath, 'utf8');
      const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
      let mm;
      while ((mm = re.exec(subContent)) !== null) {
        const method = mm[1].toUpperCase();
        let full = ('/api/admin' + subPrefix + mm[2]).replace(/\/+/g, '/');
        full = full.replace(/:([a-zA-Z_]\w*)\??/g, '{$1}');
        routes.push({ method, path: full });
      }
    }
  }

  return routes;
}

async function fetchDotnetRoutes() {
  const url = `${DOTNET_URL}/api/_debug/routes`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.routes;
}

// Normalizacion de paths para comparacion homogenea:
// - ASP.NET pattern '{id:long}' o '{id:int}' → '{id}' (constraint solo afecta routing
//   interno del .NET; un cliente que pide /api/x/123 matchea ambos).
// - Trailing slash: lo eliminamos en ambos lados (Express y ASP.NET con MapPost a
//   '/api/x' o '/api/x/' aceptan ambos en la practica via redirect/rewrites).
function normalizePath(p) {
  let n = p.replace(/\{(\w+):\w+\}/g, '{$1}'); // strip route constraints
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

function normalize(r) {
  return `${r.method} ${normalizePath(r.path)}`;
}

// Endpoints excluidos de la comparacion (.NET-only sin equivalente Node por diseno).
const EXCLUDE_FROM_DOTNET = new Set([
  'GET /api/health', // health del .NET (Node tiene /health en server.js root, no /api/)
]);

async function run() {
  console.log(`Verificando paridad de rutas /api/* contra ${DOTNET_URL}...\n`);

  const nodeRoutes = extractNodeRoutes()
    .map(r => ({ method: r.method, path: r.path }));
  let dotnetRoutes;
  try {
    dotnetRoutes = await fetchDotnetRoutes();
  } catch (e) {
    console.error('No pude obtener rutas del .NET:', e.message);
    process.exit(2);
  }

  // Dedup (algunos endpoints aparecen N veces si comparten path con metodos distintos).
  // Aplicamos normalize (que strippea {id:long}→{id} y trailing slash) y filtramos
  // los excluidos del .NET (ej. /api/health que solo existe en .NET por diseno).
  const nodeSet = new Set(nodeRoutes.map(normalize));
  const dotnetSet = new Set(dotnetRoutes.map(normalize).filter(r => !EXCLUDE_FROM_DOTNET.has(r)));

  console.log(`Node:  ${nodeSet.size} rutas`);
  console.log(`.NET:  ${dotnetSet.size} rutas\n`);

  const onlyNode = [...nodeSet].filter(r => !dotnetSet.has(r)).sort();
  const onlyDotnet = [...dotnetSet].filter(r => !nodeSet.has(r)).sort();
  const inBoth = [...nodeSet].filter(r => dotnetSet.has(r)).sort();

  for (const r of inBoth) console.log(`✓ ${r}`);
  for (const r of onlyNode) console.log(`✗ SOLO NODE:   ${r}`);
  for (const r of onlyDotnet) console.log(`✗ SOLO .NET:   ${r}`);

  console.log(`\n${inBoth.length} en ambos, ${onlyNode.length} solo Node, ${onlyDotnet.length} solo .NET`);

  if (onlyNode.length > 0 || onlyDotnet.length > 0) {
    console.log('\nDrift de rutas detectado entre Node y .NET.');
    console.log('Cualquier cliente que use una ruta en un stack falla en el otro.');
    process.exit(1);
  }
  console.log('\nParidad de rutas /api/* verificada entre Node y .NET.');
  process.exit(0);
}

run().catch(e => {
  console.error('Error fatal:', e);
  process.exit(2);
});
