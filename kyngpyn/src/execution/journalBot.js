// Journal Bot — the audit trail. Appends every significant event to
// data/journal.jsonl (append-only) and keeps a recent window in memory for
// the dashboard. Also feeds closed trades into Learning + Safety.
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS } from '../events.js';

export class JournalBot {
  constructor({ config, bus, logger, safety, learningEngine, broker }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.safety = safety;
    this.learningEngine = learningEngine;
    this.broker = broker;
    this.file = path.join(config.dataDir, 'journal.jsonl');
    this.recent = [];
  }

  start() {
    this.bus.on(EVENTS.TRADE_OPENED, ({ trade }) => this.write('trade_opened', trade));
    this.bus.on(EVENTS.TRADE_CLOSED, ({ trade }) => this.onTradeClosed(trade));
    this.bus.on(EVENTS.TRADE_UPDATED, ({ trade }) => this.write('trade_updated', {
      id: trade.id, symbol: trade.symbol, stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    }));
    this.bus.on(EVENTS.DECISION, (d) => this.write('decision', {
      symbol: d.signal.symbol,
      direction: d.signal.direction,
      approved: d.approved,
      confidence: d.confidence,
      reasons: d.reasons,
      votes: d.votes.map((v) => ({ agent: v.agent, vote: v.vote, score: v.score })),
    }));
    this.bus.on(EVENTS.SAFETY_TRIPPED, (e) => this.write('safety_tripped', e));
    this.bus.on(EVENTS.KILL_SWITCH, (e) => this.write('kill_switch', e));
    this.bus.on(EVENTS.COMMAND, (e) => this.write('command', e));
  }

  onTradeClosed(trade) {
    this.write('trade_closed', trade);
    // Feed learning + safety from the single authoritative close event.
    try {
      if (this.learningEngine && this.config.learning.enabled) this.learningEngine.recordOutcome(trade);
    } catch (err) {
      this.logger.warn(`Learning record failed: ${err.message}`);
    }
    Promise.resolve(this.broker?.getBalance?.())
      .then((balance) => this.safety?.recordTradeResult({ pnl: trade.pnl ?? 0, balance }))
      .catch(() => this.safety?.recordTradeResult({ pnl: trade.pnl ?? 0, balance: null }));
  }

  write(type, data) {
    const entry = { ts: new Date().toISOString(), type, data };
    this.recent.push(entry);
    if (this.recent.length > 300) this.recent.shift();
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch (err) {
      this.logger.warn(`Journal write failed: ${err.message}`);
    }
  }

  tail(n = 100) {
    return this.recent.slice(-n);
  }
}
