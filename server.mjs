// server.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || 8080;

function runJob(payload) {
  return new Promise((resolve) => {
    const child = spawn('node', ['playwright_script.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, // <-- forwards Fly secrets to the child
        PAYLOAD_JSON: JSON.stringify(payload || {}),
      },
    });

    const logs = [];
    child.stdout.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(s);
      logs.push(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      process.stderr.write(s);
      logs.push(s);
    });

    child.on('close', (code) => resolve({ code, logs: logs.join('') }));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const { code, logs } = await runJob(payload);
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === 0, code, logs }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // Simple env check, does not leak secret values.
  if (req.method === 'GET' && req.url === '/env') {
    const flags = {
      has_BROWSERCAT_API_KEY: Boolean(process.env.BROWSERCAT_API_KEY),
      FORCE_BROWSERCAT: process.env.FORCE_BROWSERCAT || '',
      NODE_VERSION: process.version,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(flags));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

server.listen(PORT, () => {
  console.log('[server] listening on', PORT);
});
