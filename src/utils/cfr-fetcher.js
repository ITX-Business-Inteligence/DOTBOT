// Lógica pura de fetch + parse del 49 CFR desde la API publica de eCFR.
// No toca DB, no toca archivos — solo descarga, parsea, devuelve secciones.
//
// Lo usan: scripts/fetch-cfr.js (CLI) y src/jobs/cfr-update.js (cron).
// Tests: test/cfr-fetcher.test.js

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parts 388 y 394 son [Reserved] en el CFR — no tienen contenido.
const PARTS = [380, 381, 382, 383, 384, 385, 386, 387, 389, 390, 391, 392, 393, 395, 396, 397, 398, 399];

const RAW_DIR = path.join(__dirname, '..', '..', 'data', 'imports', 'cfr-raw');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: 'application/xml', 'User-Agent': 'BOTDOT-CFR-fetcher/1.0' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
  });
}

// Pregunta a eCFR cual es el ultimo issue date para Title 49.
async function getLatestIssueDate() {
  const data = await fetchUrl('https://www.ecfr.gov/api/versioner/v1/titles.json');
  const json = JSON.parse(data);
  const t49 = (json.titles || []).find(t => t.number === 49);
  if (!t49 || !t49.latest_issue_date) {
    throw new Error('No se pudo determinar latest_issue_date para Title 49');
  }
  return t49.latest_issue_date;
}

function decodeEntities(s) {
  return s
    .replace(/&#xA7;/gi, '§')
    .replace(/&#xB6;/gi, '¶')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripInlineTags(s) {
  return s.replace(/<\/?[A-Z][A-Z0-9]*( [^>]*)?>/g, '');
}

function parsePartXml(xml, partNum) {
  const sections = [];
  const re = /<DIV8\s+N="([^"]+)"\s+TYPE="SECTION"[^>]*>([\s\S]*?)<\/DIV8>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const sectionNum = m[1];
    const inner = m[2];

    const headMatch = inner.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
    let title = headMatch ? decodeEntities(stripInlineTags(headMatch[1])).trim() : '';
    title = title.replace(/^§\s*[\d.]+\s*/, '').trim();

    const paragraphs = [];
    const pRe = /<P>([\s\S]*?)<\/P>/g;
    let pm;
    while ((pm = pRe.exec(inner)) !== null) {
      paragraphs.push(decodeEntities(stripInlineTags(pm[1])).trim());
    }
    const text = paragraphs.join('\n\n');

    if (!sectionNum) continue;
    sections.push({ section: sectionNum, title, text, part: partNum, keywords: [] });
  }
  return sections;
}

function autoKeywords(title) {
  const STOP = new Set(['for','the','and','with','from','that','this','part','of','to','in','on','a','an','or','by','as','be','is','are','at','it']);
  return (title || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !STOP.has(t))
    .slice(0, 8);
}

// Hash del contenido normativo (title + text). Usado para detectar cambios.
// Si cambia un solo caracter del texto, el hash cambia.
function hashContent(title, text) {
  return crypto.createHash('sha256').update(title + '|' + text, 'utf8').digest('hex');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Baja todas las Parts 380-399 desde eCFR y devuelve [{section, part, title,
 * text, keywords, content_hash, issue_date}, ...]. Cachea el XML crudo en
 * data/imports/cfr-raw/part-NNN.xml para no re-bajar en runs sucesivos
 * salvo que se pase noCache=true.
 */
async function fetchAllParts({ issueDate = null, noCache = false, log = () => {} } = {}) {
  const date = issueDate || await getLatestIssueDate();
  log(`Fetching CFR Title 49 issue ${date}, ${PARTS.length} Parts`);
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const all = [];
  for (let i = 0; i < PARTS.length; i++) {
    const partNum = PARTS[i];
    const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-49.xml?part=${partNum}`;
    const cachePath = path.join(RAW_DIR, `part-${partNum}.xml`);

    let xml;
    if (!noCache && fs.existsSync(cachePath)) {
      xml = fs.readFileSync(cachePath, 'utf8');
      log(`Part ${partNum}: cached`);
    } else {
      log(`Part ${partNum}: fetching...`);
      xml = await fetchUrl(url);
      fs.writeFileSync(cachePath, xml);
      await sleep(500); // cortesia a la API publica
    }

    const sections = parsePartXml(xml, partNum);
    for (const s of sections) {
      s.keywords = autoKeywords(s.title);
      s.content_hash = hashContent(s.title, s.text);
      s.issue_date = date;
    }
    all.push(...sections);
  }
  log(`Total: ${all.length} secciones de ${PARTS.length} Parts`);
  return { sections: all, issue_date: date };
}

module.exports = {
  fetchAllParts,
  getLatestIssueDate,
  parsePartXml,
  hashContent,
  autoKeywords,
  PARTS,
};
