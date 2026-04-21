-- migrations/001_initial_schema.sql
-- Initial FastConnect database schema
-- Run via: node scripts/migrate.js

SET NAMES utf8mb4;
SET time_zone = '+03:00';

-- Users (Admin / Staff)
CREATE TABLE IF NOT EXISTS users (
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
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Pricing Plans
CREATE TABLE IF NOT EXISTS pricing_plans (
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
  INDEX idx_deleted      (deleted_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Plan History (change audit trail)
CREATE TABLE IF NOT EXISTS plan_history (
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
  INDEX idx_plan_id    (plan_id),
  INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- MikroTik Routers
CREATE TABLE IF NOT EXISTS routers (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  ip_address          VARCHAR(45) NOT NULL,
  api_port            INT NOT NULL DEFAULT 22,
  username            VARCHAR(100) NOT NULL,
  password_encrypted  TEXT NOT NULL,
  hotspot_profile     VARCHAR(100) NOT NULL DEFAULT 'fastconnect',
  location            VARCHAR(200),
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  last_health_check   DATETIME,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active (is_active)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id                       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone_number             TEXT NOT NULL,
  plan_id                  INT UNSIGNED,
  plan_snapshot_json       JSON NOT NULL,
  router_id                INT UNSIGNED,
  device_id                TEXT NOT NULL,
  hotspot_username         VARCHAR(100) NOT NULL,
  hotspot_password         TEXT NOT NULL,
  ip_address               VARCHAR(45),
  user_agent               VARCHAR(500),
  start_time               DATETIME NOT NULL,
  end_time                 DATETIME NOT NULL,
  data_used_mb             DECIMAL(12,2) DEFAULT 0,
  status                   ENUM('active','disconnected','expired') NOT NULL DEFAULT 'active',
  original_bandwidth_limit DECIMAL(5,2) NOT NULL,
  last_updated             DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_end   (status, end_time),
  INDEX idx_plan_id      (plan_id),
  INDEX idx_router_id    (router_id),
  INDEX idx_hotspot_user (hotspot_username),
  INDEX idx_start_time   (start_time)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Payments
CREATE TABLE IF NOT EXISTS payments (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  idempotency_key      VARCHAR(255) NOT NULL UNIQUE,
  phone_number         TEXT NOT NULL,
  plan_id              INT UNSIGNED,
  plan_snapshot_json   JSON NOT NULL,
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
  INDEX idx_status          (status),
  INDEX idx_checkout_request(checkout_request_id),
  INDEX idx_receipt         (mpesa_receipt_number),
  INDEX idx_created         (created_at),
  INDEX idx_plan_id         (plan_id)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Vouchers
CREATE TABLE IF NOT EXISTS vouchers (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  voucher_code       VARCHAR(20) NOT NULL UNIQUE,
  plan_id            INT UNSIGNED,
  plan_snapshot_json JSON NOT NULL,
  is_used            TINYINT(1) NOT NULL DEFAULT 0,
  used_by_phone      TEXT,
  generated_by       INT UNSIGNED,
  used_at            DATETIME,
  expires_at         DATETIME,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_code     (voucher_code),
  INDEX idx_is_used  (is_used),
  INDEX idx_expires  (expires_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
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
  INDEX idx_action  (action),
  INDEX idx_created (created_at),
  INDEX idx_entity  (entity_type, entity_id)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- System Settings
CREATE TABLE IF NOT EXISTS system_settings (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  setting_key   VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT,
  setting_type  ENUM('string','integer','boolean','json') NOT NULL DEFAULT 'string',
  description   VARCHAR(500),
  updated_by    INT UNSIGNED,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Device Sessions (fast returning-user lookup)
CREATE TABLE IF NOT EXISTS device_sessions (
  phone_number      VARCHAR(255) NOT NULL,
  device_id         VARCHAR(255) NOT NULL,
  session_data_json JSON,
  last_active       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_number, device_id),
  INDEX idx_last_active (last_active)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Plan Cache Invalidation Tracker
CREATE TABLE IF NOT EXISTS plan_cache_invalidation (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  last_invalidated_at DATETIME NOT NULL,
  invalidated_by      VARCHAR(50)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
