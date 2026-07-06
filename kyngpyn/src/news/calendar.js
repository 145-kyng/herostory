// Economic news calendar. Events can be loaded from data/news.json or added
// at runtime via the API (`POST /api/news`). Each event:
// { time: ISO string, currency: "USD", impact: "high"|"medium"|"low", title }
import fs from 'node:fs';
import path from 'node:path';

export class NewsCalendar {
  constructor({ dataDir, logger }) {
    this.file = path.join(dataDir, 'news.json');
    this.logger = logger;
    this.events = [];
    this._load();
  }

  _load() {
    try {
      this.events = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this.events)) this.events = [];
    } catch {
      this.events = [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.events, null, 2));
    } catch (err) {
      this.logger?.warn?.(`Failed to persist news calendar: ${err.message}`);
    }
  }

  addEvent(event) {
    if (!event?.time || !event?.currency) throw new Error('news event needs time and currency');
    const normalized = {
      time: new Date(event.time).toISOString(),
      currency: String(event.currency).toUpperCase(),
      impact: ['high', 'medium', 'low'].includes(event.impact) ? event.impact : 'medium',
      title: event.title || 'Untitled event',
    };
    this.events.push(normalized);
    this.events.sort((a, b) => a.time.localeCompare(b.time));
    this._save();
    return normalized;
  }

  /** Events within +/- windowMinutes of `now` affecting either currency of the symbol. */
  eventsNear(symbol, windowMinutes, now = new Date()) {
    const currencies = symbol.split('_');
    const windowMs = windowMinutes * 60_000;
    return this.events.filter((e) => {
      if (!currencies.some((c) => e.currency === c || (c.startsWith('X') && e.currency === 'USD'))) return false;
      const dt = Math.abs(new Date(e.time).getTime() - now.getTime());
      return dt <= windowMs;
    });
  }

  upcoming(hours = 24, now = new Date()) {
    const horizon = now.getTime() + hours * 3_600_000;
    return this.events.filter((e) => {
      const t = new Date(e.time).getTime();
      return t >= now.getTime() && t <= horizon;
    });
  }

  prune(now = new Date()) {
    const cutoff = now.getTime() - 24 * 3_600_000;
    const before = this.events.length;
    this.events = this.events.filter((e) => new Date(e.time).getTime() >= cutoff);
    if (this.events.length !== before) this._save();
  }
}
