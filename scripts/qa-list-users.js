// QA-only: lista users existentes para saber con quien testear el flow.
require('dotenv').config();
const db = require('../src/db/pool');
(async () => {
  const rows = await db.query('SELECT id, email, full_name, role, active, locked_at, must_change_password FROM users ORDER BY id LIMIT 30');
  console.log(JSON.stringify(rows, null, 2));
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
