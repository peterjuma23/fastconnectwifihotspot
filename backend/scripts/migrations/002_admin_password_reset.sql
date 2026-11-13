-- Add one-time email-based admin password reset support.
SET @token_version_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND column_name = 'token_version'
);
SET @token_version_migration = IF(
  @token_version_column_exists = 0,
  'ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE token_version_statement FROM @token_version_migration;
EXECUTE token_version_statement;
DEALLOCATE PREPARE token_version_statement;

CREATE TABLE IF NOT EXISTS admin_password_reset_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_password_reset_user (user_id),
  INDEX idx_admin_password_reset_expiry (expires_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
