// Layer 2 — Multi-Symbol Scanner.
// Runs continuously on a configurable interval, evaluates every watchlist
// symbol for trend / range / volatility / liquidity sweeps / session context /
// regime, and emits scored signals: { symbol, direction, confidence }.
import { EVENTS } from '../events.js';
import { ema, rsi, atr, roc, detectLiquiditySweep } from './indicators.js';
import { classifyRegime, REGIMES } from './regime.js';
import { sessionContext } from './sessions.js';

export class Scanner {
  constructor({ config, bus, logger, marketData }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.marketData = marketData;
    this.timer = null;
    this.running = false;
    this.lastResults = [];
    this.lastCycleAt = null;
    this.cycleCount = 0;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.scanOnce();
      } catch (err) {
        this.logger.error(`Scan cycle failed: ${err.message}`);
      }
      this.timer = setTimeout(loop, this.config.scanner.intervalMs);
    };
    loop();
    this.logger.info(`Scanner started (every ${this.config.scanner.intervalMs}ms, ${this.marketData.watchlist.length} symbols)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async scanOnce() {
    const startedAt = Date.now();
    const session = sessionContext();
    const results = [];

    for (const symbol of this.marketData.watchlist) {
      try {
        const candles = await this.marketData.getCandles(symbol);
        const analysis = this.analyzeSymbol(symbol, candles, session);
        if (analysis) results.push(analysis);
      } catch (err) {
        this.logger.debug(`Scan skip ${symbol}: ${err.message}`);
      }
    }

    results.sort((a, b) => b.confidence - a.confidence);
    this.lastResults = results;
    this.lastCycleAt = new Date().toISOString();
    this.cycleCount += 1;

    const signals = results
      .filter((r) => r.direction !== 'NONE' && r.confidence >= this.config.scanner.minConfidence)
      .slice(0, this.config.scanner.maxSignalsPerScan);

    this.bus.emit(EVENTS.SCANNER_CYCLE, {
      results,
      signals,
      session,
      startedAt,
      durationMs: Date.now() - startedAt,
    });
    for (const signal of signals) this.bus.emit(EVENTS.SCANNER_SIGNAL, signal);
    return signals;
  }

  /** Score one symbol. Returns null when there isn't enough data. */
  analyzeSymbol(symbol, candles, session = sessionContext()) {
    if (!candles || candles.length < 60) return null;
    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];

    const fast = ema(closes, 20);
    const slow = ema(closes, 50);
    const momentum = roc(closes, 10);
    const strength = rsi(closes, 14);
    const currentAtr = atr(candles, 14);
    const sweep = detectLiquiditySweep(candles, 20);
    const { regime, strength: regimeStrength, volRatio } = classifyRegime(candles);

    let longScore = 0;
    let shortScore = 0;

    // Trend alignment (up to 35 points).
    if (fast > slow && price > fast) longScore += 35;
    if (fast < slow && price < fast) shortScore += 35;

    // Momentum (up to 25 points).
    if (momentum !== null) {
      const m = Math.min(Math.abs(momentum) * 2500, 25);
      if (momentum > 0) longScore += m; else shortScore += m;
    }

    // RSI positioning (up to 15 points): pullback-in-trend beats extremes.
    if (strength !== null) {
      if (strength > 50 && strength < 70) longScore += 15;
      else if (strength >= 70) longScore += 5; // overbought — chasing
      if (strength < 50 && strength > 30) shortScore += 15;
      else if (strength <= 30) shortScore += 5; // oversold
    }

    // Liquidity sweep reversal bias (up to 15 points).
    if (sweep.swept) {
      if (sweep.bias === 'LONG') longScore += 15; else shortScore += 15;
    }

    // Regime agreement (up to 10 points); chaos penalizes both sides.
    if (regime === REGIMES.TRENDING_UP) longScore += 10;
    if (regime === REGIMES.TRENDING_DOWN) shortScore += 10;
    if (regime === REGIMES.VOLATILE) { longScore -= 15; shortScore -= 15; }

    // Session bonus: London/NY overlap is the most liquid window.
    if (session.overlap) { longScore += 5; shortScore += 5; }

    const direction = longScore === shortScore ? 'NONE' : (longScore > shortScore ? 'LONG' : 'SHORT');
    const confidence = Math.max(0, Math.min(100, Math.round(Math.max(longScore, shortScore))));

    return {
      symbol,
      direction,
      confidence,
      price,
      atr: currentAtr,
      regime,
      regimeStrength,
      volRatio: volRatio ? Number(volRatio.toFixed(2)) : null,
      rsi: strength !== null ? Math.round(strength) : null,
      sweep: sweep.swept ? sweep : null,
      session: session.active,
      time: new Date().toISOString(),
    };
  }

  snapshot() {
    return {
      lastCycleAt: this.lastCycleAt,
      cycleCount: this.cycleCount,
      intervalMs: this.config.scanner.intervalMs,
      results: this.lastResults,
    };
  }
}
