// Tools para busqueda y consulta de CFRs.
// JSON local con 49 CFR Parts 380-399 completos (~746 secciones).
// Generado por scripts/fetch-cfr.js desde la API publica de eCFR.gov.
// Para escalar a embeddings semanticos: pgvector / Pinecone.

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const CFR_INDEX_PATH = path.join(__dirname, '../../../data/cfrs/cfr-index.json');

let cfrIndex = null;
function loadIndex() {
  if (cfrIndex) return cfrIndex;
  if (!fs.existsSync(CFR_INDEX_PATH)) {
    logger.warn({ path: CFR_INDEX_PATH }, 'CFR index no encontrado, devolvera sin matches');
    cfrIndex = [];
    return cfrIndex;
  }
  cfrIndex = JSON.parse(fs.readFileSync(CFR_INDEX_PATH, 'utf8'));
  return cfrIndex;
}

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(/\s+/).filter(Boolean);
}

// Score multi-criteria: title matches valen mucho mas que body matches.
// Ademas prioriza match exacto de numero de seccion (ej. "395.3").
function score(item, queryTokens, queryRaw) {
  const titleLc = (item.title || '').toLowerCase();
  const sectionLc = (item.section || '').toLowerCase();
  const keywordsLc = (item.keywords || []).join(' ').toLowerCase();
  const bodyLc = (item.text || '').toLowerCase();
  const qLc = (queryRaw || '').toLowerCase();

  let s = 0;

  // (1) Match exacto de numero de seccion en query — peso muy alto
  // Ej: query "395.3" o "que dice 395.3" → seccion 395.3 al tope
  if (sectionLc && qLc.includes(sectionLc)) s += 100;

  // (2) Frase exacta de la query en titulo — peso muy alto
  if (qLc && qLc.length >= 4 && titleLc.includes(qLc)) s += 50;

  // (3) Tokens individuales — peso variable segun donde matchean
  for (const t of queryTokens) {
    if (!t || t.length < 2) continue;
    const isMeaningful = t.length >= 4;
    if (titleLc.includes(t))     s += isMeaningful ? 10 : 4;   // titulo
    if (sectionLc === t)          s += 30;                       // numero exacto
    if (keywordsLc.includes(t))   s += isMeaningful ? 5 : 2;    // keywords
    if (bodyLc.includes(t))       s += isMeaningful ? 1 : 0;    // body (ruido)
  }

  // (4) Si todos los tokens aparecen en titulo, bonus extra
  if (queryTokens.length >= 2 &&
      queryTokens.every(t => t.length >= 3 && titleLc.includes(t))) {
    s += 20;
  }

  return s;
}

const searchCfr = {
  definition: {
    name: 'search_cfr',
    description: 'Busca secciones del 49 CFR Parts 380-399 (FMCSRs) por keywords. Usalo cuando necesites fundamentar una afirmacion regulatoria. Devuelve top matches con seccion, titulo y texto.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Pregunta o tema a buscar (ej. "Personal Conveyance", "false log", "annual inspection")' },
        limit: { type: 'integer', description: 'Max matches a devolver. Default 5.', default: 5 },
      },
      required: ['query'],
    },
  },
  handler: async ({ query, limit = 5 }) => {
    const index = loadIndex();
    if (!index.length) return { matches: [], note: 'CFR index vacio - cargar data/cfrs/cfr-index.json' };
    const tokens = tokenize(query);
    const scored = index.map(item => ({ item, s: score(item, tokens, query) })).filter(x => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    return {
      query,
      total_matches: scored.length,
      matches: scored.slice(0, limit).map(x => ({
        section: x.item.section,
        title: x.item.title,
        excerpt: x.item.text.slice(0, 800),
        keywords: x.item.keywords || [],
        score: x.s,
      })),
    };
  },
};

const getCfrSection = {
  definition: {
    name: 'get_cfr_section',
    description: 'Devuelve el texto completo de una seccion CFR especifica.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Numero de seccion (ej. "395.3", "391.51", "382.701")' },
      },
      required: ['section'],
    },
  },
  handler: async ({ section }) => {
    const index = loadIndex();
    const match = index.find(i => i.section === section || i.section.startsWith(section));
    if (!match) return { error: `No se encontro la seccion ${section} en el indice CFR` };
    return match;
  },
};

module.exports = { searchCfr, getCfrSection };
