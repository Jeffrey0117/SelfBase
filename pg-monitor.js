const { execFile } = require('child_process');
const { join } = require('path');
const { getDb, getSetting } = require('./db');

function getPgBinPath() {
  return getSetting('pg_bin_path') || process.env.PG_BIN_PATH || 'C:/Program Files/PostgreSQL/16/bin';
}

function runPsql(dbRow, sql) {
  return new Promise((resolve, reject) => {
    const psql = join(getPgBinPath(), 'psql');
    const args = [
      '-h', dbRow.host,
      '-p', String(dbRow.port),
      '-U', dbRow.username,
      '-d', dbRow.db_name,
      '-t', '-A', '-F', '\t',
      '-c', sql,
    ];

    const env = {
      ...process.env,
      PGPASSWORD: process.env[`PG_PASSWORD_${dbRow.id.toUpperCase()}`] || process.env.PG_PASSWORD || '',
    };

    execFile(psql, args, { env, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

async function checkHealth() {
  const db = getDb();
  const databases = db.prepare('SELECT * FROM databases WHERE is_active = 1').all();
  const results = [];

  for (const dbRow of databases) {
    try {
      const version = await runPsql(dbRow, 'SELECT version()');
      results.push({ id: dbRow.id, name: dbRow.name, status: 'connected', version: version.split(',')[0] });
    } catch (err) {
      results.push({ id: dbRow.id, name: dbRow.name, status: 'error', error: err.message });
    }
  }

  return results;
}

async function getStats(databaseId) {
  const db = getDb();
  const dbRow = db.prepare('SELECT * FROM databases WHERE id = ? AND is_active = 1').get(databaseId);
  if (!dbRow) throw new Error(`Database '${databaseId}' not found or inactive`);

  const sizeResult = await runPsql(dbRow, `SELECT pg_size_pretty(pg_database_size('${dbRow.db_name}'))`);

  const connectionsResult = await runPsql(dbRow, `
    SELECT count(*) FROM pg_stat_activity WHERE datname = '${dbRow.db_name}'
  `);

  const tablesResult = await runPsql(dbRow, `
    SELECT c.relname || '\t' || pg_size_pretty(pg_total_relation_size(c.oid)) || '\t' || COALESCE(s.n_live_tup, 0)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind = 'r' AND n.nspname = 'public'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 20
  `);

  const tables = tablesResult
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, size, rows] = line.split('\t');
      return { name, size, rows: parseInt(rows || '0', 10) };
    });

  const lastBackup = db.prepare(`
    SELECT started_at, duration_ms, size_bytes FROM backups
    WHERE database_id = ? AND status = 'completed'
    ORDER BY started_at DESC LIMIT 1
  `).get(databaseId);

  return {
    database: dbRow.name,
    size: sizeResult.trim(),
    connections: parseInt(connectionsResult.trim() || '0', 10),
    tables,
    last_backup: lastBackup || null,
  };
}

module.exports = { checkHealth, getStats };
