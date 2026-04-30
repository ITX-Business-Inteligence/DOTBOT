// Budget caps de Claude API.
//
// Dos defensas:
//   - Cap por usuario / dia (24h rolling): protege contra un usuario
//     individual que se descontrole.
//   - Cap global (org) / dia: cinturon de seguridad final, evita que el
//     mes entero se desangre.
//
// La semantica es 24h rolling, no calendar day. Esto es mas defensivo:
// alguien que haya gastado el cap a las 23:59 no se "resetea" a medianoche.
//
// Nota: hay race condition aceptable. Si un usuario dispara N requests
// concurrentes podria sobrepasar el cap por un margen pequeno (los tokens
// se contabilizan al recibir respuesta). Para uso interno con pocos
// usuarios el margen es menor y aceptable. Si esto fuera B2B con miles
// de usuarios, habria que reservar presupuesto ANTES de la llamada.

const config = require('../config');
const { spendUsd } = require('./pricing');

async function checkBudget(userId) {
  const userCap = config.chat.userDailyBudgetUsd;
  const orgCap = config.chat.orgDailyBudgetUsd;

  // Las dos consultas en paralelo — son independientes
  const [userSpent, orgSpent] = await Promise.all([
    spendUsd({ userId, hours: 24 }),
    spendUsd({ hours: 24 }),
  ]);

  const userOver = userCap > 0 && userSpent >= userCap;
  const orgOver  = orgCap  > 0 && orgSpent  >= orgCap;

  let allowed = true;
  let scope = null; // 'user' | 'org' | null
  if (orgOver) { allowed = false; scope = 'org'; }
  else if (userOver) { allowed = false; scope = 'user'; }

  // Numeros expuestos solo para uso interno (analytics / logs). El handler
  // de /chat/send NO los reenvia al cliente — el usuario no debe ver su
  // consumo ni su cap (decision de producto).
  return {
    allowed,
    scope,
    user_spent_usd: round2(userSpent),
    user_cap_usd: userCap,
    org_spent_usd: round2(orgSpent),
    org_cap_usd: orgCap,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { checkBudget };
