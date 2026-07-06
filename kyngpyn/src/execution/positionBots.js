// Layer 5 — position management bots.
//  - PositionManagerBot: periodic sweep of open positions (max age, stale
//    data, kill-switch liquidation).
//  - StopLossBot: trailing stop + move-to-breakeven management.
//  - TakeProfitBot: partial-target awareness / TP tightening in profit.
// All of them only MANAGE positions the Execution Bot opened; none can open.
import { EVENTS } from '../events.js';
import { atr } from '../scanner/indicators.js';

export class PositionManagerBot {
  constructor({ config, bus, logger, broker, safety, intervalMs = 10_000, maxTradeAgeMs = 48 * 3_600_000 }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.broker = broker;
    this.safety = safety;
    this.intervalMs = intervalMs;
    this.maxTradeAgeMs = maxTradeAgeMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.manage().catch((err) => this.logger.error(`Position manager error: ${err.message}`));
    }, this.intervalMs);
    // Kill switch => flatten everything, immediately.
    this.bus.on(EVENTS.KILL_SWITCH, ({ engaged }) => {
      if (engaged) {
        this.broker.closeAll('kill_switch')
          .then((closed) => { if (closed.length) this.logger.warn(`Kill switch closed ${closed.length} position(s)`); })
          .catch((err) => this.logger.error(`Kill switch flatten failed: ${err.message}`));
      }
    });
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async manage() {
    const open = await this.broker.getOpenPositions();
    const now = Date.now();
    for (const trade of open) {
      const age = now - Date.parse(trade.openedAt);
      if (age > this.maxTradeAgeMs) {
        this.logger.info(`Closing ${trade.symbol} — exceeded max age`);
        await this.broker.closeTrade(trade.id, 'max_age');
      }
    }
  }
}

export class StopLossBot {
  constructor({ config, bus, logger, broker, marketData, intervalMs = 15_000 }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.broker = broker;
    this.marketData = marketData;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.manage().catch((err) => this.logger.error(`Stop loss bot error: ${err.message}`));
    }, this.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async manage() {
    const open = await this.broker.getOpenPositions();
    for (const trade of open) {
      try {
        await this.manageTrade(trade);
      } catch (err) {
        this.logger.warn(`SL manage failed for ${trade.symbol}: ${err.message}`);
      }
    }
  }

  async manageTrade(trade) {
    const tick = this.marketData.getLastTick(trade.symbol);
    if (!tick || !trade.stopLoss) return;
    const candles = await this.marketData.getCandles(trade.symbol);
    const currentAtr = atr(candles, 14);
    if (!currentAtr) return;

    const dir = trade.direction === 'LONG' ? 1 : -1;
    const price = trade.direction === 'LONG' ? tick.bid : tick.ask;
    const initialRisk = Math.abs(trade.entryPrice - trade.stopLoss);
    const gain = (price - trade.entryPrice) * dir;

    // 1) Breakeven: at +1R, stop moves to entry.
    if (gain >= initialRisk && (trade.stopLoss - trade.entryPrice) * dir < 0) {
      const be = Number(trade.entryPrice.toFixed(5));
      await this.broker.modifyTrade(trade.id, { stopLoss: be });
      this.logger.info(`Stop moved to breakeven on ${trade.symbol}`);
      return;
    }

    // 2) Trailing: once past +1R, trail at N x ATR behind price (only tightens).
    if (gain >= initialRisk) {
      const trail = Number((price - dir * currentAtr * this.config.risk.trailingStopAtrMultiple).toFixed(5));
      const tighter = dir === 1 ? trail > trade.stopLoss : trail < trade.stopLoss;
      if (tighter) {
        await this.broker.modifyTrade(trade.id, { stopLoss: trail });
        this.logger.info(`Trailing stop on ${trade.symbol} -> ${trail}`);
      }
    }
  }
}

export class TakeProfitBot {
  constructor({ config, bus, logger, broker, marketData, intervalMs = 20_000 }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.broker = broker;
    this.marketData = marketData;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.manage().catch((err) => this.logger.error(`Take profit bot error: ${err.message}`));
    }, this.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async manage() {
    const open = await this.broker.getOpenPositions();
    for (const trade of open) {
      if (!trade.takeProfit || !trade.stopLoss) continue;
      const tick = this.marketData.getLastTick(trade.symbol);
      if (!tick) continue;
      const dir = trade.direction === 'LONG' ? 1 : -1;
      const price = trade.direction === 'LONG' ? tick.bid : tick.ask;
      const totalTarget = (trade.takeProfit - trade.entryPrice) * dir;
      const progress = ((price - trade.entryPrice) * dir) / (totalTarget || 1e-9);

      // At 80% of target in a fading move, lock it in by closing out.
      if (progress >= 0.8) {
        const candles = await this.marketData.getCandles(trade.symbol);
        const last = candles[candles.length - 1];
        const fading = last && ((dir === 1 && last.close < last.open) || (dir === -1 && last.close > last.open));
        if (fading) {
          this.logger.info(`Taking profit early on ${trade.symbol} at ${Math.round(progress * 100)}% of target (momentum fading)`);
          await this.broker.closeTrade(trade.id, 'take_profit_early');
        }
      }
    }
  }
}
