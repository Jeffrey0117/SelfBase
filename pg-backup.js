const { execFile } = require('child_process');
const { join } = require('path');
const { statSync, unlinkSync, readdirSync, mkdirSync } = require('fs');
const crypto = require('crypto');
const { getDb, getSetting } = require('./db');

const BACKUP_DIR = join(__dirname, 'data', 'backups');
mkdirSync(BACKUP_DIR, { recursive: true });

function generateId() {
  return 'bak_' + crypto.randomBytes(8).toString('hex');
}

function getPgBinPath() {
  return getSetting('pg_bin_path') || process.env.PG_BIN_PATH || 'C:/Program Files/PostgreSQL/16/bin';
}

function formatTimestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${h}${mi}${s}`;
}

function runBackup(databaseId) {
  return new Promise((resolve, reject) => {
    const db = getDb();
    const dbRow = db.prepare('SELECT * FROM databases WHERE id = ? AND is_active = 1').get(databaseId);
    if (!dbRow) return reject(new Error(`Database '${databaseId}' not found or inactive`));

    const format = getSetting('backup_format') || 'custom';
    const ext = format === 'custom' ? '.dump' : '.sql';
    const filename = `${dbRow.db_name}_${formatTimestamp()}${ext}`;
    const filePath = join(BACKUP_DIR, filename);

    const backupId = generateId();
    const startTime = Date.now();

    db.prepare(`
      INSERT INTO backups (id, database_id, filename, file_path, status, started_at)
      VALUES (?, ?, ?, ?, 'running', datetime('now'))
    `).run(backupId, databaseId, filename, filePath);

    const pgDump = join(getPgBinPath(), 'pg_dump');
    const args = [
      '-h', dbRow.host,
      '-p', String(dbRow.port),
      '-U', dbRow.username,
      '-d', dbRow.db_name,
      '-f', filePath,
    ];

    if (format === 'custom') {
      args.push('-Fc');
    }

    const env = { ...process.env, PGPASSWORD: process.env[`PG_PASSWORD_${databaseId.toUpperCase()}`] || process.env.PG_PASSWORD || '' };

    execFile(pgDump, args, { env, timeout: 300000 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - startTime;

      if (err) {
        const errorMsg = stderr || err.message;
        db.prepare(`
          UPDATE backups SET status = 'failed', completed_at = datetime('now'), duration_ms = ?, error = ?
          WHERE id = ?
        `).run(durationMs, errorMsg, backupId);
        return reject(new Error(errorMsg));
      }

      let sizeBytes = 0;
      try { sizeBytes = statSync(filePath).size; } catch {}

      db.prepare(`
        UPDATE backups SET status = 'completed', completed_at = datetime('now'), duration_ms = ?, size_bytes = ?
        WHERE id = ?
      `).run(durationMs, sizeBytes, backupId);

      resolve({
        id: backupId,
        database_id: databaseId,
        filename,
        file_path: filePath,
        size_bytes: sizeBytes,
        duration_ms: durationMs,
        status: 'completed',
      });
    });
  });
}

function runBackupAll() {
  const db = getDb();
  const databases = db.prepare('SELECT id FROM databases WHERE is_active = 1').all();
  return Promise.allSettled(databases.map(d => runBackup(d.id)));
}

function restoreBackup(backupId, targetDbId) {
  return new Promise((resolve, reject) => {
    const db = getDb();
    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND status = ?').get(backupId, 'completed');
    if (!backup) return reject(new Error(`Backup '${backupId}' not found or not completed`));

    const dbRow = db.prepare('SELECT * FROM databases WHERE id = ?').get(targetDbId || backup.database_id);
    if (!dbRow) return reject(new Error(`Target database not found`));

    const pgRestore = join(getPgBinPath(), backup.filename.endsWith('.dump') ? 'pg_restore' : 'psql');
    const args = backup.filename.endsWith('.dump')
      ? ['-h', dbRow.host, '-p', String(dbRow.port), '-U', dbRow.username, '-d', dbRow.db_name, '--clean', '--if-exists', backup.file_path]
      : ['-h', dbRow.host, '-p', String(dbRow.port), '-U', dbRow.username, '-d', dbRow.db_name, '-f', backup.file_path];

    const env = { ...process.env, PGPASSWORD: process.env[`PG_PASSWORD_${(targetDbId || backup.database_id).toUpperCase()}`] || process.env.PG_PASSWORD || '' };

    execFile(pgRestore, args, { env, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      resolve({ success: true, backup_id: backupId, target: dbRow.db_name, message: 'Restore completed' });
    });
  });
}

function cleanupBackups() {
  const db = getDb();
  const retentionCount = parseInt(getSetting('retention_count') || '10', 10);
  const retentionDays = parseInt(getSetting('retention_days') || '30', 10);
  const cutoffDate = new Date(Date.now() - retentionDays * 86400000).toISOString();

  const databases = db.prepare('SELECT id FROM databases').all();
  let totalDeleted = 0;

  for (const { id } of databases) {
    // Delete by age
    const old = db.prepare(`
      SELECT id, file_path FROM backups
      WHERE database_id = ? AND status = 'completed' AND started_at < ?
    `).all(id, cutoffDate);

    for (const bak of old) {
      try { unlinkSync(bak.file_path); } catch {}
      db.prepare("UPDATE backups SET status = 'deleted' WHERE id = ?").run(bak.id);
      totalDeleted++;
    }

    // Delete by count (keep most recent N)
    const excess = db.prepare(`
      SELECT id, file_path FROM backups
      WHERE database_id = ? AND status = 'completed'
      ORDER BY started_at DESC
      LIMIT -1 OFFSET ?
    `).all(id, retentionCount);

    for (const bak of excess) {
      try { unlinkSync(bak.file_path); } catch {}
      db.prepare("UPDATE backups SET status = 'deleted' WHERE id = ?").run(bak.id);
      totalDeleted++;
    }
  }

  // Clean up failed backups older than 7 days
  const failedCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const failed = db.prepare(`
    SELECT id, file_path FROM backups WHERE status = 'failed' AND started_at < ?
  `).all(failedCutoff);

  for (const bak of failed) {
    try { unlinkSync(bak.file_path); } catch {}
    db.prepare("UPDATE backups SET status = 'deleted' WHERE id = ?").run(bak.id);
    totalDeleted++;
  }

  return { deleted: totalDeleted };
}

function listBackups(databaseId, limit) {
  const db = getDb();
  const lim = Math.min(parseInt(limit || '50', 10), 200);

  if (databaseId) {
    return db.prepare(`
      SELECT * FROM backups WHERE database_id = ? AND status != 'deleted'
      ORDER BY started_at DESC LIMIT ?
    `).all(databaseId, lim);
  }

  return db.prepare(`
    SELECT * FROM backups WHERE status != 'deleted'
    ORDER BY started_at DESC LIMIT ?
  `).all(lim);
}

module.exports = { runBackup, runBackupAll, restoreBackup, cleanupBackups, listBackups };
