// Layer 5 — Execution Bot.
// The ONLY component that opens trades, and it acts strictly on
// DecisionEngine output with approved === true. It re-checks safety at the
// moment of execution (the decision may be seconds old), sizes the position
// from risk config (learning may scale it within bounds), and routes to the
// active broker. In SIMULATION mode it never trades.
import { EVENTS } from '../events.js';
import { MODES } from '../config.js';

export class ExecutionBot {
  constructor({ config, bus, logger, broker, safety, learningEngine, marketData = null }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.broker = broker;
    this.safety = safety;
    this.learningEngine = learningEngine;
    this.marketData = marketData;
    this.executedCount = 0;
    this.skippedCount = 0;
  }

  start() {
    this.bus.on(EVENTS.DECISION, (decision) => {
      this.handleDecision(decision).catch((err) => {
        this.logger.error(`Execution failed for ${decision.signal?.symbol}: ${err.message}`);
        this.bus.emit(EVENTS.ALERT, { severity: 'error', title: 'Execution error', body: err.message });
      });
    });
  }

  async handleDecision(decision) {
    if (decision.approved !== true) { this.skippedCount += 1; return null; }

    if (this.config.mode === MODES.SIMULATION) {
      this.logger.info(`SIMULATION: would execute ${decision.signal.direction} ${decision.signal.symbol} (confidence ${decision.confidence}) — no trade placed`);
      this.skippedCount += 1;
      return null;
    }

    // Final safety gate at execution time.
    const balance = await this.broker.getBalance();
    const safetyState = this.safety.snapshot(balance);
    if (!safetyState.tradingAllowed) {
      this.logger.warn(`Execution blocked by safety state for ${decision.signal.symbol}`);
      this.skippedCount += 1;
      return null;
    }

    // Position-limit gate (positions may have opened since the decision).
    const open = await this.broker.getOpenPositions();
    if (open.length >= this.config.risk.maxOpenPositions) { this.skippedCount += 1; return null; }
    if (open.filter((p) => p.symbol === decision.signal.symbol).length >= this.config.risk.maxPositionsPerSymbol) {
      this.skippedCount += 1;
      return null;
    }

    const order = this.buildOrder(decision, balance);
    if (!order) { this.skippedCount += 1; return null; }

    const trade = await this.broker.openTrade(order);
    this.executedCount += 1;
    return trade;
  }

  /** Risk-based position sizing: units = riskAmount / stopDistance. */
  buildOrder(decision, balance) {
    const { signal } = decision;
    const atr = signal.atr;
    if (!atr || !signal.price) {
      this.logger.warn(`Cannot size ${signal.symbol}: missing ATR/price`);
      return null;
    }
    const dir = signal.direction === 'LONG' ? 1 : -1;

    // Anchor SL/TP to the CURRENT tick, not the (possibly stale) scan price —
    // otherwise price drift between scan and fill can put stops on the wrong
    // side of the entry.
    const tick = this.marketData?.getLastTick?.(signal.symbol);
    const entryRef = tick ? (signal.direction === 'LONG' ? tick.ask : tick.bid) : signal.price;
    const drift = Math.abs(entryRef - signal.price) / (atr || 1e-9);
    if (drift > this.config.risk.defaultStopAtrMultiple) {
      this.logger.warn(`Skipping ${signal.symbol}: price drifted ${drift.toFixed(1)}x ATR since scan`);
      return null;
    }

    const stopDistance = atr * this.config.risk.defaultStopAtrMultiple;
    const stopLoss = entryRef - dir * stopDistance;
    const takeProfit = entryRef + dir * atr * this.config.risk.defaultTakeProfitAtrMultiple;

    const riskMultiplier = this.learningEngine ? this.learningEngine.riskMultiplier(signal) : 1;
    const riskAmount = balance * (this.config.risk.riskPerTradePct / 100) * riskMultiplier;
    let units = Math.floor(riskAmount / stopDistance);
    if (this.config.mode === MODES.LIVE) {
      units = Math.min(units, this.config.live.maxUnitsPerTrade);
    }
    if (units < 1) {
      this.logger.warn(`Sized to 0 units for ${signal.symbol} (risk ${riskAmount.toFixed(2)}, stop ${stopDistance})`);
      return null;
    }

    return {
      symbol: signal.symbol,
      direction: signal.direction,
      units,
      stopLoss: Number(stopLoss.toFixed(5)),
      takeProfit: Number(takeProfit.toFixed(5)),
      riskAmount: Number(riskAmount.toFixed(2)),
      confidence: decision.confidence,
      regime: signal.regime,
      session: signal.session,
      setup: signal.sweep ? 'liquidity_sweep' : 'trend_momentum',
    };
  }

  stats() {
    return { executed: this.executedCount, skipped: this.skippedCount };
  }
}
