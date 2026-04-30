// QA-only: setea una password (de env QA_PASSWORD o argv[2]) en los test
// users que matchean *@test.local. Para uso en QA local SOLO. NO correr en
// produccion — falla seguro porque no hay test users en prod, pero igual.
//
// Uso:
//   QA_PASSWORD='secret123' node scripts/qa-set-test-passwords.js
//   node scripts/qa-set-test-passwords.js 'secret123'
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../src/db/pool');

const PWD = process.argv[2] || process.env.QA_PASSWORD;
if (!PWD || PWD.length < 8) {
  console.error('Error: pasa una password >=8 chars via argv o QA_PASSWORD env.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Error: este script no debe correrse en NODE_ENV=production.');
  process.exit(1);
}
(async () => {
  const hash = await bcrypt.hash(PWD, 12);
  const result = await db.query(
    `UPDATE users SET password_hash = ?, must_change_password = 0, locked_at = NULL, failed_login_count = 0
     WHERE email LIKE '%@test.local'`,
    [hash]
  );
  console.log(`Updated ${result.affectedRows} test users.`);
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
