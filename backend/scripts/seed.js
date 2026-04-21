// scripts/seed.js — Seed initial data for FastConnect
// Usage: node scripts/seed.js [--reset]
// --reset flag drops all existing data first

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@FastConnect2024!';

async function seed() {
  const reset = process.argv.includes('--reset');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  console.log('🌱 Seeding FastConnect database...\n');

  if (reset) {
    console.log('⚠️  RESET MODE — clearing existing data...');
    await db.query(`
      SET FOREIGN_KEY_CHECKS=0;
      TRUNCATE TABLE audit_logs;
      TRUNCATE TABLE vouchers;
      TRUNCATE TABLE payments;
      TRUNCATE TABLE sessions;
      TRUNCATE TABLE device_sessions;
      TRUNCATE TABLE plan_history;
      TRUNCATE TABLE pricing_plans;
      TRUNCATE TABLE routers;
      TRUNCATE TABLE system_settings;
      TRUNCATE TABLE users;
      SET FOREIGN_KEY_CHECKS=1;
    `);
    console.log('  ✅ Cleared all tables\n');
  }

  // ── Admin User ────────────────────────────────────────────────
  console.log('👤 Creating admin user...');
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await db.execute(`
    INSERT IGNORE INTO users (username, email, password_hash, role, mfa_enabled)
    VALUES ('admin', 'admin@fastconnect.co.ke', ?, 'admin', 0)
  `, [hash]);
  console.log(`  ✅ Admin created (username: admin, password: ${ADMIN_PASSWORD})\n`);

  // ── Pricing Plans ─────────────────────────────────────────────
  console.log('📋 Creating pricing plans...');
  const plans = [
    ['2 Hours',  2,   10,  2, '{"unlimited_data":true,"speed":"2 Mbps","devices":1}', 1, 0, 1],
    ['4 Hours',  4,   15,  2, '{"unlimited_data":true,"speed":"2 Mbps","devices":1}', 1, 0, 2],
    ['8 Hours',  8,   25,  2, '{"unlimited_data":true,"speed":"2 Mbps","devices":1}', 1, 0, 3],
    ['24 Hours', 24,  40,  2, '{"unlimited_data":true,"speed":"2 Mbps","devices":1}', 1, 1, 4],
    ['Weekly',   168, 200, 2, '{"unlimited_data":true,"speed":"2 Mbps","devices":1}', 1, 0, 5],
    ['Monthly',  720, 600, 2, '{"unlimited_data":true,"speed":"2 Mbps","devices":1}', 1, 0, 6],
  ];
  for (const [name, hours, price, bw, features, active, popular, order] of plans) {
    await db.execute(`
      INSERT IGNORE INTO pricing_plans (name, duration_hours, price_kes, bandwidth_limit_mbps, features_json, is_active, is_popular, display_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [name, hours, price, bw, features, active, popular, order]);
    console.log(`  ✅ Plan: ${name} — KES ${price}`);
  }

  // ── Demo Voucher ──────────────────────────────────────────────
  console.log('\n🎟 Creating demo voucher...');
  await db.execute(`
    INSERT IGNORE INTO vouchers (voucher_code, plan_id, plan_snapshot_json, generated_by, expires_at)
    VALUES ('FC-DEMO-2024', 4,
      '{"id":4,"name":"24 Hours","price_kes":40,"duration_hours":24,"bandwidth_limit_mbps":2}',
      1, '2026-12-31 23:59:59')
  `);
  console.log('  ✅ Demo voucher: FC-DEMO-2024 (24 Hours free)\n');

  // ── System Settings ───────────────────────────────────────────
  console.log('⚙️  Inserting system settings...');
  const settings = [
    ['session_timeout_minutes',  '30',                      'integer', 'Admin session inactivity timeout'],
    ['mpesa_environment',        'sandbox',                  'string',  'M-Pesa API environment'],
    ['backup_retention_days',    '30',                      'integer', 'Backup retention period in days'],
    ['max_devices_per_phone',    '5',                       'integer', 'Max concurrent devices per phone number'],
    ['portal_title',             'FastConnect Internet',    'string',  'Title shown on captive portal'],
    ['support_phone',            '+254 700 000 000',        'string',  'Support contact shown to users'],
    ['ws_ping_interval',         '30',                      'integer', 'WebSocket heartbeat interval (seconds)'],
    ['plan_cache_ttl',           '300',                     'integer', 'Plan cache TTL in seconds'],
  ];
  for (const [key, val, type, desc] of settings) {
    await db.execute(`
      INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
      VALUES (?, ?, ?, ?)
    `, [key, val, type, desc]);
  }
  console.log(`  ✅ ${settings.length} settings configured\n`);

  // ── Cache Invalidation Record ─────────────────────────────────
  await db.execute(`
    INSERT IGNORE INTO plan_cache_invalidation (last_invalidated_at, invalidated_by)
    VALUES (NOW(), 'seed')
  `);

  console.log('🎉 Database seeded successfully!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Admin URL:      https://admin.fastconnect.co.ke');
  console.log('  Admin user:     admin');
  console.log(`  Admin password: ${ADMIN_PASSWORD}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('⚠️  Change the admin password after first login!');

  await db.end();
}

seed().catch(err => {
  console.error('❌ Seeding failed:', err.message);
  process.exit(1);
});
