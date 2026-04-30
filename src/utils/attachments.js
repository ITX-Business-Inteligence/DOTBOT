// Helpers para adjuntos (imagenes) en mensajes del chat.
//
// Limites: Anthropic acepta imagenes <=5MB cada una, hasta 100 por request.
// Aqui somos mas restrictivos para acotar costo y cuotas:
//   MAX_FILES_PER_MESSAGE = 5
//   MAX_BYTES_PER_FILE = 5 MB
//   MAX_BYTES_PER_MESSAGE (suma) = 20 MB
//
// Tipos aceptados: jpeg, png, webp, gif (los que la API de Claude soporta
// como image input).

const crypto = require('crypto');

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_FILES_PER_MESSAGE = 5;
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
const MAX_BYTES_PER_MESSAGE = 20 * 1024 * 1024;

class AttachmentError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Valida el array de archivos que viene de multer. No tira excepciones —
// devuelve { ok, error } para que el handler del route pueda responder
// con un 400 limpio.
function validateAttachments(files) {
  if (!files || !files.length) return { ok: true };
  if (files.length > MAX_FILES_PER_MESSAGE) {
    return { ok: false, error: `Maximo ${MAX_FILES_PER_MESSAGE} imagenes por mensaje. Recibidas: ${files.length}.` };
  }
  let total = 0;
  for (const f of files) {
    if (!ALLOWED_MIME.has(f.mimetype)) {
      return { ok: false, error: `Tipo no permitido: ${f.mimetype}. Solo JPEG, PNG, WEBP o GIF.` };
    }
    if (f.size > MAX_BYTES_PER_FILE) {
      return { ok: false, error: `"${f.originalname}" pesa ${Math.round(f.size/1024)}KB. Maximo ${MAX_BYTES_PER_FILE/1024/1024}MB por imagen.` };
    }
    total += f.size;
  }
  if (total > MAX_BYTES_PER_MESSAGE) {
    return { ok: false, error: `Suma total ${Math.round(total/1024/1024)}MB. Maximo ${MAX_BYTES_PER_MESSAGE/1024/1024}MB por mensaje.` };
  }
  return { ok: true };
}

// Calcula SHA-256 de un Buffer.
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Convierte una lista de adjuntos al formato content[] de la API de
// Anthropic, intercalado con el texto del usuario.
//
// Anthropic acepta:
//   { type:'text', text:'...' }
//   { type:'image', source:{ type:'base64', media_type:'image/png', data:'...' } }
//
// Convencion: imagenes PRIMERO, texto al final. La doc de Anthropic
// recomienda este orden — el modelo lee mejor el texto sabiendo que las
// imagenes son contexto.
function buildContentBlocks(text, files) {
  const blocks = [];
  for (const f of files || []) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: f.mimetype,
        data: f.buffer.toString('base64'),
      },
    });
  }
  if (text && text.trim()) {
    blocks.push({ type: 'text', text });
  }
  return blocks;
}

module.exports = {
  validateAttachments,
  sha256,
  buildContentBlocks,
  ALLOWED_MIME,
  MAX_FILES_PER_MESSAGE,
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_MESSAGE,
  AttachmentError,
};
