// Structured logger: console + rotating JSONL file. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ name = 'system', dir = null, level = 'info', maxBytes = 5_000_000 } = {}) {
    this.name = name;
    this.dir = dir;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.maxBytes = maxBytes;
    this.recent = []; // ring buffer for the dashboard
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  child(name) {
    const child = new Logger({ name, dir: this.dir });
    child.level = this.level;
    child.recent = this.recent; // share the ring buffer
    return child;
  }

  _write(level, msg, meta) {
    if (LEVELS[level] < this.level) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      name: this.name,
      msg,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    };
    const line = JSON.stringify(entry);
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](`[${entry.ts}] [${level.toUpperCase()}] [${this.name}] ${msg}`);
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    if (this.dir) {
      try {
        const file = path.join(this.dir, 'system.log');
        try {
          if (fs.statSync(file).size > this.maxBytes) {
            fs.renameSync(file, path.join(this.dir, 'system.log.1'));
          }
        } catch { /* file may not exist yet */ }
        fs.appendFileSync(file, line + '\n');
      } catch { /* logging must never crash the system */ }
    }
  }

  debug(msg, meta) { this._write('debug', msg, meta); }
  info(msg, meta) { this._write('info', msg, meta); }
  warn(msg, meta) { this._write('warn', msg, meta); }
  error(msg, meta) { this._write('error', msg, meta); }
}
