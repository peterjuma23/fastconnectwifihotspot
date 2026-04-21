-- ============================================================
-- FastConnect Internet WiFi Billing System
-- MySQL 8.0 Database Schema + Seed Data
-- ============================================================

SET NAMES utf8mb4;
SET time_zone = '+03:00'; -- East Africa Time

CREATE DATABASE IF NOT EXISTS fastconnect_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE fastconnect_db;

-- ============================================================
-- USERS (Admin / Staff)
-- ============================================================
CREATE TABLE users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50) NOT NULL UNIQUE,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','staff') NOT NULL DEFAULT 'staff',
  mfa_secret    TEXT,
  mfa_enabled   TINYINT(1) NOT NULL DEFAULT 0,
  last_login_ip VARCHAR(45),
  last_login_at DATETIME,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME
) ENGINE=InnoDB;

-- ============================================================
-- PRICING PLANS
-- ============================================================
CREATE TABLE pricing_plans (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                 VARCHAR(100) NOT NULL,
  duration_hours       DECIMAL(10,2) NOT NULL,
  price_kes            DECIMAL(10,2) NOT NULL,
  bandwidth_limit_mbps DECIMAL(5,2) NOT NULL DEFAULT 2.00,
  features_json        JSON,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  is_popular           TINYINT(1) NOT NULL DEFAULT 0,
  display_order        INT NOT NULL DEFAULT 0,
  created_by           INT UNSIGNED,
  updated_by           INT UNSIGNED,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at           DATETIME,
  INDEX idx_active_order (is_active, display_order),
  INDEX idx_deleted (deleted_at)
) ENGINE=InnoDB;

-- ============================================================
-- PLAN HISTORY (Audit trail for plan changes)
-- ============================================================
CREATE TABLE plan_history (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  plan_id              INT UNSIGNED NOT NULL,
  name                 VARCHAR(100) NOT NULL,
  duration_hours       DECIMAL(10,2) NOT NULL,
  price_kes            DECIMAL(10,2) NOT NULL,
  bandwidth_limit_mbps DECIMAL(5,2) NOT NULL,
  features_json        JSON,
  changed_by           INT UNSIGNED,
  change_reason        VARCHAR(500),
  changed_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_plan_id (plan_id),
  INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB;

-- ============================================================
-- ROUTERS (MikroTik)
-- ============================================================
CREATE TABLE routers (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  ip_address          VARCHAR(45) NOT NULL,
  api_port            INT NOT NULL DEFAULT 8728,
  username            VARCHAR(100) NOT NULL,
  password_encrypted  TEXT NOT NULL,
  hotspot_profile     VARCHAR(100) NOT NULL DEFAULT 'default',
  location            VARCHAR(200),
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  last_health_check   DATETIME,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

-- ============================================================
-- SESSIONS (WiFi Sessions)
-- ============================================================
CREATE TABLE sessions (
  id                       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone_number             TEXT NOT NULL,          -- AES-256 encrypted
  plan_id                  INT UNSIGNED,
  plan_snapshot_json       JSON NOT NULL,           -- Immutable snapshot at session creation
  router_id                INT UNSIGNED,
  device_id                TEXT NOT NULL,           -- AES-256 encrypted
  hotspot_username         VARCHAR(100) NOT NULL,
  hotspot_password         TEXT NOT NULL,           -- AES-256 encrypted
  ip_address               VARCHAR(45),
  user_agent               VARCHAR(500),
  start_time               DATETIME NOT NULL,
  end_time                 DATETIME NOT NULL,
  data_used_mb             DECIMAL(12,2) DEFAULT 0,
  status                   ENUM('active','disconnected','expired') NOT NULL DEFAULT 'active',
  original_bandwidth_limit DECIMAL(5,2) NOT NULL,  -- Stored at creation, never changed
  last_updated             DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_end (status, end_time),
  INDEX idx_plan_id (plan_id),
  INDEX idx_router_id (router_id),
  INDEX idx_hotspot_user (hotspot_username),
  INDEX idx_start_time (start_time)
) ENGINE=InnoDB;

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  idempotency_key      VARCHAR(255) NOT NULL UNIQUE,
  phone_number         TEXT NOT NULL,           -- AES-256 encrypted
  plan_id              INT UNSIGNED,
  plan_snapshot_json   JSON NOT NULL,           -- Immutable: price/duration at time of purchase
  amount_kes           DECIMAL(10,2) NOT NULL,
  mpesa_receipt_number VARCHAR(100),
  transaction_id       VARCHAR(255),
  checkout_request_id  VARCHAR(255),
  status               ENUM('pending','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
  result_code          INT,
  result_desc          VARCHAR(500),
  callback_data        JSON,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at         DATETIME,
  INDEX idx_status (status),
  INDEX idx_checkout_request (checkout_request_id),
  INDEX idx_receipt (mpesa_receipt_number),
  INDEX idx_created (created_at),
  INDEX idx_plan_id (plan_id)
) ENGINE=InnoDB;

-- ============================================================
-- VOUCHERS
-- ============================================================
CREATE TABLE vouchers (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  voucher_code       VARCHAR(20) NOT NULL UNIQUE,
  plan_id            INT UNSIGNED,
  plan_snapshot_json JSON NOT NULL,    -- Preserve terms even if plan is edited/deleted
  is_used            TINYINT(1) NOT NULL DEFAULT 0,
  used_by_phone      TEXT,             -- AES-256 encrypted
  generated_by       INT UNSIGNED,
  used_at            DATETIME,
  expires_at         DATETIME,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_code (voucher_code),
  INDEX idx_is_used (is_used),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB;

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   INT UNSIGNED,
  old_values  JSON,
  new_values  JSON,
  ip_address  VARCHAR(45),
  user_agent  VARCHAR(500),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_action (action),
  INDEX idx_created (created_at),
  INDEX idx_entity (entity_type, entity_id)
) ENGINE=InnoDB;

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================
CREATE TABLE system_settings (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  setting_key   VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT,
  setting_type  ENUM('string','integer','boolean','json') NOT NULL DEFAULT 'string',
  description   VARCHAR(500),
  updated_by    INT UNSIGNED,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- DEVICE SESSIONS (Fast lookup for returning devices)
-- ============================================================
CREATE TABLE device_sessions (
  phone_number    VARCHAR(255) NOT NULL,   -- Hashed
  device_id       VARCHAR(255) NOT NULL,   -- Hashed
  session_data_json JSON,
  last_active     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_number, device_id),
  INDEX idx_last_active (last_active)
) ENGINE=InnoDB;

-- ============================================================
-- PLAN CACHE INVALIDATION
-- ============================================================
CREATE TABLE plan_cache_invalidation (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  last_invalidated_at DATETIME NOT NULL,
  invalidated_by     VARCHAR(50)
) ENGINE=InnoDB;

-- ============================================================
-- SEED DATA
-- ============================================================

-- Default Admin User (password: Admin@FastConnect2024!)
-- bcrypt cost factor 12
INSERT INTO users (username, email, password_hash, role, mfa_enabled) VALUES
('admin', 'admin@fastconnect.co.ke',
 '$2b$12$9EvQi6vX3LxJ8zDx.Aq1TOY9gq4K5x7z9Qr7WkbzFqIHypI/1.Am6',
 'admin', 0);

-- Pricing Plans (Kenya Shillings)
INSERT INTO pricing_plans (name, duration_hours, price_kes, bandwidth_limit_mbps, features_json, is_active, is_popular, display_order, created_by) VALUES
('2 Hours',  2,   10,  2, '{"unlimited_data": true, "speed": "2 Mbps", "devices": 1}', 1, 0, 1, 1),
('4 Hours',  4,   15,  2, '{"unlimited_data": true, "speed": "2 Mbps", "devices": 1}', 1, 0, 2, 1),
('8 Hours',  8,   25,  2, '{"unlimited_data": true, "speed": "2 Mbps", "devices": 1}', 1, 0, 3, 1),
('24 Hours', 24,  40,  2, '{"unlimited_data": true, "speed": "2 Mbps", "devices": 1}', 1, 1, 4, 1),
('Weekly',   168, 200, 2, '{"unlimited_data": true, "speed": "2 Mbps", "devices": 1}', 1, 0, 5, 1),
('Monthly',  720, 600, 2, '{"unlimited_data": true, "speed": "2 Mbps", "devices": 1}', 1, 0, 6, 1);

-- Demo Voucher
INSERT INTO vouchers (voucher_code, plan_id, plan_snapshot_json, generated_by, expires_at) VALUES
('FC-DEMO-2024', 4,
 '{"id": 4, "name": "24 Hours", "price_kes": 40, "duration_hours": 24, "bandwidth_limit_mbps": 2}',
 1, '2026-12-31 23:59:59');

-- System Settings
INSERT INTO system_settings (setting_key, setting_value, setting_type, description) VALUES
('session_timeout_minutes', '30', 'integer', 'Auto-logout inactive admin sessions'),
('mpesa_environment', 'sandbox', 'string', 'M-Pesa API environment (sandbox/production)'),
('backup_retention_days', '30', 'integer', 'Number of days to retain database backups'),
('max_devices_per_phone', '5', 'integer', 'Maximum concurrent device sessions per phone'),
('portal_title', 'FastConnect Internet', 'string', 'Captive portal display title'),
('support_phone', '+254 700 000 000', 'string', 'Support contact number shown on portal'),
('websocket_ping_interval', '30', 'integer', 'WebSocket heartbeat interval in seconds');

-- Plan Cache Invalidation (initialize)
INSERT INTO plan_cache_invalidation (last_invalidated_at, invalidated_by) VALUES (NOW(), 'init');
