// Genera PDFs de los .md de docs/ + README.md, listos para entregar a desarrollo.
//
// Pipeline:
//   markdown → marked (md → html) → template HTML con CSS print → Chrome headless (html → pdf)
//
// Output: dist/docs/*.pdf
//
// Uso: node scripts/build-pdfs.js
//      node scripts/build-pdfs.js --keep-html  (deja el HTML intermedio para debug)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'docs');
const KEEP_HTML = process.argv.includes('--keep-html');

// Heuristica para encontrar Chrome o Edge en Windows.
function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('No encontre Chrome ni Edge. Instala uno de los dos.');
}

const BROWSER = findBrowser();
console.log(`Browser: ${BROWSER}`);

// Lista de docs a convertir. Orden = orden en el indice del PDF entregable.
const DOCS = [
  // Stack original Node (v0.1.0)
  { title: 'README',                src: path.join(ROOT, 'README.md'),                  out: 'README.pdf' },
  { title: 'Architecture',          src: path.join(ROOT, 'docs', 'ARCHITECTURE.md'),    out: 'ARCHITECTURE.pdf' },
  { title: 'API Reference',         src: path.join(ROOT, 'docs', 'API_REFERENCE.md'),   out: 'API_REFERENCE.pdf' },
  { title: 'Security Posture',      src: path.join(ROOT, 'docs', 'SECURITY.md'),        out: 'SECURITY.pdf' },
  { title: 'Deploy Guide (Node)',   src: path.join(ROOT, 'docs', 'DEPLOY.md'),          out: 'DEPLOY.pdf' },
  { title: 'QA Report',             src: path.join(ROOT, 'docs', 'QA_REPORT.md'),       out: 'QA_REPORT.pdf' },
  { title: 'Handoff a Desarrollo',  src: path.join(ROOT, 'docs', 'HANDOFF.md'),         out: 'HANDOFF.pdf' },

  // Port .NET (v0.2.0)
  { title: 'BotDot .NET — README',  src: path.join(ROOT, 'dotnet', 'README.md'),        out: 'DOTNET_README.pdf' },
  { title: 'Deploy Guide (.NET)',   src: path.join(ROOT, 'docs', 'DEPLOY_NET.md'),      out: 'DEPLOY_NET.pdf' },
  { title: 'Port Handoff Node→.NET', src: path.join(ROOT, 'docs', 'PORT_HANDOFF.md'),   out: 'PORT_HANDOFF.pdf' },
];

// CSS optimizado para print A4. Tipografia compacta + tablas legibles.
const CSS = `
  @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #1f2937;
    max-width: none;
  }
  h1 { font-size: 22pt; color: #0f172a; border-bottom: 3px solid #0ea5e9; padding-bottom: 6pt; margin-top: 0; }
  h2 { font-size: 15pt; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 3pt; margin-top: 18pt; page-break-after: avoid; }
  h3 { font-size: 12pt; color: #1e293b; margin-top: 14pt; page-break-after: avoid; }
  h4 { font-size: 11pt; color: #334155; margin-top: 10pt; }
  p, ul, ol { margin: 6pt 0; }
  ul, ol { padding-left: 22pt; }
  li { margin: 2pt 0; }
  code {
    font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
    font-size: 9.5pt;
    background: #f1f5f9;
    padding: 1pt 4pt;
    border-radius: 3pt;
    color: #be185d;
  }
  pre {
    background: #0f172a;
    color: #e2e8f0;
    padding: 10pt;
    border-radius: 5pt;
    overflow-x: auto;
    font-size: 9pt;
    line-height: 1.4;
    page-break-inside: avoid;
  }
  pre code { background: none; color: inherit; padding: 0; }
  blockquote {
    border-left: 3px solid #0ea5e9;
    padding: 4pt 12pt;
    margin: 8pt 0;
    color: #475569;
    background: #f8fafc;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 8pt 0;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 4pt 6pt;
    text-align: left;
    font-size: 9.5pt;
    vertical-align: top;
  }
  th { background: #f1f5f9; font-weight: 700; color: #0f172a; }
  tr:nth-child(even) td { background: #fafafa; }
  a { color: #0369a1; text-decoration: none; }
  hr { border: none; border-top: 1px solid #cbd5e1; margin: 14pt 0; }
  img { max-width: 100%; height: auto; }
  /* Header con metadata del documento */
  .doc-header {
    border-bottom: 2px solid #0ea5e9;
    margin-bottom: 14pt;
    padding-bottom: 8pt;
  }
  .doc-header .meta {
    color: #64748b;
    font-size: 9pt;
    margin-top: 2pt;
  }
  /* Footer en cada pagina via @page (Chrome respeta esto en print) */
  @page { @bottom-right { content: counter(page) " / " counter(pages); color: #94a3b8; font-size: 8pt; } }
`;

function wrapHtml(title, body) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>BOTDOT — ${escapeHtml(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="doc-header">
    <h1>BOTDOT — ${escapeHtml(title)}</h1>
    <div class="meta">v0.1.0 · USDOT 2195271 · ${new Date().toISOString().slice(0, 10)} · Intelogix</div>
  </div>
  ${body}
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function md2html(filepath) {
  const md = fs.readFileSync(filepath, 'utf8');
  return marked.parse(md);
}

function htmlToPdf(htmlPath, pdfPath) {
  // file:// URL para Chrome.
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  execFileSync(BROWSER, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    fileUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let total = 0;
  for (const doc of DOCS) {
    if (!fs.existsSync(doc.src)) {
      console.log(`  [skip] ${doc.title} (${doc.src} no existe)`);
      continue;
    }
    const body = md2html(doc.src);
    const html = wrapHtml(doc.title, body);

    const htmlPath = path.join(OUT_DIR, doc.out.replace('.pdf', '.html'));
    const pdfPath = path.join(OUT_DIR, doc.out);
    fs.writeFileSync(htmlPath, html, 'utf8');

    process.stdout.write(`  Generando ${doc.out}... `);
    htmlToPdf(htmlPath, pdfPath);
    const size = fs.statSync(pdfPath).size;
    console.log(`OK (${(size / 1024).toFixed(1)} KB)`);

    if (!KEEP_HTML) fs.unlinkSync(htmlPath);
    total++;
  }
  console.log(`\nGenerados ${total} PDFs en ${path.relative(ROOT, OUT_DIR)}/`);
}

main();
