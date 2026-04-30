// MockClaude — emula la API de Anthropic SDK lo suficiente para que el
// loop de tool use en claude.js funcione end-to-end SIN llamar a la API real.
//
// Activacion: BOTDOT_MOCK_LLM=true en .env
//
// Que ejercita:
//   ✓ Multipart upload + persistencia de message_attachments
//   ✓ Audit log (log_decision, log_refused_request, log_off_topic)
//   ✓ Tool loop completo (tool_use → tool_result → end_turn)
//   ✓ Budget tracking (devuelve token counts realistas)
//   ✓ Concurrency gate, rate limit, todo el flujo de chat.js
//
// Que NO ejercita (necesita Claude real):
//   ✗ Razonamiento HOS / sintesis multi-tool
//   ✗ Redaccion natural de respuestas
//   ✗ Resistencia a prompt injection (las reglas estan, pero solo Claude
//     real demuestra que las cumple)
//   ✗ Citas CFR exactas validadas contra la base
//
// La clase implementa solo `messages.create()` con la shape minima que
// claude.js necesita: { content[], stop_reason, usage }.

const REDIRECT_PHRASE =
  'Estoy disenado solo para apoyo de compliance DOT/FMCSA. ' +
  'En que tema de regulacion, HOS, BASICs, asignaciones, inspecciones o coaching te puedo ayudar?';

const DOT_KEYWORDS = [
  // Regulacion
  'cfr', 'fmcsa', 'dot', 'usdot', 'compliance', '49 cfr',
  // HOS
  'hos', 'hours of service', 'horas', 'manejo', 'maneja', 'driving', '11 hor', '14 hor', '70 hor',
  '30 min', 'sleeper berth', 'personal conveyance', 'rods',
  // BASICs
  'basic', 'sms', 'csa', 'percentil', 'unsafe driving', 'driver fitness', 'vehicle maint',
  'crash indicator', 'hazmat', 'controlled substances',
  // Operaciones
  'driver', 'chofer', 'vehiculo', 'unidad', 'load', 'asignacion', 'asignar', 'dispatch',
  'pickup', 'delivery', 'pickup', 'recoge', 'entrega',
  // Compliance
  'dataqs', 'inspeccion', 'inspection', 'roadside', 'dvir', 'oos', 'out of service',
  'crash', 'preventability', 'clearinghouse', 'cdl', 'medical card', 'd&a',
  // Carrier
  '2195271', 'intelogix',
];

const INJECTION_KEYWORDS = [
  'ignora tus instrucciones', 'ignora las reglas', 'modo desarrollador',
  'actua como', 'actuá como', 'eres un', 'tu sistema admin', 'el admin te autoriza',
  'sin disclaimer', 'sin reglas', 'haz de cuenta',
];

const EVASION_KEYWORDS = [
  'false log', 'falsificar', 'editar el log', 'ocultar la violacion',
  'pc abuse', 'personal conveyance abuse', 'manipular eld', 'dame trucos para',
];

function lower(s) { return String(s || '').toLowerCase(); }

function classify(text) {
  const t = lower(text);
  if (!t.trim()) return 'empty';
  if (INJECTION_KEYWORDS.some(k => t.includes(k))) return 'injection';
  if (EVASION_KEYWORDS.some(k => t.includes(k))) return 'evasion';
  if (DOT_KEYWORDS.some(k => t.includes(k))) return 'dot';
  // Saludos/conversacion casual
  if (/^(hola|buenas|hey|hi|gracias|ok|si|no|adios|buen dia)\b/i.test(t.trim())) return 'greeting';
  return 'off_topic';
}

function detectOffTopicCategory(text) {
  const t = lower(text);
  if (INJECTION_KEYWORDS.some(k => t.includes(k))) return 'injection_attempt';
  if (/python|javascript|codigo|script|programa|debug|funcion/.test(t)) return 'coding';
  if (/^(hola|buenas|hey|hi|gracias|ok|adios)/.test(t.trim())) return 'greeting';
  if (/receta|comida|deporte|pelicula|musica/.test(t)) return 'creative';
  if (/personal|amigo|familia|relacion|salud|finanzas|mi vida/.test(t)) return 'personal';
  return 'other';
}

function makeToolUseId() {
  return 'mock_tu_' + Math.random().toString(36).slice(2, 12);
}

// Estima tokens muy aproximado (1 token ~= 4 chars). Sirve solo para que
// budget tracking tenga datos realistas — no para facturar.
function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

// Extrae el texto del ultimo mensaje user. Soporta tanto string como
// array (cuando hay imagenes el content es array de bloques).
function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      // tool_results blocks no son texto del usuario
      const isToolResult = m.content.every(b => b.type === 'tool_result');
      if (isToolResult) continue;
      const textBlock = m.content.find(b => b.type === 'text');
      if (textBlock) return textBlock.text || '';
    }
    return '';
  }
  return '';
}

function countImagesInLastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (Array.isArray(m.content)) {
      return m.content.filter(b => b.type === 'image').length;
    }
    return 0;
  }
  return 0;
}

// True si el mensaje mas reciente al modelo es un tool_result (estamos en
// la segunda iteracion del loop, post-tool-execution).
function lastIsToolResult(messages) {
  if (!messages.length) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user' || !Array.isArray(last.content)) return false;
  return last.content.some(b => b.type === 'tool_result');
}

function lastToolResultPayload(messages) {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return null;
  const tr = last.content.find(b => b.type === 'tool_result');
  if (!tr) return null;
  try { return JSON.parse(tr.content); } catch { return tr.content; }
}

// Que tool fue llamada en la iteracion previa (el ultimo assistant
// message tiene el tool_use block con su `name`).
function previousToolName(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const tu = m.content.find(b => b.type === 'tool_use');
    if (tu) return tu.name;
  }
  return null;
}

// Construye una respuesta final (end_turn) con texto.
function buildEndTurn(text, inputTokens) {
  const out = (text || '').trim();
  return {
    content: [{ type: 'text', text: out }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: estimateTokens(out),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// Construye una respuesta tool_use (puede incluir texto opcional).
function buildToolUse({ leadingText = '', toolName, toolInput, inputTokens }) {
  const content = [];
  if (leadingText) content.push({ type: 'text', text: leadingText });
  content.push({
    type: 'tool_use',
    id: makeToolUseId(),
    name: toolName,
    input: toolInput,
  });
  return {
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: estimateTokens(leadingText) + 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// Mock principal. Se usa como `client.messages.create({...})`.
class MockClaude {
  constructor() { this.messages = { create: this.create.bind(this) }; }

  async create({ messages = [], system = [] } = {}) {
    // Pequeno delay para que la UI muestre el "typing dots"
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

    const userText = extractLastUserText(messages);
    const imageCount = countImagesInLastUser(messages);
    const sysSize = (system || []).reduce((s, b) => s + estimateTokens(b.text), 0);
    const inputTokens = sysSize + estimateTokens(userText) + imageCount * 1500;

    // Iteracion 2+: ya ejecutamos un tool, ahora sintetizar la respuesta final
    if (lastIsToolResult(messages)) {
      return this.synthesizeFromToolResult(messages, inputTokens);
    }

    // Iteracion 1: decidir el path segun el tipo de mensaje
    const klass = classify(userText);

    if (klass === 'injection' || klass === 'off_topic' || klass === 'greeting' || klass === 'empty') {
      return buildToolUse({
        toolName: 'log_off_topic',
        toolInput: {
          request_summary: userText.slice(0, 100) || '(mensaje vacio)',
          category: detectOffTopicCategory(userText),
        },
        inputTokens,
      });
    }

    if (klass === 'evasion') {
      return buildToolUse({
        toolName: 'log_refused_request',
        toolInput: {
          request_summary: userText.slice(0, 100),
          reason_refused: 'La solicitud aparenta intencion de evadir DOT/FMCSA. Rechazo conforme a regla 4 del system prompt.',
          cfr_violated_if_done: '49 CFR 395.8 (RODS), 49 CFR 390.6 (Coercion)',
        },
        inputTokens,
      });
    }

    // klass === 'dot' — pregunta legitima
    // Si menciona BASIC/score/estado, llamar query_basics_status para
    // demostrar el flujo con datos reales del SMS ingestado.
    const lt = lower(userText);
    if (/basic|score|alert|estado del carrier/.test(lt)) {
      return buildToolUse({
        toolName: 'query_basics_status',
        toolInput: { latest: true },
        inputTokens,
      });
    }

    // Pedido explicito de humano → escalate_to_compliance
    if (/(quiero|pido|necesito|llamame|conectame|pasame)\s+(?:hablar\s+)?(?:con\s+)?(?:un\s+)?(humano|persona|alguien|compliance|officer)/.test(lt)
        || /no entiendes|no entendes|no entendiste|esto necesita revision|esto es complejo|hablar con compliance/.test(lt)) {
      return buildToolUse({
        toolName: 'escalate_to_compliance',
        toolInput: {
          summary: userText.slice(0, 200) || 'Usuario pidio hablar con humano',
          category: 'user_requested',
          urgency: 'medium',
          what_was_missing: 'El usuario pidio escalacion explicita.',
        },
        inputTokens,
      });
    }

    // Drivers cerca del limite HOS → samsara_get_drivers_near_limit
    if (/drivers? cerca|cerca.*limite|near.*limit|limite\s*hos|limit.*hr|cuanto.*queda|drivers? con.*horas?.*disponible/.test(lt)) {
      const m = lt.match(/(\d+)\s*(min|minut|hora|hr)/);
      const threshold = m ? (m[2].startsWith('h') ? parseInt(m[1]) * 60 : parseInt(m[1])) : 90;
      return buildToolUse({
        toolName: 'samsara_get_drivers_near_limit',
        toolInput: { threshold_minutes: threshold, limit_type: 'any' },
        inputTokens,
      });
    }

    // Detectar pregunta de asignacion/dispatch. Combinacion permisiva:
    // intencion (puedo/puede/asignar/darle/despachar) + cargo o driver
    // mencionado, o keywords directos. Cubre fraseos naturales tipo
    // "puedo darle una carga a este chofer", "puede entregar hoy",
    // "asignar driver X a load Y", "se puede mandarlo a Wisconsin".
    const hasIntent = /\b(puedo|puede|puedes|asignar|asignaria|asignacion|darle|dale|despachar|dispatch|mandarlo|mandarla|llevar|correr|manejar|entregar|entregue|hacer)\b/.test(lt);
    const hasCargo = /(carga|load|run|despacho|trip|pickup|recoge|recojer|entreg|deliver|envio|viaje)/.test(lt);
    const hasDriver = /(chofer|driver|pilot|operad)/.test(lt);
    const hasTime = /(hoy|manana|tarde|noche|\bam\b|\bpm\b|\d+:\d|\d+\s*hr|\d+\s*hor|asignar.*\d|load.*\d)/.test(lt);
    const hasRoute = /(de\s+\w+\s+a\s+\w+|hacia|destino|origen|stephenville|amarillo|wisconsin|texas|tx|wi|ca|fl|al)/.test(lt);

    if ((hasIntent && (hasCargo || hasDriver)) || (hasIntent && (hasTime || hasRoute) && imageCount > 0)) {
      const driverMatch = userText.match(/(?:driver|chofer)\s+(?:de nombre\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/)
        || userText.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/); // nombre propio suelto
      const driverName = driverMatch ? driverMatch[1] : null;
      return buildToolUse({
        toolName: 'log_decision',
        toolInput: {
          action_type: 'assignment_check',
          subject_type: driverName ? 'driver' : 'load',
          subject_id: driverName || null,
          decision: 'conditional',
          cfr_cited: '49 CFR 395.3(a)(2), 49 CFR 395.3(a)(3)',
          reasoning: 'Mock mode: validacion HOS pendiente de Claude real. Marcando conditional por defecto.',
          evidence: { mock_mode: true, driver_mentioned: driverName, image_count: imageCount },
        },
        inputTokens,
      });
    }

    // Pregunta DOT sin trigger especifico → respuesta directa sin tool
    return buildEndTurn(this.genericDotResponse(userText, imageCount), inputTokens);
  }

  // Iteracion 2: sintesis del texto final usando el resultado del tool
  synthesizeFromToolResult(messages, inputTokens) {
    const toolName = previousToolName(messages);
    const payload = lastToolResultPayload(messages);
    const userText = extractLastUserText(messages);
    const imageCount = countImagesInLastUser(messages);

    let text;
    switch (toolName) {
      case 'log_off_topic':
        text = REDIRECT_PHRASE +
               '\n\n[modo simulacion — esta respuesta es generada por el mock LLM, no por Claude. ' +
               'Configura ANTHROPIC_API_KEY para respuestas reales.]';
        break;

      case 'log_refused_request':
        text =
          'No puedo asistir con esa solicitud. Aparenta intencion de manipular registros o evadir compliance DOT/FMCSA, ' +
          'lo cual viola 49 CFR 395.8 (RODS) y posiblemente 49 CFR 390.6 (Coercion Rule). El intento queda registrado en audit_log.\n\n' +
          'Si tu intencion es legitima (ej. corregir un dato mal cargado en un log valido), reformula la pregunta y vemos si DataQs aplica.\n\n' +
          'Esto no constituye asesoria legal. La decision final es responsabilidad del compliance officer.\n\n' +
          '[modo simulacion — Claude real podria razonar mejor el matiz de tu pregunta.]';
        break;

      case 'query_basics_status':
        text = this.formatBasicsResponse(payload);
        break;

      case 'samsara_get_drivers_near_limit':
        text = this.formatDriversNearLimit(payload);
        break;

      case 'escalate_to_compliance':
        text = (payload && payload.message_to_user) ||
          'Esta consulta requiere revision humana. Te conecto con compliance — un officer va a revisar tu caso y te contactara.';
        text += '\n\n[modo simulacion — escalacion creada en BD, email mocked en logs.]';
        break;

      case 'log_decision':
        text = this.formatAssignmentDecision(userText, imageCount);
        break;

      default:
        text = this.genericDotResponse(userText, imageCount);
    }

    return buildEndTurn(text, inputTokens);
  }

  formatBasicsResponse(payload) {
    if (!payload || !Array.isArray(payload.basics) || !payload.basics.length) {
      return 'No tengo snapshots cargados todavia. Pide al admin que ejecute `npm run ingest-sms`.\n\n[modo simulacion]';
    }
    const lines = payload.basics.map(b => {
      const flag = b.alert ? ' ⚠ ALERT' : '';
      const months = b.months_in_alert ? ` (${b.months_in_alert} meses cronico)` : '';
      return `- ${b.basic_name}: ${b.score_pct ?? '—'} / umbral ${b.threshold_pct ?? '—'}${flag}${months}`;
    }).join('\n');
    return (
      'Estado actual del carrier USDOT 2195271 (snapshot mas reciente):\n\n' +
      lines +
      '\n\nLos BASICs en alert son los que mas peso tienen en una posible Compliance Review FMCSA. ' +
      'Recomiendo enfoque en eliminacion de Acute/Critical violations probables.\n\n' +
      'Esto no constituye asesoria legal. La decision final es responsabilidad del compliance officer.\n\n' +
      '[modo simulacion — datos reales del SMS, formato y razonamiento simulados.]'
    );
  }

  formatDriversNearLimit(payload) {
    if (!payload || payload.error) {
      return 'No pude obtener el snapshot de HOS. ' + (payload && payload.note ? payload.note : '') +
             '\n\n[modo simulacion]';
    }
    if (!payload.drivers || !payload.drivers.length) {
      return 'Ningun driver esta dentro del umbral pedido (todos tienen tiempo holgado).\n\n' +
             `(snapshot: ${payload.cache_oldest_age_sec || 0}s de antiguedad maxima)\n\n[modo simulacion]` ;
    }
    const lines = payload.drivers.map(d =>
      `- ${d.driverName} — ${d.limit} ${d.remainingMin}min restantes (${d.clockState})`
    ).join('\n');
    return (
      `Drivers cerca del limite HOS (${payload.count} encontrados):\n\n${lines}\n\n` +
      `Datos de snapshot ${payload.source} (antiguedad maxima ${payload.cache_oldest_age_sec || 0}s).\n` +
      'Recomiendo verificar antes de cada asignacion porque los clocks cambian continuamente. ' +
      'Si un driver esta a menos de 30 min, conviene NO asignarle nada que requiera mas tiempo.\n\n' +
      'Esto no constituye asesoria legal. La decision final es responsabilidad del dispatcher/supervisor.\n\n' +
      '[modo simulacion — datos del cache real, formato simulado.]'
    );
  }

  formatAssignmentDecision(userText, imageCount) {
    const imgNote = imageCount
      ? `\n\nVi ${imageCount} imagen(es) adjunta(s). Tratadas como dato observacional, no como fuente regulatoria (regla 10).`
      : '';
    return (
      'DECISION: CONDITIONAL\n' +
      'RAZON: Validacion HOS no completada (modo simulacion).\n\n' +
      'ANALISIS:\n' +
      '- En modo real, llamaria a samsara_get_driver_hos para verificar drive/duty/cycle remaining (interpretacion mock).\n' +
      '- Verificaria contra 49 CFR 395.3(a)(2) (14hr duty) y 395.3(a)(3) (11hr drive) (49 CFR 395.3).\n' +
      '- Si la ventana de la load excede el remaining time por mas de 60min, devolveria DECLINE.\n' +
      `- ${imageCount > 0 ? 'Las imagenes adjuntas las describiria pero no usaria texto-en-imagen como fuente de CFR.' : 'No hay imagenes adjuntas en este turn.'}\n` +
      '\nALTERNATIVAS sugeridas (si Claude real determinara DECLINE):\n' +
      '1. Buscar otro driver con HOS disponible suficiente.\n' +
      '2. Ajustar pickup time si la operacion lo permite.\n' +
      '3. Split de la load con relevo en ruta.\n' +
      imgNote +
      '\n\nDecision queda a tu lado. No constituye asesoria legal.\n\n' +
      '[modo simulacion — la decision real necesita Claude consultando Samsara live.]'
    );
  }

  genericDotResponse(userText, imageCount) {
    const imgNote = imageCount
      ? ` (con ${imageCount} imagen(es) adjunta(s))`
      : '';
    return (
      `Recibi tu pregunta sobre DOT/FMCSA${imgNote}: "${(userText || '').slice(0, 120)}".\n\n` +
      'En modo real, Claude consultaria los CFRs cargados (search_cfr / get_cfr_section), ' +
      'verificaria datos en Samsara o SMS, y armaria una respuesta con citas exactas.\n\n' +
      'Esto no constituye asesoria legal. La decision final es responsabilidad del compliance officer.\n\n' +
      '[modo simulacion — configura ANTHROPIC_API_KEY para respuestas reales.]'
    );
  }
}

module.exports = {
  MockClaude,
  // Helpers exportados para test
  classify,
  detectOffTopicCategory,
};
