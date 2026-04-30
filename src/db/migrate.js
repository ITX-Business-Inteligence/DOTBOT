// Migration runner para BOTDOT.
//
// Lee `migrations/NNN_*.sql` ordenado por nombre, aplica los pendientes
// en orden, y registra cada uno en `schema_migrations` con un checksum
// SHA-256 del contenido. Si una migration ya aplicada cambia de checksum
// el runner aborta — las migrations son INMUTABLES.
//
// Uso:
//   const { migrate } = require('./migrate');
//   await migrate();
//
//   o directo desde CLI:
//   node src/db/migrate.js
//   node src/db/migrate.js --status
//
// Para agregar una migration:
//   1. Crear archivo migrations/NNN_descripcion.sql con NNN > la ultima
//   2. Correr `npm run migrate`

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const VERSION_RE = /^(\d{3,})_.*\.sql$/;

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => VERSION_RE.test(f))
    .sort();
}

function versionOf(filename) {
  return filename.match(VERSION_RE)[1];
}

function checksumOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function ensureDatabaseAndMigrationsTable(conn) {
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${config.db.database}\``);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(20) NOT NULL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      duration_ms INT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function migrate({ verbose = true } = {}) {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  try {
    await ensureDatabaseAndMigrationsTable(conn);

    const [appliedRows] = await conn.query(
      `SELECT version, filename, checksum FROM schema_migrations`
    );
    const applied = new Map(appliedRows.map(r => [r.version, r]));

    const files = listMigrationFiles();
    if (files.length === 0) {
      if (verbose) console.log('No hay migrations en migrations/');
      return { newlyApplied: [], skipped: [] };
    }

    const newlyApplied = [];
    const skipped = [];

    for (const filename of files) {
      const version = versionOf(filename);
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = checksumOf(content);

      const prior = applied.get(version);
      if (prior) {
        if (prior.checksum !== checksum) {
          throw new Error(
            `Migration ${version} (${filename}) ya aplicada pero el contenido cambio.\n` +
            `  Aplicada con checksum: ${prior.checksum}\n` +
            `  Actual del archivo:    ${checksum}\n` +
            `Las migrations son inmutables. Para corregir, crea una nueva migration con un numero mayor.`
          );
        }
        if (prior.filename !== filename) {
          throw new Error(
            `Migration ${version} aplicada como "${prior.filename}" pero el archivo se renombro a "${filename}". No renombres archivos de migration.`
          );
        }
        skipped.push(filename);
        continue;
      }

      if (verbose) console.log(`Aplicando ${filename}...`);
      const t0 = Date.now();
      try {
        await conn.query(content);
      } catch (e) {
        throw new Error(`Migration ${filename} fallo: ${e.message}`);
      }
      const duration = Date.now() - t0;

      await conn.query(
        `INSERT INTO schema_migrations (version, filename, checksum, duration_ms)
         VALUES (?, ?, ?, ?)`,
        [version, filename, checksum, duration]
      );
      newlyApplied.push(filename);
      if (verbose) console.log(`  OK (${duration}ms)`);
    }

    if (verbose) {
      console.log(
        `Migrations: ${newlyApplied.length} aplicadas, ${skipped.length} ya estaban.`
      );
    }
    return { newlyApplied, skipped };
  } finally {
    await conn.end();
  }
}

async function status() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  try {
    const [rows] = await conn.query(
      `SELECT version, filename, applied_at, duration_ms
       FROM schema_migrations
       ORDER BY version ASC`
    );
    const fileSet = new Set(listMigrationFiles());
    const appliedSet = new Set(rows.map(r => r.filename));

    console.log('Migrations aplicadas:');
    for (const r of rows) {
      const onDisk = fileSet.has(r.filename) ? '' : '  [archivo NO existe en disco]';
      console.log(`  ${r.version}  ${r.filename}  ${r.applied_at.toISOString()}  ${r.duration_ms}ms${onDisk}`);
    }
    const pending = [...fileSet].filter(f => !appliedSet.has(f)).sort();
    if (pending.length) {
      console.log('\nMigrations pendientes:');
      for (const f of pending) console.log(`  ${f}`);
    } else {
      console.log('\nNo hay migrations pendientes.');
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrate, status };

if (require.main === module) {
  const arg = process.argv[2];
  const fn = arg === '--status' ? status : migrate;
  fn().then(() => process.exit(0)).catch(e => {
    console.error('Error en migrate:', e.message || e);
    process.exit(1);
  });
}
