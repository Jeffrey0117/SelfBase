const net = require('net');
const { execFile } = require('child_process');

const REDIS_HOST = '127.0.0.1';
const REDIS_PORT = 6379;
const REDIS_TIMEOUT = 3000;

function sendRedisCommand(command) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let data = '';

    client.setTimeout(REDIS_TIMEOUT);

    client.connect(REDIS_PORT, REDIS_HOST, () => {
      // RESP protocol: *N\r\n$len\r\narg\r\n...
      const parts = command.split(' ');
      let resp = `*${parts.length}\r\n`;
      for (const part of parts) {
        resp += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
      }
      client.write(resp);
    });

    client.on('data', (chunk) => {
      data += chunk.toString();
      // Simple heuristic: if we got a complete response, close
      if (data.includes('\r\n') && !data.endsWith('\r\n$')) {
        client.end();
      }
    });

    client.on('end', () => resolve(data.trim()));
    client.on('timeout', () => { client.destroy(); reject(new Error('Redis connection timeout')); });
    client.on('error', (err) => reject(err));
  });
}

function parseRedisInfo(raw) {
  // Strip RESP bulk string prefix ($NNN\r\n)
  const cleaned = raw.replace(/^\$\d+\r\n/, '');
  const result = {};
  for (const line of cleaned.split('\r\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx > 0) {
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return result;
}

async function getHealth() {
  try {
    const pingResp = await sendRedisCommand('PING');
    const isUp = pingResp.includes('PONG');

    if (!isUp) {
      return { status: 'down', error: 'PING failed: ' + pingResp };
    }

    const infoResp = await sendRedisCommand('INFO');
    const info = parseRedisInfo(infoResp);

    return {
      status: 'connected',
      version: info.redis_version || 'unknown',
      uptime_seconds: parseInt(info.uptime_in_seconds || '0', 10),
      memory: {
        used: info.used_memory_human || 'unknown',
        used_bytes: parseInt(info.used_memory || '0', 10),
        peak: info.used_memory_peak_human || 'unknown',
        fragmentation_ratio: parseFloat(info.mem_fragmentation_ratio || '0'),
      },
      clients: {
        connected: parseInt(info.connected_clients || '0', 10),
        blocked: parseInt(info.blocked_clients || '0', 10),
      },
      stats: {
        total_commands: parseInt(info.total_commands_processed || '0', 10),
        keyspace_hits: parseInt(info.keyspace_hits || '0', 10),
        keyspace_misses: parseInt(info.keyspace_misses || '0', 10),
      },
      keyspace: info.db0 || 'empty',
    };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

function startRedis() {
  return new Promise((resolve, reject) => {
    execFile('wsl', ['-d', 'Ubuntu-24.04', '--', 'redis-server', '--daemonize', 'yes'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      // Verify it's running
      setTimeout(async () => {
        try {
          const health = await getHealth();
          resolve({ success: true, status: health.status, message: 'Redis started via WSL' });
        } catch (e) {
          resolve({ success: false, error: 'Started but health check failed: ' + e.message });
        }
      }, 500);
    });
  });
}

function stopRedis() {
  return new Promise(async (resolve, reject) => {
    try {
      const resp = await sendRedisCommand('SHUTDOWN NOSAVE');
      resolve({ success: true, message: 'Redis shutdown sent' });
    } catch (err) {
      // Connection reset is expected after SHUTDOWN
      if (err.message.includes('ECONNRESET') || err.message.includes('closed')) {
        return resolve({ success: true, message: 'Redis shut down' });
      }
      reject(err);
    }
  });
}

module.exports = { getHealth, startRedis, stopRedis };
