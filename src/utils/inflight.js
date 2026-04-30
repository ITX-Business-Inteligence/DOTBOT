// Tracker de requests en vuelo por usuario.
//
// Si un usuario ya tiene una request /chat/send corriendo, la siguiente
// es rechazada inmediatamente con 429. Esto cierra la race condition
// en el chequeo de presupuesto: como solo puede haber UNA request por
// usuario a la vez, los tokens consumidos por la actual ya estan en DB
// cuando llega la siguiente, y el cap se mantiene exacto.
//
// Vive en memoria del proceso. Si hubiera multi-instancia habria que
// migrar a Redis o equivalente — hoy es single-VPS y suficiente.

const inflight = new Set();

function isInflight(userId) {
  return inflight.has(userId);
}

function markInflight(userId) {
  inflight.add(userId);
}

function clearInflight(userId) {
  inflight.delete(userId);
}

module.exports = { isInflight, markInflight, clearInflight };
