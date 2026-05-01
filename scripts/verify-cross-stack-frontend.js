#!/usr/bin/env node
// Verificacion de paridad de assets frontend entre Node (public/) y
// .NET (dotnet/BotDot.Web/wwwroot/).
//
// Lista de archivos compartidos: HTML+CSS+JS+sw.js+manifest. Cada uno
// debe ser byte-identico entre los dos directorios — Node es la fuente
// canonica.
//
// Excepcion: si un archivo existe SOLO en public/ (no en wwwroot/),
// significa que esa pagina ya migro a Blazor Server (Components/Pages/).
// Eso es OK y se ignora.
//
// Uso:
//   node scripts/verify-cross-stack-frontend.js
//   node scripts/verify-cross-stack-frontend.js --fix   (sincroniza Node → .NET)
//
// Sale 0 si paridad OK (o si --fix sincronizo todo), 1 si hay drift sin fix,
// 2 si hay archivos solo en .NET (raro, requiere revision manual).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const WWWROOT_DIR = path.join(REPO_ROOT, 'dotnet', 'BotDot.Web', 'wwwroot');

// Lista canonica de assets compartidos. Si se agrega un asset al frontend
// que ambos stacks necesiten, agregarlo aqui.
const SHARED_FILES = [
  // HTML pages — algunas pueden estar migradas a Blazor (solo en public/)
  'index.html', 'app.html', 'change-password.html', 'settings.html',
  'drivers.html', 'users.html', 'escalations.html', 'notifications.html',
  'analytics.html',
  // CSS
  'css/styles.css',
  // JS
  'js/app.js', 'js/auth.js', 'js/chat.js', 'js/dashboard.js', 'js/drivers.js',
  'js/escalations.js', 'js/login.js', 'js/notifications.js', 'js/pwa.js',
  'js/settings.js', 'js/users.js', 'js/analytics.js', 'js/change-password.js',
  // Service Worker + PWA manifest
  'sw.js', 'manifest.json',
];

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const fix = process.argv.includes('--fix');

const drift = [];      // existe en ambos pero bytes difieren
const onlyNode = [];   // existe en public, no en wwwroot — probablemente Blazor migrado, OK
const onlyDotnet = []; // existe en wwwroot, no en public — raro, alerta
const ok = [];

for (const rel of SHARED_FILES) {
  const p = path.join(PUBLIC_DIR, rel);
  const w = path.join(WWWROOT_DIR, rel);
  const pExists = fs.existsSync(p);
  const wExists = fs.existsSync(w);

  if (pExists && wExists) {
    if (bytesEqual(fs.readFileSync(p), fs.readFileSync(w))) {
      ok.push(rel);
    } else {
      drift.push(rel);
    }
  } else if (pExists && !wExists) {
    onlyNode.push(rel);
  } else if (!pExists && wExists) {
    onlyDotnet.push(rel);
  }
  // else: no existe en ninguno (asset borrado de la lista) — skip
}

console.log(`Frontend cross-stack check (${SHARED_FILES.length} assets candidatos):`);
console.log(`  ${ok.length} sincronizados`);
console.log(`  ${drift.length} con drift`);
console.log(`  ${onlyNode.length} solo en Node (probablemente migrados a Blazor)`);
console.log(`  ${onlyDotnet.length} solo en .NET (requiere revision)`);
console.log();

if (onlyNode.length) {
  console.log('Solo en Node (OK si fueron migrados a Blazor):');
  for (const f of onlyNode) console.log(`  - ${f}`);
  console.log();
}

if (drift.length) {
  console.log(fix ? 'Sincronizando Node → .NET:' : 'Drift detectado (Node es canonico):');
  for (const f of drift) {
    if (fix) {
      const src = path.join(PUBLIC_DIR, f);
      const dst = path.join(WWWROOT_DIR, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      console.log(`  ✓ sync ${f}`);
    } else {
      console.log(`  ✗ ${f}`);
    }
  }
  console.log();
}

if (onlyDotnet.length) {
  console.log('ATENCION — solo en .NET (sin equivalente Node):');
  for (const f of onlyDotnet) console.log(`  - ${f}`);
  console.log('Esto es raro. Revisar manualmente — puede ser un asset .NET-only');
  console.log('intencional, o un drift estructural.');
  console.log();
  process.exit(2);
}

if (drift.length === 0) {
  console.log('Frontend cross-stack OK — sin drift.');
  process.exit(0);
}

if (fix) {
  console.log(`Sincronizados ${drift.length} archivos. Re-correr sin --fix para verificar.`);
  process.exit(0);
}

console.log(`${drift.length} archivos con drift. Correr con --fix para sincronizar.`);
process.exit(1);
