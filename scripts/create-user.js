// Crea (o resetea password de) un usuario en BOTDOT.
//
// Uso:
//   node scripts/create-user.js <email> <password> [fullName] [role]
//
// Roles: dispatcher | supervisor | compliance | manager | admin (default: admin)
//
// Si el usuario ya existe, actualiza password / nombre / role y lo deja activo.

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../src/db/pool');

const VALID_ROLES = ['dispatcher', 'supervisor', 'compliance', 'manager', 'admin'];

(async () => {
  const [email, password, fullNameArg, roleArg] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Uso: node scripts/create-user.js <email> <password> [fullName] [role]');
    process.exit(1);
  }
  const fullName = fullNameArg || email.split('@')[0];
  const role = roleArg || 'admin';
  if (!VALID_ROLES.includes(role)) {
    console.error(`Role invalido "${role}". Validos: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO users (email, full_name, password_hash, role, active)
       VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       full_name     = VALUES(full_name),
       role          = VALUES(role),
       active        = 1`,
    [email, fullName, hash, role]
  );

  console.log(`OK: ${email} (${fullName}) creado/actualizado con role=${role}`);
  process.exit(0);
})().catch(e => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
