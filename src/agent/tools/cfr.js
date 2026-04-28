// Tools para busqueda y consulta de CFRs.
// MVP usa un JSON local con secciones clave de 49 CFR Parts 380-399.
// Para escalar: reemplazar con vector DB (pgvector / Pinecone) y embeddings.

const fs = require('fs');
const path = require('path');

const CFR_INDEX_PATH = path.join(__dirname, '../../../data/cfrs/cfr-index.json');

let cfrIndex = null;
function loadIndex() {
  if (cfrIndex) return cfrIndex;
  if (!fs.existsSync(CFR_INDEX_PATH)) {
    console.warn(`CFR index no encontrado en ${CFR_INDEX_PATH}. Devolvera sin matches.`);
    cfrIndex = [];
    return cfrIndex;
  }
  cfrIndex = JSON.parse(fs.readFileSync(CFR_INDEX_PATH, 'utf8'));
  return cfrIndex;
}

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
}

function score(item, queryTokens) {
  const text = (item.section + ' ' + item.title + ' ' + item.text + ' ' + (item.keywords || []).join(' ')).toLowerCase();
  let s = 0;
  for (const t of queryTokens) {
    if (!t) continue;
    if (text.includes(t)) s += t.length >= 4 ? 3 : 1;
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
    const scored = index.map(item => ({ item, s: score(item, tokens) })).filter(x => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    return {
      query,
      matches: scored.slice(0, limit).map(x => ({
        section: x.item.section,
        title: x.item.title,
        excerpt: x.item.text.slice(0, 800),
        keywords: x.item.keywords || [],
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
