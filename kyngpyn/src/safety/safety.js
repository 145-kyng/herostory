// Safety controls — kill switch, manual pause, daily max loss, consecutive
// loss tracking, position limits. This state is consulted by the Risk Agent,
// the Decision Engine (restrictions), and the Execution Bot (final gate).
// State persists to disk so a restart cannot silently reset a tripped limit.
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS } from '../events.js';

export class SafetyMonitor {
  constructor({ config, bus, logger }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.file = path.join(config.dataDir, 'safety-state.json');
    this.state = {
      killSwitch: false,
      paused: false,
      consecutiveLosses: 0,
      dailyPnl: 0,
      dailyDate: this._today(),
      dayStartBalance: null,
      trippedRules: [],
    };
    this._load();
  }

  _today() { return new Date().toISOString().slice(0, 10); }

  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...this.state, ...saved };
    } catch { /* fresh start */ }
    this._rollDayIfNeeded();
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.logger.warn(`Failed to persist safety state: ${err.message}`);
    }
  }

  _rollDayIfNeeded() {
    const today = this._today();
    if (this.state.dailyDate !== today) {
      this.state.dailyDate = today;
      this.state.dailyPnl = 0;
      this.state.dayStartBalance = null;
      this.state.trippedRules = this.state.trippedRules.filter((r) => r.rule !== 'daily_max_loss');
      this._save();
      this.logger.info('Safety monitor: new trading day, daily counters reset');
    }
  }

  /** Called by brokers/bots whenever a trade closes. */
  recordTradeResult({ pnl, balance }) {
    this._rollDayIfNeeded();
    this.state.dailyPnl += pnl;
    if (this.state.dayStartBalance === null && balance != null) {
      this.state.dayStartBalance = balance - this.state.dailyPnl;
    }
    if (pnl < 0) this.state.consecutiveLosses += 1;
    else if (pnl > 0) this.state.consecutiveLosses = 0;

    const snapshot = this.snapshot(balance);
    if (snapshot.dailyLossPct >= this.config.risk.dailyMaxLossPct) {
      this._trip('daily_max_loss', `Daily loss ${snapshot.dailyLossPct.toFixed(2)}% >= ${this.config.risk.dailyMaxLossPct}%`);
    }
    if (this.state.consecutiveLosses >= this.config.risk.maxConsecutiveLosses) {
      this._trip('consecutive_losses', `${this.state.consecutiveLosses} losses in a row`);
    }
    this._save();
    return snapshot;
  }

  _trip(rule, detail) {
    if (this.state.trippedRules.some((r) => r.rule === rule)) return;
    this.state.trippedRules.push({ rule, detail, at: new Date().toISOString() });
    this.logger.warn(`SAFETY TRIPPED: ${rule} — ${detail}`);
    this.bus.emit(EVENTS.SAFETY_TRIPPED, { rule, detail });
    this.bus.emit(EVENTS.ALERT, { severity: 'critical', title: `Safety rule tripped: ${rule}`, body: detail });
    this._save();
  }

  engageKillSwitch(by = 'system') {
    this.state.killSwitch = true;
    this._save();
    this.logger.warn(`KILL SWITCH ENGAGED by ${by}`);
    this.bus.emit(EVENTS.KILL_SWITCH, { engaged: true, by });
    this.bus.emit(EVENTS.ALERT, { severity: 'critical', title: 'KILL SWITCH ENGAGED', body: `Engaged by ${by}. No new trades; open positions will be closed.` });
  }

  releaseKillSwitch(by = 'system') {
    this.state.killSwitch = false;
    this._save();
    this.logger.info(`Kill switch released by ${by}`);
    this.bus.emit(EVENTS.KILL_SWITCH, { engaged: false, by });
  }

  pause(by = 'user') {
    this.state.paused = true;
    this._save();
    this.logger.info(`Trading paused by ${by}`);
    this.bus.emit(EVENTS.ALERT, { severity: 'info', title: 'Trading paused', body: `Paused by ${by}.` });
  }

  resume(by = 'user') {
    this.state.paused = false;
    this._save();
    this.logger.info(`Trading resumed by ${by}`);
    this.bus.emit(EVENTS.ALERT, { severity: 'info', title: 'Trading resumed', body: `Resumed by ${by}.` });
  }

  /** Reset tripped counters (human override, deliberate action). */
  override(by = 'user') {
    this.state.consecutiveLosses = 0;
    this.state.trippedRules = [];
    this._save();
    this.logger.warn(`Safety override by ${by} — tripped rules cleared`);
  }

  snapshot(balance = null) {
    this._rollDayIfNeeded();
    const ref = this.state.dayStartBalance ?? balance;
    const dailyLossPct = this.state.dailyPnl < 0 && ref
      ? Math.abs(this.state.dailyPnl / ref) * 100
      : 0;
    return {
      killSwitch: this.state.killSwitch,
      paused: this.state.paused,
      consecutiveLosses: this.state.consecutiveLosses,
      dailyPnl: Number(this.state.dailyPnl.toFixed(2)),
      dailyLossPct,
      trippedRules: this.state.trippedRules,
      tradingAllowed: !this.state.killSwitch && !this.state.paused
        && dailyLossPct < this.config.risk.dailyMaxLossPct
        && this.state.consecutiveLosses < this.config.risk.maxConsecutiveLosses,
    };
  }
}
