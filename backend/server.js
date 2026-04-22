// ============================================================
// FastConnect Internet — Backend API Server
// Node.js / Express — Production Ready
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');
const axios = require('axios');
const { NodeSSH } = require('node-ssh');
const speakeasy = require('speakeasy');
const cookieParser = require('cookie-parser');
const { createClient } = require('redis');
const winston = require('winston');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ============================================================
// LOGGER
// ============================================================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    ...(process.env.NODE_ENV !== 'production' ? [new winston.transports.Console({ format: winston.format.simple() })] : [])
  ],
});

// ============================================================
// DATABASE POOL (MySQL with SSL - accept self-signed certs)
// ============================================================
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'fastconnect',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'fastconnect_db',
  port: parseInt(process.env.DB_PORT) || 3306,
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
});

// Test database connection on startup
(async function testDbConnection() {
  try {
    const conn = await db.getConnection();
    console.log('✅ Database connected successfully to Aiven MySQL');
    conn.release();
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('Please check your DB_HOST, DB_USER, DB_PASSWORD environment variables');
  }
})();

// ============================================================
// REDIS CLIENT
// ============================================================
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', err => logger.error('Redis Client Error', err));
(async () => { await redis.connect(); })();

// ============================================================
// ENCRYPTION UTILITIES
// ============================================================
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  if (!text) return null;
  const [ivHex, encrypted] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============================================================
// JWT UTILITIES (RS256)
// ============================================================
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');

function signAccessToken(payload) {
  return jwt.sign(payload, JWT_PRIVATE_KEY, { algorithm: 'RS256', expiresIn: '15m' });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] });
}

// ============================================================
// MIDDLEWARE: AUTH
// ============================================================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);
    if (payload.ip !== req.ip || payload.ua !== req.get('User-Agent')) {
      return res.status(401).json({ error: 'Session invalid' });
    }
    const revoked = await redis.get(`revoked:${token}`);
    if (revoked) return res.status(401).json({ error: 'Token revoked' });
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// ============================================================
// VALIDATION HELPERS
// ============================================================
const phoneRegex = /^(?:(?:254|0)(?:7|1)\d{8})$/;
const voucherRegex = /^FC-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  }
  if (!cleaned.startsWith('254')) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array().map(e => ({ field: e.path, msg: e.msg })) 
    });
  }
  next();
}

// ============================================================
// AUDIT LOGGING
// ============================================================
async function auditLog(userId, action, entityType, entityId, oldValues, newValues, req) {
  try {
    await db.execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, action, entityType, entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        req?.ip, req?.get('User-Agent')?.slice(0, 500)]
    );
  } catch (err) {
    logger.error('Audit log failed', err);
  }
}

// ============================================================
// MIKROTIK SSH MANAGER
// ============================================================
class MikroTikManager {
  constructor() { 
    this.connections = new Map(); 
  }

  async getConnection(router) {
    if (this.connections.has(router.id)) {
      const conn = this.connections.get(router.id);
      try {
        if (conn.isConnected()) return conn;
      } catch {
        this.connections.delete(router.id);
      }
    }
    
    const ssh = new NodeSSH();
    await ssh.connect({
      host: router.ip_address,
      port: router.api_port || 22,
      username: router.username,
      password: router.password_decrypted || router.password,
      readyTimeout: 10000,
    });
    
    this.connections.set(router.id, ssh);
    return ssh;
  }

  async createHotspotUser(router, { username, password, profile, uptime, bandwidthMbps }) {
    const ssh = await this.getConnection(router);
    const rateLimit = `${bandwidthMbps}M/${bandwidthMbps}M`;
    await ssh.execCommand(
      `/ip hotspot user add name="${username}" password="${password}" profile="${profile}" uptime="${uptime}" rate-limit="${rateLimit}" comment="FastConnect"`
    );
    logger.info(`Created hotspot user ${username} on router ${router.id}`);
  }

  async removeHotspotUser(router, username) {
    const ssh = await this.getConnection(router);
    await ssh.execCommand(`/ip hotspot user remove [find name="${username}"]`);
    await ssh.execCommand(`/ip hotspot active remove [find user="${username}"]`);
    logger.info(`Removed hotspot user ${username} from router ${router.id}`);
  }

  async checkHealth(router) {
    try {
      const ssh = await this.getConnection(router);
      await ssh.execCommand('/system identity print');
      return true;
    } catch (err) {
      this.connections.delete(router.id);
      return false;
    }
  }

  generateCredentials() {
    const username = `fc_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8);
    return { username, password };
  }

  hoursToMikroTik(hours) {
    const h = Math.floor(hours);
    const m = Math.floor((hours % 1) * 60);
    return `${h}:${m.toString().padStart(2, '0')}:00`;
  }
}

const mikrotik = new MikroTikManager();

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/plans' });

const wsClients = new Set();

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  logger.info(`WebSocket client connected. Total: ${wsClients.size}`);
  
  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info(`WebSocket client disconnected. Total: ${wsClients.size}`);
  });
  
  ws.on('error', (err) => logger.error('WebSocket error', err));
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

setInterval(() => {
  wsClients.forEach(ws => {
    if (!ws.isAlive) {
      wsClients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function broadcastPlanUpdate(action, planData) {
  const message = JSON.stringify({ action, plan: planData, timestamp: Date.now() });
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
  redis.publish('plan_updates', message).catch(err => logger.error('Redis publish error', err));
  logger.info(`Plan update broadcast: ${action}`, { planId: planData?.id });
}

// ============================================================
// EXPRESS SETUP
// ============================================================
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "wss:"],
      frameAncestors: ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ============================================================
// CORS CONFIGURATION - FIXED (Allow all origins for testing)
// ============================================================
app.use(cors({
  origin: '*',  // Allow all origins - TEMPORARY for captive portal
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'Idempotency-Key']
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ============================================================
// DATABASE TEST ENDPOINT
// ============================================================
app.get('/api/db-test', async (req, res) => {
  try {
    const [result] = await db.query('SELECT 1 as connected, NOW() as time, DATABASE() as database_name');
    res.json({ 
      success: true, 
      connected: true,
      database: result[0].database_name,
      time: result[0].time,
      message: 'Database connection successful'
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message,
      code: err.code
    });
  }
});

// ============================================================
// CREATE TABLES ENDPOINT - Use this to create tables
// ============================================================
app.get('/api/create-tables', async (req, res) => {
  const authKey = req.query.key;
  if (authKey !== 'FASTCONNECT_MIGRATE_2024') {
    return res.status(401).json({ error: 'Invalid key' });
  }
  
  try {
    console.log('Creating tables...');
    
    // Create pricing_plans table
    await db.query(`
      CREATE TABLE IF NOT EXISTS pricing_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        duration_hours DECIMAL(10,2) NOT NULL,
        price_kes DECIMAL(10,2) NOT NULL,
        bandwidth_limit_mbps DECIMAL(5,2) DEFAULT 2.00,
        features_json JSON,
        is_active TINYINT(1) DEFAULT 1,
        is_popular TINYINT(1) DEFAULT 0,
        display_order INT DEFAULT 0,
        created_by INT,
        updated_by INT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME
      )
    `);
    console.log('✅ pricing_plans table created');
    
    // Create users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'staff',
        mfa_secret TEXT,
        mfa_enabled TINYINT(1) DEFAULT 0,
        last_login_ip VARCHAR(45),
        last_login_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME
      )
    `);
    console.log('✅ users table created');
    
    // Create sessions table
    await db.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone_number TEXT,
        plan_id INT,
        plan_snapshot_json JSON,
        router_id INT,
        device_id TEXT,
        hotspot_username VARCHAR(100),
        hotspot_password TEXT,
        ip_address VARCHAR(45),
        user_agent VARCHAR(500),
        start_time DATETIME,
        end_time DATETIME,
        data_used_mb DECIMAL(12,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        original_bandwidth_limit DECIMAL(5,2),
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ sessions table created');
    
    // Create payments table
    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        idempotency_key VARCHAR(255) UNIQUE,
        phone_number TEXT,
        plan_id INT,
        plan_snapshot_json JSON,
        amount_kes DECIMAL(10,2),
        mpesa_receipt_number VARCHAR(100),
        transaction_id VARCHAR(255),
        checkout_request_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'pending',
        result_code INT,
        result_desc VARCHAR(500),
        callback_data JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )
    `);
    console.log('✅ payments table created');
    
    // Create vouchers table
    await db.query(`
      CREATE TABLE IF NOT EXISTS vouchers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        voucher_code VARCHAR(20) UNIQUE,
        plan_id INT,
        plan_snapshot_json JSON,
        is_used TINYINT(1) DEFAULT 0,
        used_by_phone TEXT,
        generated_by INT,
        used_at DATETIME,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ vouchers table created');
    
    // Create audit_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        action VARCHAR(100),
        entity_type VARCHAR(50),
        entity_id INT,
        old_values JSON,
        new_values JSON,
        ip_address VARCHAR(45),
        user_agent VARCHAR(500),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ audit_logs table created');
    
    // Create routers table
    await db.query(`
      CREATE TABLE IF NOT EXISTS routers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        api_port INT DEFAULT 22,
        username VARCHAR(100) NOT NULL,
        password_encrypted TEXT NOT NULL,
        hotspot_profile VARCHAR(100) DEFAULT 'fastconnect',
        location VARCHAR(200),
        is_active TINYINT(1) DEFAULT 1,
        last_health_check DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ routers table created');
    
    // Insert admin user
    await db.query(`
      INSERT IGNORE INTO users (username, email, password_hash, role) VALUES 
      ('admin', 'admin@fastconnect.co.ke', '$2b$12$9EvQi6vX3LxJ8zDx.Aq1TOY9gq4K5x7z9Qr7WkbzFqIHypI/1.Am6', 'admin')
    `);
    console.log('✅ Admin user inserted');
    
    // Insert plans
    await db.query(`
      INSERT IGNORE INTO pricing_plans (name, duration_hours, price_kes, bandwidth_limit_mbps, features_json, is_popular, display_order) VALUES
      ('2 Hours', 2, 10, 2, '{"unlimited_data": true}', 0, 1),
      ('4 Hours', 4, 15, 2, '{"unlimited_data": true}', 0, 2),
      ('8 Hours', 8, 25, 2, '{"unlimited_data": true}', 0, 3),
      ('24 Hours', 24, 40, 2, '{"unlimited_data": true}', 1, 4),
      ('Weekly', 168, 200, 2, '{"unlimited_data": true}', 0, 5),
      ('Monthly', 720, 600, 2, '{"unlimited_data": true}', 0, 6)
    `);
    console.log('✅ Plans inserted');
    
    // Insert demo voucher
    await db.query(`
      INSERT IGNORE INTO vouchers (voucher_code, plan_id, plan_snapshot_json, expires_at) VALUES
      ('FC-DEMO-2024', 4, '{"id":4,"name":"24 Hours","price_kes":40,"duration_hours":24,"bandwidth_limit_mbps":2}', '2026-12-31 23:59:59')
    `);
    console.log('✅ Demo voucher inserted');
    
    res.json({ success: true, message: 'All tables created and data inserted successfully!' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// RATE LIMITERS
// ============================================================
const globalLimiter = rateLimit({
  windowMs: 60000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  keyGenerator: req => req.ip,
});

const loginLimiter = rateLimit({
  windowMs: 30 * 60000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 30 minutes.' },
  keyGenerator: req => req.ip,
});

const paymentLimiter = rateLimit({
  windowMs: 60000,
  max: 3,
  keyGenerator: req => req.body?.phone || req.ip,
  message: { error: 'Payment rate limit exceeded' },
});

const adminLimiter = rateLimit({
  windowMs: 60000,
  max: 30,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Admin rate limit exceeded' },
});

app.use(globalLimiter);

// ============================================================
// PLAN CACHE
// ============================================================
const PLAN_CACHE_TTL = 300;

async function getCachedPlans() {
  const cached = await redis.get('plans:active');
  if (cached) return JSON.parse(cached);
  
  const [rows] = await db.execute(
    'SELECT * FROM pricing_plans WHERE is_active = 1 AND deleted_at IS NULL ORDER BY display_order ASC'
  );
  await redis.setEx('plans:active', PLAN_CACHE_TTL, JSON.stringify(rows));
  return rows;
}

async function invalidatePlanCache() {
  await redis.del('plans:active');
  await redis.set('plan_cache_invalidation_ts', Date.now());
  await db.execute('INSERT INTO plan_cache_invalidation (last_invalidated_at, invalidated_by) VALUES (NOW(), "system")');
}

// ============================================================
// M-PESA DARAJA API
// ============================================================
const MPESA_BASE = process.env.MPESA_ENVIRONMENT === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

let mpesaToken = null;
let mpesaTokenExpiry = 0;

async function getMpesaToken() {
  if (mpesaToken && Date.now() < mpesaTokenExpiry) return mpesaToken;
  
  const credentials = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  
  mpesaToken = res.data.access_token;
  mpesaTokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
  return mpesaToken;
}

async function initiateStkPush({ phone, amount, planId, idempotencyKey }) {
  const token = await getMpesaToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  
  const response = await axios.post(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.ceil(amount),
    PartyA: formatPhone(phone),
    PartyB: process.env.MPESA_SHORTCODE,
    PhoneNumber: formatPhone(phone),
    CallBackURL: `${process.env.MPESA_CALLBACK_URL}/api/payments/mpesa-callback`,
    AccountReference: `FC-${planId}-${idempotencyKey.slice(0, 8)}`,
    TransactionDesc: 'FastConnect WiFi Access',
  }, { headers: { Authorization: `Bearer ${token}` } });
  
  return response.data;
}

// ============================================================
// PROVISION ACCESS
// ============================================================
async function provisionAccess(payment, overridePhone = null, overrideDeviceId = null) {
  const planSnapshot = JSON.parse(payment.plan_snapshot_json);
  const phone = overridePhone || decrypt(payment.phone_number);
  const deviceId = overrideDeviceId || 'unknown';
  
  const pendingData = await redis.get(`pending:${payment.idempotency_key}`);
  const finalDeviceId = overrideDeviceId || (pendingData ? JSON.parse(pendingData).deviceId : deviceId);
  
  const [routers] = await db.execute('SELECT * FROM routers WHERE is_active = 1 ORDER BY RAND() LIMIT 1');
  if (!routers.length) throw new Error('No available routers');
  const router = routers[0];
  
  router.password_decrypted = decrypt(router.password_encrypted);
  
  const { username, password } = mikrotik.generateCredentials();
  const endTime = new Date(Date.now() + planSnapshot.duration_hours * 3600 * 1000);
  
  await mikrotik.createHotspotUser(router, {
    username,
    password,
    profile: router.hotspot_profile || process.env.HOTSPOT_PROFILE || 'fastconnect',
    uptime: mikrotik.hoursToMikroTik(planSnapshot.duration_hours),
    bandwidthMbps: planSnapshot.bandwidth_limit_mbps,
  });
  
  const [result] = await db.execute(
    `INSERT INTO sessions (phone_number, plan_id, plan_snapshot_json, router_id, device_id,
      hotspot_username, hotspot_password, ip_address, user_agent, start_time, end_time,
      status, original_bandwidth_limit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'active', ?)`,
    [
      encrypt(phone), payment.plan_id, payment.plan_snapshot_json,
      router.id, encrypt(finalDeviceId), username, encrypt(password),
      '0.0.0.0', 'FastConnect Portal', endTime, planSnapshot.bandwidth_limit_mbps
    ]
  );
  
  logger.info(`Session provisioned: ${username} for phone ending ...${phone.slice(-4)}`);
  broadcastPlanUpdate('SESSION_CREATED', { sessionId: result.insertId, username });
  
  return { username, password, endTime, sessionId: result.insertId };
}

// ============================================================
// ROUTES — HEALTH
// ============================================================
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(), 
      wsClients: wsClients.size 
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ============================================================
// ROUTES — PUBLIC: PLANS
// ============================================================
app.get('/api/plans', async (req, res) => {
  try {
    const plans = await getCachedPlans();
    res.json({ plans });
  } catch (err) {
    logger.error('GET /api/plans error', err);
    res.status(500).json({ error: 'Service unavailable', details: err.message });
  }
});

app.get('/api/plans/changes', async (req, res) => {
  const { since } = req.query;
  try {
    const lastInvalidation = await redis.get('plan_cache_invalidation_ts');
    const hasChanges = lastInvalidation && parseInt(lastInvalidation) > parseInt(since || '0');
    res.json({ hasChanges: !!hasChanges, timestamp: Date.now() });
  } catch (err) {
    res.json({ hasChanges: false, timestamp: Date.now() });
  }
});

app.get('/api/plans/:id', [param('id').isInt()], handleValidationErrors, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM pricing_plans WHERE id = ? AND deleted_at IS NULL', 
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan: rows[0] });
  } catch (err) {
    logger.error('GET /api/plans/:id error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

// ============================================================
// ROUTES — PUBLIC: SESSIONS
// ============================================================
app.get('/api/sessions/status/:phone',
  [param('phone').matches(phoneRegex)], 
  handleValidationErrors,
  async (req, res) => {
    const deviceId = req.headers['x-device-id'] || req.ip;
    try {
      const [rows] = await db.execute(
        `SELECT s.*, p.name as plan_name FROM sessions s
         LEFT JOIN pricing_plans p ON s.plan_id = p.id
         WHERE s.phone_number = ? AND s.device_id = ? AND s.status = 'active' AND s.end_time > NOW()
         ORDER BY s.start_time DESC LIMIT 1`,
        [encrypt(req.params.phone), encrypt(deviceId)]
      );
      
      if (!rows.length) return res.json({ active: false });
      
      const session = rows[0];
      const remaining = Math.max(0, Math.floor((new Date(session.end_time) - new Date()) / 1000));
      
      res.json({
        active: true,
        sessionId: session.id,
        planName: session.plan_name,
        planSnapshot: JSON.parse(session.plan_snapshot_json),
        hotspotUsername: session.hotspot_username,
        hotspotPassword: decrypt(session.hotspot_password),
        endTime: session.end_time,
        startTime: session.start_time,
        remainingSeconds: remaining,
        status: session.status,
      });
    } catch (err) {
      logger.error('Session status error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

// ============================================================
// ROUTES — PUBLIC: PAYMENTS
// ============================================================
app.post('/api/payments/initiate', paymentLimiter,
  [
    body('phone').matches(phoneRegex),
    body('planId').isInt({ min: 1 }),
    body('deviceId').isString().trim().notEmpty(),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { phone, planId, deviceId } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || crypto.randomUUID();

    try {
      const [existing] = await db.execute(
        'SELECT id FROM payments WHERE idempotency_key = ?', 
        [idempotencyKey]
      );
      if (existing.length) {
        return res.status(409).json({ error: 'Duplicate payment request' });
      }

      const [plans] = await db.execute(
        'SELECT * FROM pricing_plans WHERE id = ? AND is_active = 1 AND deleted_at IS NULL', 
        [planId]
      );
      if (!plans.length) {
        return res.status(404).json({ error: 'Plan not available' });
      }
      const plan = plans[0];

      const planSnapshot = JSON.stringify({
        id: plan.id, 
        name: plan.name, 
        price_kes: plan.price_kes,
        duration_hours: plan.duration_hours, 
        bandwidth_limit_mbps: plan.bandwidth_limit_mbps,
        features_json: plan.features_json,
      });

      await db.execute(
        `INSERT INTO payments (idempotency_key, phone_number, plan_id, plan_snapshot_json, amount_kes, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [idempotencyKey, encrypt(phone), planId, planSnapshot, plan.price_kes]
      );

      await redis.setEx(`pending:${idempotencyKey}`, 600, JSON.stringify({ phone, planId, deviceId }));

      const stkResponse = await initiateStkPush({
        phone, amount: plan.price_kes, planId, idempotencyKey
      });

      if (stkResponse.ResponseCode !== '0') {
        await db.execute('UPDATE payments SET status = ? WHERE idempotency_key = ?', ['failed', idempotencyKey]);
        return res.status(400).json({ error: 'M-Pesa request failed. Try again.' });
      }

      await db.execute(
        'UPDATE payments SET checkout_request_id = ? WHERE idempotency_key = ?',
        [stkResponse.CheckoutRequestID, idempotencyKey]
      );

      res.json({
        success: true,
        checkoutRequestId: stkResponse.CheckoutRequestID,
        idempotencyKey,
        message: 'STK Push sent. Enter M-Pesa PIN on your phone.',
      });
    } catch (err) {
      logger.error('Payment initiation error', err);
      res.status(500).json({ error: 'Payment service unavailable' });
    }
  }
);

app.get('/api/payments/status/:id', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT status, mpesa_receipt_number, amount_kes FROM payments WHERE checkout_request_id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    res.json(rows[0]);
  } catch (err) {
    logger.error('Payment status error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

// ============================================================
// M-PESA CALLBACK
// ============================================================
app.post('/api/payments/mpesa-callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const callbackData = req.body.Body?.stkCallback;
    if (!callbackData) return;

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callbackData;

    const [payments] = await db.execute(
      'SELECT * FROM payments WHERE checkout_request_id = ?', 
      [CheckoutRequestID]
    );
    if (!payments.length) {
      logger.warn('Callback for unknown payment', { CheckoutRequestID });
      return;
    }
    const payment = payments[0];

    if (ResultCode !== 0) {
      await db.execute(
        `UPDATE payments SET status = 'failed', result_code = ?, result_desc = ?, callback_data = ?, completed_at = NOW()
         WHERE checkout_request_id = ?`,
        [ResultCode, ResultDesc, JSON.stringify(callbackData), CheckoutRequestID]
      );
      return;
    }

    const items = CallbackMetadata?.Item || [];
    const getItem = name => items.find(i => i.Name === name)?.Value;
    const receipt = getItem('MpesaReceiptNumber');
    const amount = getItem('Amount');
    const transactionDate = getItem('TransactionDate');

    await db.execute(
      `UPDATE payments SET status = 'completed', mpesa_receipt_number = ?, result_code = 0,
       result_desc = 'Success', callback_data = ?, completed_at = NOW()
       WHERE checkout_request_id = ?`,
      [receipt, JSON.stringify(callbackData), CheckoutRequestID]
    );

    await provisionAccess(payment);

  } catch (err) {
    logger.error('M-Pesa callback processing error', err);
  }
});

// ============================================================
// ROUTES — PUBLIC: VOUCHERS
// ============================================================
app.post('/api/vouchers/redeem',
  [
    body('voucherCode').matches(voucherRegex),
    body('phone').matches(phoneRegex),
    body('deviceId').isString().trim().notEmpty(),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { voucherCode, phone, deviceId } = req.body;
    try {
      const [vouchers] = await db.execute(
        `SELECT v.*, p.is_active as plan_active FROM vouchers v
         LEFT JOIN pricing_plans p ON v.plan_id = p.id
         WHERE v.voucher_code = ? AND v.is_used = 0 AND (v.expires_at IS NULL OR v.expires_at > NOW())`,
        [voucherCode]
      );

      if (!vouchers.length) {
        return res.status(400).json({ error: 'Invalid or expired voucher code' });
      }
      const voucher = vouchers[0];

      let planSnapshot = JSON.parse(voucher.plan_snapshot_json);

      await db.execute(
        'UPDATE vouchers SET is_used = 1, used_by_phone = ?, used_at = NOW() WHERE id = ?',
        [encrypt(phone), voucher.id]
      );

      const fakePayment = {
        plan_id: voucher.plan_id,
        plan_snapshot_json: voucher.plan_snapshot_json,
        phone_number: encrypt(phone),
        idempotency_key: crypto.randomUUID(),
      };

      const session = await provisionAccess(fakePayment, phone, deviceId);

      res.json({
        success: true,
        message: 'Voucher redeemed successfully!',
        planName: planSnapshot.name,
        duration: planSnapshot.duration_hours,
        ...session,
      });
    } catch (err) {
      logger.error('Voucher redemption error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

// ============================================================
// ROUTES — ADMIN AUTH
// ============================================================
app.post('/api/admin/auth/login', loginLimiter,
  [
    body('username').isString().trim().notEmpty(),
    body('password').isString().notEmpty(),
    body('totpCode').optional().isString().isLength({ min: 6, max: 6 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { username, password, totpCode } = req.body;
    try {
      const [users] = await db.execute(
        'SELECT * FROM users WHERE username = ? AND deleted_at IS NULL AND role IN (?, ?)',
        [username, 'admin', 'staff']
      );

      if (!users.length) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const user = users[0];

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.mfa_enabled) {
        if (!totpCode) {
          return res.status(200).json({ mfaRequired: true });
        }
        const valid = speakeasy.totp.verify({
          secret: decrypt(user.mfa_secret),
          encoding: 'base32',
          token: totpCode,
          window: 1,
        });
        if (!valid) {
          return res.status(401).json({ error: 'Invalid 2FA code' });
        }
      }

      const payload = { 
        id: user.id, 
        username: user.username, 
        role: user.role, 
        ip: req.ip, 
        ua: req.get('User-Agent') 
      };
      const accessToken = signAccessToken(payload);
      const refreshToken = signRefreshToken({ id: user.id });

      await db.execute('UPDATE users SET last_login_ip = ?, last_login_at = NOW() WHERE id = ?', [req.ip, user.id]);
      await auditLog(user.id, 'LOGIN', 'user', user.id, null, { ip: req.ip }, req);

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true, 
        secure: process.env.NODE_ENV === 'production', 
        sameSite: 'Strict', 
        signed: true, 
        maxAge: 7 * 24 * 3600 * 1000
      });

      res.json({ 
        accessToken, 
        user: { id: user.id, username: user.username, role: user.role } 
      });
    } catch (err) {
      logger.error('Login error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

app.post('/api/admin/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) {
    const decoded = jwt.decode(token);
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) {
      await redis.setEx(`revoked:${token}`, ttl, '1');
    }
  }
  res.clearCookie('refreshToken');
  res.json({ success: true });
});

// ============================================================
// ROUTES — ADMIN: DASHBOARD
// ============================================================
app.get('/api/admin/dashboard/stats', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const [[activeUsers]] = await db.execute(
      "SELECT COUNT(*) as count FROM sessions WHERE status = 'active' AND end_time > NOW()"
    );
    const [[todayRevenue]] = await db.execute(
      "SELECT COALESCE(SUM(amount_kes), 0) as total FROM payments WHERE status = 'completed' AND DATE(completed_at) = CURDATE()"
    );
    const [[totalRevenue]] = await db.execute(
      "SELECT COALESCE(SUM(amount_kes), 0) as total FROM payments WHERE status = 'completed'"
    );
    const [[todayTx]] = await db.execute(
      "SELECT COUNT(*) as count FROM payments WHERE status = 'completed' AND DATE(completed_at) = CURDATE()"
    );

    res.json({
      activeUsers: activeUsers.count,
      todayRevenue: todayRevenue.total,
      totalRevenue: totalRevenue.total,
      todayTransactions: todayTx.count,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Dashboard stats error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

// ============================================================
// ROUTES — ADMIN: SESSIONS
// ============================================================
app.get('/api/admin/sessions/active', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const [sessions] = await db.execute(
      `SELECT s.id, s.hotspot_username, s.start_time, s.end_time, s.status,
              p.name as plan_name, s.router_id
       FROM sessions s
       LEFT JOIN pricing_plans p ON s.plan_id = p.id
       WHERE s.status = 'active' AND s.end_time > NOW()
       ORDER BY s.start_time DESC`
    );
    res.json({ 
      sessions: sessions.map(s => ({ 
        ...s, 
        remainingSeconds: Math.max(0, Math.floor((new Date(s.end_time) - new Date()) / 1000))
      })) 
    });
  } catch (err) {
    logger.error('Active sessions error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

app.post('/api/admin/sessions/:id/disconnect', requireAdmin, adminLimiter,
  [param('id').isInt()], 
  handleValidationErrors,
  async (req, res) => {
    try {
      const [sessions] = await db.execute('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
      if (!sessions.length) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = sessions[0];

      const [routers] = await db.execute('SELECT * FROM routers WHERE id = ?', [session.router_id]);
      if (routers.length) {
        const router = routers[0];
        router.password_decrypted = decrypt(router.password_encrypted);
        await mikrotik.removeHotspotUser(router, session.hotspot_username);
      }

      await db.execute('UPDATE sessions SET status = ?, end_time = NOW() WHERE id = ?', ['disconnected', session.id]);
      await auditLog(req.user.id, 'SESSION_DISCONNECT', 'session', session.id, { status: 'active' }, { status: 'disconnected' }, req);

      res.json({ success: true, message: 'User disconnected' });
    } catch (err) {
      logger.error('Session disconnect error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

// ============================================================
// ROUTES — ADMIN: PLANS (CRUD)
// ============================================================
app.get('/api/admin/plans', requireAdmin, async (req, res) => {
  try {
    const [plans] = await db.execute(
      'SELECT * FROM pricing_plans WHERE deleted_at IS NULL ORDER BY display_order ASC'
    );
    res.json({ plans });
  } catch (err) {
    logger.error('Get plans error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

app.post('/api/admin/plans', requireAdmin, adminLimiter,
  [
    body('name').isString().trim().notEmpty().isLength({ max: 100 }),
    body('duration_hours').isFloat({ min: 0.5 }),
    body('price_kes').isFloat({ min: 1 }),
    body('bandwidth_limit_mbps').isFloat({ min: 0.1 }),
    body('features_json').optional().isJSON(),
    body('is_popular').optional().isBoolean(),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { name, duration_hours, price_kes, bandwidth_limit_mbps, features_json, is_popular } = req.body;
    try {
      const [result] = await db.execute(
        `INSERT INTO pricing_plans (name, duration_hours, price_kes, bandwidth_limit_mbps, features_json, is_active, is_popular, display_order, created_by)
         SELECT ?, ?, ?, ?, ?, 1, ?, COALESCE(MAX(display_order) + 1, 1), ?
         FROM pricing_plans WHERE deleted_at IS NULL`,
        [name, duration_hours, price_kes, bandwidth_limit_mbps, features_json || '{}', is_popular || false, req.user.id]
      );
      
      const [newPlan] = await db.execute('SELECT * FROM pricing_plans WHERE id = ?', [result.insertId]);
      await invalidatePlanCache();
      broadcastPlanUpdate('PLAN_CREATED', newPlan[0]);
      await auditLog(req.user.id, 'PLAN_CREATE', 'plan', result.insertId, null, newPlan[0], req);
      
      res.status(201).json({ plan: newPlan[0] });
    } catch (err) {
      logger.error('Plan create error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

app.put('/api/admin/plans/:id', requireAdmin, adminLimiter,
  [
    param('id').isInt(),
    body('name').optional().isString().trim().notEmpty(),
    body('duration_hours').optional().isFloat({ min: 0.5 }),
    body('price_kes').optional().isFloat({ min: 1 }),
    body('bandwidth_limit_mbps').optional().isFloat({ min: 0.1 }),
    body('features_json').optional().isJSON(),
    body('is_popular').optional().isBoolean(),
    body('is_active').optional().isBoolean(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const [existing] = await db.execute(
        'SELECT * FROM pricing_plans WHERE id = ? AND deleted_at IS NULL', 
        [req.params.id]
      );
      if (!existing.length) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      const oldPlan = existing[0];

      await db.execute(
        `INSERT INTO plan_history (plan_id, name, duration_hours, price_kes, bandwidth_limit_mbps, features_json, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [oldPlan.id, oldPlan.name, oldPlan.duration_hours, oldPlan.price_kes, oldPlan.bandwidth_limit_mbps, oldPlan.features_json, req.user.id]
      );

      const updates = {};
      ['name', 'duration_hours', 'price_kes', 'bandwidth_limit_mbps', 'features_json', 'is_popular', 'is_active'].forEach(field => {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      });
      updates.updated_by = req.user.id;

      const setClause = Object.keys(updates).map(k => `\`${k}\` = ?`).join(', ');
      await db.execute(
        `UPDATE pricing_plans SET ${setClause}, updated_at = NOW() WHERE id = ?`, 
        [...Object.values(updates), req.params.id]
      );

      const [updatedPlan] = await db.execute('SELECT * FROM pricing_plans WHERE id = ?', [req.params.id]);
      await invalidatePlanCache();
      broadcastPlanUpdate('PLAN_UPDATED', updatedPlan[0]);
      await auditLog(req.user.id, 'PLAN_UPDATE', 'plan', req.params.id, oldPlan, updatedPlan[0], req);

      const [activeSessions] = await db.execute(
        "SELECT COUNT(*) as count FROM sessions WHERE plan_id = ? AND status = 'active'", 
        [req.params.id]
      );
      
      res.json({ plan: updatedPlan[0], activeSessionsPreserved: activeSessions[0].count });
    } catch (err) {
      logger.error('Plan update error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

app.delete('/api/admin/plans/:id', requireAdmin, adminLimiter,
  [param('id').isInt()], 
  handleValidationErrors,
  async (req, res) => {
    try {
      const [activeSessions] = await db.execute(
        "SELECT COUNT(*) as count FROM sessions WHERE plan_id = ? AND status = 'active' AND end_time > NOW()", 
        [req.params.id]
      );
      if (activeSessions[0].count > 0) {
        return res.status(409).json({
          error: 'Cannot delete plan with active sessions', 
          activeCount: activeSessions[0].count
        });
      }

      const [existing] = await db.execute('SELECT name FROM pricing_plans WHERE id = ?', [req.params.id]);
      await db.execute('UPDATE pricing_plans SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [req.params.id]);
      await invalidatePlanCache();
      broadcastPlanUpdate('PLAN_DELETED', { id: parseInt(req.params.id) });
      await auditLog(req.user.id, 'PLAN_DELETE', 'plan', req.params.id, existing[0], null, req);
      
      res.json({ success: true });
    } catch (err) {
      logger.error('Plan delete error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

app.patch('/api/admin/plans/:id/popular', requireAdmin,
  [param('id').isInt(), body('is_popular').isBoolean()], 
  handleValidationErrors,
  async (req, res) => {
    try {
      if (req.body.is_popular) {
        await db.execute('UPDATE pricing_plans SET is_popular = 0');
      }
      await db.execute('UPDATE pricing_plans SET is_popular = ? WHERE id = ?', [req.body.is_popular, req.params.id]);
      await invalidatePlanCache();
      broadcastPlanUpdate('PLAN_UPDATED', { id: parseInt(req.params.id), is_popular: req.body.is_popular });
      res.json({ success: true });
    } catch (err) {
      logger.error('Popular toggle error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

// ============================================================
// ROUTES — ADMIN: VOUCHERS
// ============================================================
app.post('/api/admin/vouchers/generate', requireAdmin, adminLimiter,
  [
    body('planId').isInt({ min: 1 }),
    body('quantity').isInt({ min: 1, max: 1000 }),
    body('validityDays').optional().isInt({ min: 1 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { planId, quantity, validityDays } = req.body;
    try {
      const [plans] = await db.execute('SELECT * FROM pricing_plans WHERE id = ? AND deleted_at IS NULL', [planId]);
      if (!plans.length) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      const plan = plans[0];

      const planSnapshot = JSON.stringify({
        id: plan.id, 
        name: plan.name, 
        price_kes: plan.price_kes,
        duration_hours: plan.duration_hours, 
        bandwidth_limit_mbps: plan.bandwidth_limit_mbps,
      });

      const vouchers = [];
      for (let i = 0; i < quantity; i++) {
        const code = `FC-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const expiresAt = validityDays ? new Date(Date.now() + validityDays * 86400000) : null;
        vouchers.push([code, planId, planSnapshot, req.user.id, expiresAt]);
      }

      await db.query(
        'INSERT INTO vouchers (voucher_code, plan_id, plan_snapshot_json, generated_by, expires_at) VALUES ?',
        [vouchers]
      );

      await auditLog(req.user.id, 'VOUCHERS_GENERATE', 'voucher', planId, null, { quantity, planId }, req);
      res.json({ success: true, generated: quantity, codes: vouchers.map(v => v[0]) });
    } catch (err) {
      logger.error('Voucher generation error', err);
      res.status(500).json({ error: 'Service unavailable' });
    }
  }
);

// ============================================================
// ROUTES — ADMIN: REPORTS
// ============================================================
app.get('/api/admin/reports/sales', requireAdmin, adminLimiter, async (req, res) => {
  const { from, to } = req.query;
  try {
    const [summary] = await db.execute(
      `SELECT DATE(completed_at) as date, SUM(amount_kes) as revenue, COUNT(*) as transactions
       FROM payments WHERE status = 'completed' AND completed_at BETWEEN ? AND ?
       GROUP BY DATE(completed_at) ORDER BY date DESC`,
      [from || '2024-01-01', to || new Date().toISOString().slice(0, 10)]
    );
    
    const [byPlan] = await db.execute(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(plan_snapshot_json, '$.name')) as plan_name,
              SUM(amount_kes) as revenue, COUNT(*) as transactions
       FROM payments WHERE status = 'completed' AND completed_at BETWEEN ? AND ?
       GROUP BY plan_name ORDER BY revenue DESC`,
      [from || '2024-01-01', to || new Date().toISOString().slice(0, 10)]
    );
    
    res.json({ summary, byPlan });
  } catch (err) {
    logger.error('Sales report error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

// ============================================================
// ROUTES — ADMIN: 2FA SETUP
// ============================================================
app.post('/api/admin/enable-2fa', requireAdmin, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name: `FastConnect:${req.user.username}`, length: 20 });
    await db.execute('UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE id = ?', 
      [encrypt(secret.base32), req.user.id]);
    res.json({ otpauthUrl: secret.otpauth_url, secret: secret.base32 });
  } catch (err) {
    logger.error('2FA enable error', err);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

// ============================================================
// CRON JOBS
// ============================================================
cron.schedule('0 * * * *', async () => {
  try {
    const [expired] = await db.execute("SELECT * FROM sessions WHERE status = 'active' AND end_time < NOW()");
    for (const session of expired) {
      const [routers] = await db.execute('SELECT * FROM routers WHERE id = ?', [session.router_id]);
      if (routers.length) {
        try { 
          const router = routers[0];
          router.password_decrypted = decrypt(router.password_encrypted);
          await mikrotik.removeHotspotUser(router, session.hotspot_username); 
        } catch (err) {
          logger.error('Failed to remove expired hotspot user', { sessionId: session.id, error: err.message });
        }
      }
    }
    await db.execute("UPDATE sessions SET status = 'expired' WHERE status = 'active' AND end_time < NOW()");
    logger.info(`Cleaned ${expired.length} expired sessions`);
  } catch (err) {
    logger.error('Session cleanup error', err);
  }
});

cron.schedule('*/5 * * * *', async () => {
  try {
    const [routers] = await db.execute('SELECT * FROM routers WHERE is_active = 1');
    for (const router of routers) {
      router.password_decrypted = decrypt(router.password_encrypted);
      const healthy = await mikrotik.checkHealth(router);
      await db.execute('UPDATE routers SET last_health_check = NOW() WHERE id = ?', [router.id]);
      if (!healthy) {
        logger.warn(`Router ${router.id} (${router.ip_address}) health check failed`);
      }
    }
  } catch (err) {
    logger.error('Router health check error', err);
  }
});

cron.schedule('0 2 * * *', async () => {
  try {
    const timestamp = new Date().toISOString().slice(0, 10);
    const backupFile = `/tmp/fastconnect_backup_${timestamp}.sql`;
    const { execSync } = require('child_process');
    execSync(`mysqldump -u ${process.env.DB_USER} -p${process.env.DB_PASSWORD} ${process.env.DB_NAME} > ${backupFile}`);
    
    const input = fs.readFileSync(backupFile);
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(input), cipher.final()]);
    fs.writeFileSync(`${backupFile}.enc`, encrypted);
    fs.unlinkSync(backupFile);
    
    logger.info(`Daily backup created: ${backupFile}.enc`);
  } catch (err) {
    logger.error('Backup error', err);
  }
});

cron.schedule('0 3 * * 0', async () => {
  await db.execute("DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 MONTH)");
});

cron.schedule('0 4 1 * *', async () => {
  await db.execute("DELETE FROM plan_history WHERE changed_at < DATE_SUB(NOW(), INTERVAL 1 YEAR)");
});

// ============================================================
// ERROR HANDLERS
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { 
    err: err.message, 
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined, 
    path: req.path,
    method: req.method
  });
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`FastConnect API server running on port ${PORT}`);
  logger.info(`WebSocket server ready on /ws/plans`);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(async () => {
    await redis.disconnect();
    await db.end();
    process.exit(0);
  });
});

module.exports = { app, server };