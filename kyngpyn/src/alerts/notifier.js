// Alert Bot / Notifier — fans alerts out to: browser (SSE via the server),
// generic webhooks, SMS webhooks (e.g. a Twilio function URL), and email
// over SMTP (minimal built-in client, no dependencies).
import net from 'node:net';
import tls from 'node:tls';
import { EVENTS } from '../events.js';

export class AlertBot {
  constructor({ config, bus, logger }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.history = [];
  }

  start() {
    this.bus.on(EVENTS.ALERT, (alert) => this.dispatch(alert));
    // Trades themselves are alert-worthy.
    this.bus.on(EVENTS.TRADE_OPENED, ({ trade }) => this.dispatch({
      severity: 'info',
      title: `Trade opened: ${trade.direction} ${trade.symbol}`,
      body: `${trade.units} units @ ${trade.entryPrice} (mode: ${trade.mode})`,
    }));
    this.bus.on(EVENTS.TRADE_CLOSED, ({ trade }) => this.dispatch({
      severity: trade.pnl >= 0 ? 'info' : 'warning',
      title: `Trade closed: ${trade.symbol} ${trade.pnl >= 0 ? 'WIN' : 'LOSS'} ${trade.pnl}`,
      body: `Reason: ${trade.closeReason} | R: ${trade.rMultiple}`,
    }));
  }

  async dispatch(alert) {
    const entry = { ...alert, ts: new Date().toISOString() };
    this.history.push(entry);
    if (this.history.length > 200) this.history.shift();
    // Browser notifications ride the SSE stream (server re-broadcasts ALERT).

    const jobs = [];
    if (this.config.alerts.webhookUrl) jobs.push(this._webhook(this.config.alerts.webhookUrl, entry));
    if (this.config.alerts.smsWebhookUrl && entry.severity === 'critical') {
      jobs.push(this._webhook(this.config.alerts.smsWebhookUrl, { message: `${entry.title}: ${entry.body}` }));
    }
    if (this.config.alerts.smtpUrl && this.config.alerts.emailTo && ['critical', 'error'].includes(entry.severity)) {
      jobs.push(this._email(entry));
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') this.logger.warn(`Alert delivery failed: ${r.reason?.message || r.reason}`);
    }
    return entry;
  }

  async _webhook(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`webhook ${url} -> ${res.status}`);
  }

  /** Minimal SMTP send. ALERT_SMTP_URL: smtps://user:pass@host:465 (implicit TLS). */
  async _email(alert) {
    const u = new URL(this.config.alerts.smtpUrl);
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    const host = u.hostname;
    const port = Number(u.port) || 465;
    const to = this.config.alerts.emailTo;
    const from = user.includes('@') ? user : `kyngpyn@${host}`;

    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect({ host, port, servername: host }, () => resolve(s));
      s.once('error', reject);
      s.setTimeout(10_000, () => { s.destroy(); reject(new Error('SMTP timeout')); });
    });

    const send = (line) => new Promise((resolve, reject) => {
      const onData = (buf) => {
        socket.removeListener('error', reject);
        resolve(buf.toString());
      };
      socket.once('data', onData);
      socket.once('error', reject);
      if (line !== null) socket.write(line + '\r\n');
    });

    try {
      await send(null); // greeting
      await send(`EHLO kyngpyn`);
      await send('AUTH LOGIN');
      await send(Buffer.from(user).toString('base64'));
      const authRes = await send(Buffer.from(pass).toString('base64'));
      if (!authRes.startsWith('235')) throw new Error('SMTP auth failed');
      await send(`MAIL FROM:<${from}>`);
      await send(`RCPT TO:<${to}>`);
      await send('DATA');
      const body = [
        `From: KYNGPYN <${from}>`,
        `To: <${to}>`,
        `Subject: [KYNGPYN ${alert.severity.toUpperCase()}] ${alert.title}`,
        '',
        alert.body || '',
        '',
        `Sent ${alert.ts}`,
        '.',
      ].join('\r\n');
      const dataRes = await send(body);
      if (!dataRes.startsWith('250')) throw new Error('SMTP send rejected');
      await send('QUIT');
    } finally {
      socket.destroy();
    }
  }
}

// `net` imported to document that plain/STARTTLS SMTP is intentionally not
// supported — implicit-TLS (port 465) only keeps the client small and safe.
void net;
