// Inicializacion de DB: corre migrations pendientes y crea / actualiza
// el usuario admin. Idempotente — se puede correr en cada deploy.
//
// Uso: node src/db/init.js
//      ADMIN_INITIAL_PASSWORD=micontrasena node src/db/init.js

const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const config = require('./../config');
const { migrate } = require('./migrate');

async function main() {
  console.log(`BD destino: ${config.db.database} en ${config.db.host}:${config.db.port}`);

  // 1. Aplicar migraciones pendientes (crea DB si no existe)
  await migrate();

  // 2. Asegurar usuario admin
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  try {
    const adminPass = process.env.ADMIN_INITIAL_PASSWORD || 'changeme123';
    const hash = await bcrypt.hash(adminPass, 12);
    await conn.query(
      `INSERT INTO users (email, full_name, password_hash, role)
         VALUES (?, ?, ?, 'admin')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
      ['admin@intelogix.mx', 'Administrador', hash]
    );
    console.log(`Usuario admin: admin@intelogix.mx`);
    console.log(`Password inicial: ${adminPass} (CAMBIAR INMEDIATAMENTE)`);
  } finally {
    await conn.end();
  }
}

main().catch(e => {
  console.error('Error inicializando DB:', e.message || e);
  process.exit(1);
});
