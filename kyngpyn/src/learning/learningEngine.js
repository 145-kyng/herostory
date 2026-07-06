// Layer 6 — Learning Engine.
// Records every closed trade (symbol, session, setup, result, regime) and
// derives bounded adjustments: confidence weighting, symbol preference, risk
// scaling. Hard rule: learning may modify scores but may NEVER bypass risk
// controls — its output is clamped and consumed only where scores are formed.
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS } from '../events.js';

export class LearningEngine {
  constructor({ config, bus, logger }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.file = path.join(config.dataDir, 'learning.json');
    this.records = [];
    this._load();
  }

  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) this.records = saved;
    } catch { /* fresh start */ }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
    } catch (err) {
      this.logger.warn(`Failed to persist learning data: ${err.message}`);
    }
  }

  /** Record a closed trade outcome. */
  recordOutcome(trade) {
    const record = {
      symbol: trade.symbol,
      direction: trade.direction,
      session: trade.session || [],
      regime: trade.regime || 'unknown',
      setup: trade.setup || 'scanner',
      pnl: trade.pnl,
      rMultiple: trade.rMultiple ?? null,
      win: trade.pnl > 0,
      confidence: trade.confidence ?? null,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt || new Date().toISOString(),
    };
    this.records.push(record);
    if (this.records.length > 10_000) this.records.splice(0, this.records.length - 10_000);
    this._save();
    const stats = this.statsFor(record);
    this.bus?.emit(EVENTS.LEARNING_UPDATED, { symbol: record.symbol, stats });
    return record;
  }

  /** Records similar to a signal: same symbol+direction, plus regime kinship. */
  _similar(signal) {
    return this.records.filter((r) => (
      r.symbol === signal.symbol
      && r.direction === signal.direction
      && (signal.regime ? r.regime === signal.regime || r.regime === 'unknown' : true)
    ));
  }

  statsFor(signal) {
    const similar = this._similar(signal);
    if (!similar.length) return { samples: 0, winRate: 0.5, expectancy: 0 };
    const wins = similar.filter((r) => r.win).length;
    const rValues = similar.filter((r) => r.rMultiple !== null).map((r) => r.rMultiple);
    const expectancy = rValues.length
      ? rValues.reduce((a, b) => a + b, 0) / rValues.length
      : 0;
    return {
      samples: similar.length,
      winRate: wins / similar.length,
      expectancy,
    };
  }

  /**
   * Bounded confidence adjustment for the Decision Engine.
   * Range: [-maxAdjustment, +maxAdjustment]. Returns 0 until minSamples.
   */
  confidenceAdjustment(signal) {
    if (!this.config.learning.enabled) return 0;
    const stats = this.statsFor(signal);
    if (stats.samples < this.config.learning.minSamples) return 0;
    const max = this.config.learning.maxAdjustment;
    // winRate 0.5 -> 0; 0.7 -> +0.4*max... plus a small expectancy term.
    const raw = (stats.winRate - 0.5) * 2 * max + stats.expectancy * (max / 4);
    return Math.max(-max, Math.min(max, Math.round(raw)));
  }

  /**
   * Risk sizing multiplier in [0.5, 1.25]. Poor history halves size; strong
   * history may add at most 25%. Never exceeds configured risk per trade
   * by more than that factor, and the position sizer still enforces caps.
   */
  riskMultiplier(signal) {
    if (!this.config.learning.enabled) return 1;
    const stats = this.statsFor(signal);
    if (stats.samples < this.config.learning.minSamples) return 1;
    const raw = 1 + (stats.winRate - 0.5) + stats.expectancy * 0.1;
    return Math.max(0.5, Math.min(1.25, Number(raw.toFixed(2))));
  }

  /** Ranked symbol preference for the dashboard. */
  symbolPreferences() {
    const bySymbol = new Map();
    for (const r of this.records) {
      const cur = bySymbol.get(r.symbol) || { symbol: r.symbol, samples: 0, wins: 0, pnl: 0 };
      cur.samples += 1;
      if (r.win) cur.wins += 1;
      cur.pnl += r.pnl;
      bySymbol.set(r.symbol, cur);
    }
    return [...bySymbol.values()]
      .map((s) => ({ ...s, winRate: s.samples ? s.wins / s.samples : 0, pnl: Number(s.pnl.toFixed(2)) }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  summary() {
    const total = this.records.length;
    const wins = this.records.filter((r) => r.win).length;
    return {
      totalRecords: total,
      winRate: total ? wins / total : 0,
      totalPnl: Number(this.records.reduce((a, r) => a + r.pnl, 0).toFixed(2)),
      topSymbols: this.symbolPreferences().slice(0, 10),
    };
  }
}
