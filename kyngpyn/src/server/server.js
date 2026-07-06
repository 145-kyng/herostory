// Layer 8 backend — HTTP API + SSE stream + dashboard hosting.
// No frameworks: node:http keeps the dependency surface at zero.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS } from '../events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export function createServer(system) {
  const sseClients = new Set();

  // Re-broadcast bus events to every dashboard over SSE.
  const forward = (event) => (payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  };
  for (const ev of [
    EVENTS.SCANNER_CYCLE, EVENTS.DECISION, EVENTS.TRADE_OPENED, EVENTS.TRADE_CLOSED,
    EVENTS.ALERT, EVENTS.KILL_SWITCH, EVENTS.SAFETY_TRIPPED, EVENTS.COUNCIL_VOTES,
  ]) {
    system.bus.on(ev, forward(ev));
  }

  const json = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      // --- Dashboard ---
      if (route === 'GET /' || route === 'GET /index.html') {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // --- SSE stream (browser notifications + live dashboard updates) ---
      if (route === 'GET /events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ mode: system.config.mode })}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
        req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
        return undefined;
      }

      // --- Read APIs ---
      if (route === 'GET /api/state') return json(res, 200, await system.snapshot());
      if (route === 'GET /api/health') {
        const md = system.marketData.health();
        const safety = system.safety.snapshot();
        const healthy = md.source === 'simulated' ? true : md.connected;
        return json(res, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'degraded',
          mode: system.config.mode,
          uptimeSec: system.startedAt ? Math.floor((Date.now() - Date.parse(system.startedAt)) / 1000) : 0,
          marketData: md,
          killSwitch: safety.killSwitch,
          paused: safety.paused,
        });
      }
      if (route === 'GET /api/journal') {
        return json(res, 200, system.journalBot.tail(Number(url.searchParams.get('n')) || 100));
      }
      if (route === 'GET /api/logs') {
        return json(res, 200, system.logger.recent.slice(-(Number(url.searchParams.get('n')) || 100)));
      }
      if (route === 'GET /api/news') return json(res, 200, system.calendar.upcoming(72));
      if (route === 'GET /api/learning') return json(res, 200, system.learning.summary());

      // --- Command APIs ---
      if (route === 'POST /api/command') {
        const body = await readBody(req);
        if (!body.action) return json(res, 400, { ok: false, message: 'action required' });
        const result = await system.command(body.action, body.args || {}, 'api');
        return json(res, result.ok ? 200 : 400, result);
      }
      if (route === 'POST /api/command/voice') {
        const body = await readBody(req);
        if (!body.transcript) return json(res, 400, { ok: false, message: 'transcript required' });
        const result = await system.voiceCommand(body.transcript);
        return json(res, 200, result);
      }
      if (route === 'POST /api/news') {
        const body = await readBody(req);
        const event = system.calendar.addEvent(body);
        return json(res, 201, event);
      }

      return json(res, 404, { ok: false, message: `No route: ${route}` });
    } catch (err) {
      system.logger.error(`HTTP ${route} failed: ${err.message}`);
      return json(res, 500, { ok: false, message: err.message });
    }
  });

  return server;
}
