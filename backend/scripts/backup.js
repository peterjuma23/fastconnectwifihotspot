// backend/scripts/backup.js — Automated encrypted database backup
// Called by cron job daily at 2 AM, or manually via: node scripts/backup.js

require('dotenv').config();
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || '/app/backups';
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30');

async function run() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawFile = path.join(BACKUP_DIR, `fc_backup_${timestamp}.sql`);
  const encFile = `${rawFile}.enc`;

  console.log(`[backup] Starting backup at ${new Date().toISOString()}`);

  // Ensure backup dir exists
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  try {
    // 1. Dump database
    console.log('[backup] Running mysqldump...');
    execSync(
      `mysqldump \
        --host=${process.env.DB_HOST || 'mysql'} \
        --user=${process.env.DB_USER} \
        --password=${process.env.DB_PASSWORD} \
        --single-transaction \
        --routines \
        --triggers \
        --add-drop-table \
        ${process.env.DB_NAME || 'fastconnect_db'} > ${rawFile}`,
      { stdio: 'pipe' }
    );
    const size = fs.statSync(rawFile).size;
    console.log(`[backup] Dump complete: ${(size / 1024).toFixed(1)} KB`);

    // 2. Encrypt with AES-256-GCM
    console.log('[backup] Encrypting backup...');
    const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(12); // 96-bit for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const input  = fs.readFileSync(rawFile);
    const enc    = Buffer.concat([cipher.update(input), cipher.final()]);
    const tag    = cipher.getAuthTag(); // 16-byte auth tag

    // Format: [4 bytes iv-length][iv][16 bytes auth tag][encrypted data]
    const ivLenBuf = Buffer.alloc(4);
    ivLenBuf.writeUInt32BE(iv.length);
    fs.writeFileSync(encFile, Buffer.concat([ivLenBuf, iv, tag, enc]));

    const encSize = fs.statSync(encFile).size;
    console.log(`[backup] Encrypted: ${(encSize / 1024).toFixed(1)} KB → ${path.basename(encFile)}`);

    // 3. Remove raw SQL dump
    fs.unlinkSync(rawFile);

    // 4. Clean old backups beyond retention period
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.enc'));
    let deleted = 0;
    for (const f of files) {
      const fp = path.join(BACKUP_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        deleted++;
      }
    }
    if (deleted > 0) console.log(`[backup] Cleaned ${deleted} old backup(s) (>${RETENTION_DAYS} days)`);

    // 5. Optional: Upload to S3
    if (process.env.AWS_ACCESS_KEY_ID && process.env.BACKUP_S3_BUCKET) {
      console.log('[backup] Uploading to S3...');
      execSync(`aws s3 cp ${encFile} s3://${process.env.BACKUP_S3_BUCKET}/backups/${path.basename(encFile)}`);
      console.log('[backup] S3 upload complete');
    }

    console.log(`[backup] ✅ Backup completed successfully: ${path.basename(encFile)}`);
    return encFile;

  } catch (err) {
    // Clean up partial files
    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
    if (fs.existsSync(encFile)) fs.unlinkSync(encFile);
    console.error('[backup] ❌ Backup failed:', err.message);
    throw err;
  }
}

// Restore function (for disaster recovery)
async function restore(encFile) {
  console.log(`[restore] Decrypting ${path.basename(encFile)}...`);
  const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
  const data = fs.readFileSync(encFile);

  const ivLen = data.readUInt32BE(0);
  const iv    = data.slice(4, 4 + ivLen);
  const tag   = data.slice(4 + ivLen, 4 + ivLen + 16);
  const enc   = data.slice(4 + ivLen + 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);

  const sqlFile = encFile.replace('.enc', '.restored.sql');
  fs.writeFileSync(sqlFile, decrypted);
  console.log(`[restore] Decrypted to: ${sqlFile}`);
  console.log(`[restore] Run: mysql -u${process.env.DB_USER} -p ${process.env.DB_NAME} < ${sqlFile}`);
  return sqlFile;
}

// CLI entry point
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'restore') {
    const file = process.argv[3];
    if (!file) { console.error('Usage: node backup.js restore <file.enc>'); process.exit(1); }
    restore(file).catch(err => { console.error(err.message); process.exit(1); });
  } else {
    run().catch(err => { console.error(err.message); process.exit(1); });
  }
}

module.exports = { run, restore };
