// scripts/migrate.js — Run database migrations in order
// Usage: node scripts/migrate.js

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  console.log('🔗 Connected to MySQL');

  // Create migrations tracking table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get already-applied migrations
  const [applied] = await db.execute('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map(r => r.filename));

  // Read migration files (must be named: 001_name.sql, 002_name.sql, etc.)
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  ⏭  Skipping  ${file}`);
      continue;
    }
    console.log(`  ▶  Applying  ${file}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.query(sql);
    await db.execute('INSERT INTO _migrations (filename) VALUES (?)', [file]);
    ran++;
    console.log(`  ✅ Applied   ${file}`);
  }

  if (ran === 0) console.log('✨ Database is up to date — no migrations to run');
  else console.log(`\n🎉 ${ran} migration(s) applied successfully`);

  await db.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
