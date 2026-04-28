// Script de inicializacion de DB.
// Ejecuta el schema.sql y crea el usuario admin con password real.
// Uso: node src/db/init.js

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const config = require('../config');

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  console.log(`Creando base de datos '${config.db.database}' si no existe...`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${config.db.database}\``);

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Ejecutando schema.sql...');
  await conn.query(schema);

  // Crear admin con password real
  const adminPass = process.env.ADMIN_INITIAL_PASSWORD || 'changeme123';
  const hash = await bcrypt.hash(adminPass, 10);
  await conn.query(
    `INSERT INTO users (email, full_name, password_hash, role)
     VALUES (?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    ['admin@intelogix.mx', 'Administrador', hash]
  );

  console.log('Schema instalado. Usuario admin: admin@intelogix.mx');
  console.log(`Password inicial: ${adminPass} (CAMBIAR INMEDIATAMENTE)`);

  await conn.end();
}

main().catch(e => {
  console.error('Error inicializando DB:', e);
  process.exit(1);
});
