const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load .env (no dotenv dependency)
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq);
      if (!process.env[k]) process.env[k] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const { getDb, getSetting, setSetting, getAllSettings } = require('./db');
const { runBackup, runBackupAll, restoreBackup, cleanupBackups, listBackups } = require('./pg-backup');
const { checkHealth: pgHealth, getStats: pgStats } = require('./pg-monitor');
const { getHealth: redisHealth, startRedis, stopRedis } = require('./redis-manager');

const PORT = parseInt(process.env.PORT || '4023', 10);

// ─── Helpers ───

const MAX_BODY_SIZE = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); return reject(new Error('Payload too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(payload);
}

function requireAuth(req) {
  const expected = process.env.SELFBASE_TOKEN;
  if (!expected) return false;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function parsePathname(url) {
  try { return new URL(url, 'http://localhost').pathname; }
  catch { return url.split('?')[0]; }
}

function parseQuery(url) {
  try {
    const u = new URL(url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

// ─── Rate Limiting ───

const rateLimits = new Map();

function checkRateLimit(ip, isAuth) {
  const now = Date.now();
  const limit = isAuth ? 300 : 60;
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60000 });
    return null;
  }
  entry.count += 1;
  if (entry.count > limit) return Math.ceil((entry.resetAt - now) / 1000);
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 300000);

// ─── Route Handlers ───

async function handleHealth(_req, res) {
  const pgStatus = await pgHealth().catch(() => []);
  const redis = await redisHealth().catch(() => ({ status: 'unknown' }));

  const db = getDb();
  const lastBackup = db.prepare(`
    SELECT database_id, started_at, status FROM backups
    ORDER BY started_at DESC LIMIT 1
  `).get();

  json(res, 200, {
    status: 'ok',
    service: 'selfbase',
    postgres: pgStatus,
    redis: { status: redis.status },
    last_backup: lastBackup || null,
  });
}

// ─── Database Management ───

async function handleListDatabases(_req, res) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM databases WHERE is_active = 1 ORDER BY id').all();
  json(res, 200, { databases: rows });
}

async function handleCreateDatabase(req, res) {
  const body = await readBody(req);
  if (!body.id || !body.db_name) {
    return json(res, 400, { error: 'id and db_name are required' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM databases WHERE id = ?').get(body.id);
  if (existing) {
    // Reactivate if soft-deleted
    db.prepare('UPDATE databases SET is_active = 1, name = ?, host = ?, port = ?, db_name = ?, username = ? WHERE id = ?').run(
      body.name || body.id, body.host || 'localhost', body.port || 5432,
      body.db_name, body.username || 'postgres', body.id
    );
    return json(res, 200, { success: true, message: 'Database reactivated', id: body.id });
  }

  db.prepare(`
    INSERT INTO databases (id, name, host, port, db_name, username)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(body.id, body.name || body.id, body.host || 'localhost', body.port || 5432, body.db_name, body.username || 'postgres');

  json(res, 200, { success: true, id: body.id });
}

async function handleDeleteDatabase(_req, res, id) {
  const db = getDb();
  db.prepare('UPDATE databases SET is_active = 0 WHERE id = ?').run(id);
  json(res, 200, { success: true });
}

// ─── Backup ───

async function handleBackup(req, res) {
  const body = await readBody(req);
  if (!body.database_id) {
    return json(res, 400, { error: 'database_id is required' });
  }

  try {
    const result = await runBackup(body.database_id);
    json(res, 200, { success: true, backup: result });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleBackupAll(_req, res) {
  const results = await runBackupAll();
  const summary = results.map((r, i) => ({
    status: r.status,
    value: r.status === 'fulfilled' ? r.value : undefined,
    error: r.status === 'rejected' ? r.reason.message : undefined,
  }));

  json(res, 200, { success: true, results: summary });
}

async function handleListBackups(req, res) {
  const query = parseQuery(req.url);
  const backups = listBackups(query.database_id, query.limit);
  json(res, 200, { backups });
}

async function handleRestore(req, res) {
  const body = await readBody(req);
  if (!body.backup_id) {
    return json(res, 400, { error: 'backup_id is required' });
  }

  try {
    const result = await restoreBackup(body.backup_id, body.target_database_id);
    json(res, 200, { success: true, restore: result });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleCleanup(_req, res) {
  const result = cleanupBackups();
  json(res, 200, { success: true, ...result });
}

// ─── PG Monitoring ───

async function handlePgStats(req, res) {
  const query = parseQuery(req.url);
  if (!query.database_id) {
    return json(res, 400, { error: 'database_id query param is required' });
  }

  try {
    const stats = await pgStats(query.database_id);
    json(res, 200, stats);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ─── Redis ───

async function handleRedisHealth(_req, res) {
  const health = await redisHealth();
  json(res, 200, health);
}

async function handleRedisStart(_req, res) {
  try {
    const result = await startRedis();
    json(res, 200, result);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleRedisStop(_req, res) {
  try {
    const result = await stopRedis();
    json(res, 200, result);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ─── Settings ───

async function handleGetSettings(_req, res) {
  json(res, 200, { settings: getAllSettings() });
}

async function handleUpdateSettings(req, res) {
  const body = await readBody(req);
  const allowed = ['retention_count', 'retention_days', 'backup_format', 'pg_bin_path'];
  let updated = 0;

  for (const key of allowed) {
    if (body[key] !== undefined) {
      setSetting(key, body[key]);
      updated++;
    }
  }

  json(res, 200, { success: true, updated, settings: getAllSettings() });
}

// ─── Router ───

function matchRoute(method, pathname) {
  // Public
  if (method === 'GET' && pathname === '/api/health') return { handler: handleHealth, auth: false };

  // Databases
  if (method === 'GET' && pathname === '/api/databases') return { handler: handleListDatabases, auth: true };
  if (method === 'POST' && pathname === '/api/databases') return { handler: handleCreateDatabase, auth: true };
  const dbDelete = pathname.match(/^\/api\/databases\/([^/]+)$/);
  if (method === 'DELETE' && dbDelete) return { handler: handleDeleteDatabase, auth: true, params: [dbDelete[1]] };

  // Backup
  if (method === 'POST' && pathname === '/api/backup') return { handler: handleBackup, auth: true };
  if (method === 'POST' && pathname === '/api/backup/all') return { handler: handleBackupAll, auth: true };
  if (method === 'GET' && pathname === '/api/backups') return { handler: handleListBackups, auth: true };
  if (method === 'POST' && pathname === '/api/restore') return { handler: handleRestore, auth: true };
  if (method === 'POST' && pathname === '/api/cleanup') return { handler: handleCleanup, auth: true };

  // PG Monitoring
  if (method === 'GET' && pathname === '/api/pg/stats') return { handler: handlePgStats, auth: true };

  // Redis
  if (method === 'GET' && pathname === '/api/redis/health') return { handler: handleRedisHealth, auth: true };
  if (method === 'POST' && pathname === '/api/redis/start') return { handler: handleRedisStart, auth: true };
  if (method === 'POST' && pathname === '/api/redis/stop') return { handler: handleRedisStop, auth: true };

  // Settings
  if (method === 'GET' && pathname === '/api/settings') return { handler: handleGetSettings, auth: true };
  if (method === 'PUT' && pathname === '/api/settings') return { handler: handleUpdateSettings, auth: true };

  return null;
}

// ─── Server ───

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const isAuth = (req.headers['authorization'] || '').startsWith('Bearer ');
  const retryAfter = checkRateLimit(ip, isAuth);
  if (retryAfter !== null) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ error: 'Too many requests', retryAfter }));
  }

  const pathname = parsePathname(req.url);
  const route = matchRoute(req.method, pathname);

  if (!route) return json(res, 404, { error: 'Not found' });

  if (route.auth && !requireAuth(req)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  try {
    const params = route.params || [];
    await route.handler(req, res, ...params);
  } catch (err) {
    console.error(`[selfbase] ${req.method} ${pathname} error:`, err.message);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[selfbase] Infrastructure manager running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
