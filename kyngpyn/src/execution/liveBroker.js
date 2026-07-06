// Live broker — real OANDA v20 orders. Only constructed in LIVE mode, which
// itself requires explicit flags + credentials (see config.validateConfig).
// Keeps a local mirror of open trades enriched with our metadata (regime,
// session, confidence) that OANDA does not store.
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS } from '../events.js';

export class LiveBroker {
  constructor({ config, bus, logger, marketData, oanda }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.marketData = marketData;
    this.oanda = oanda;
    this.file = path.join(config.dataDir, 'live-meta.json');
    this.meta = {}; // oandaTradeId -> our metadata
    this._loadMeta();
  }

  get name() { return 'live'; }

  _loadMeta() {
    try { this.meta = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.meta = {}; }
  }

  _saveMeta() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.meta, null, 2)); } catch { /* non-fatal */ }
  }

  async getBalance() {
    const account = await this.oanda.getAccountSummary();
    return Number(account.balance);
  }

  async getOpenPositions() {
    const trades = await this.oanda.getOpenTrades();
    return trades.map((t) => {
      const units = Number(t.currentUnits);
      const m = this.meta[t.id] || {};
      return {
        id: t.id,
        mode: 'live',
        symbol: t.instrument,
        direction: units > 0 ? 'LONG' : 'SHORT',
        units: Math.abs(units),
        entryPrice: Number(t.price),
        stopLoss: t.stopLossOrder ? Number(t.stopLossOrder.price) : m.stopLoss ?? null,
        takeProfit: t.takeProfitOrder ? Number(t.takeProfitOrder.price) : m.takeProfit ?? null,
        unrealizedPnl: Number(t.unrealizedPL),
        openedAt: t.openTime,
        status: 'open',
        ...m,
      };
    });
  }

  async openTrade(order) {
    if (order.units > this.config.live.maxUnitsPerTrade) {
      throw new Error(`Order size ${order.units} exceeds LIVE_MAX_UNITS ${this.config.live.maxUnitsPerTrade}`);
    }
    const signedUnits = order.direction === 'LONG' ? order.units : -order.units;
    const res = await this.oanda.createMarketOrder({
      symbol: order.symbol,
      units: signedUnits,
      stopLossPrice: order.stopLoss,
      takeProfitPrice: order.takeProfit,
      clientTag: 'kyngpyn',
    });
    const fill = res.orderFillTransaction;
    if (!fill) {
      throw new Error(`Live order not filled: ${JSON.stringify(res.orderCancelTransaction || res)}`);
    }
    const tradeId = fill.tradeOpened?.tradeID || fill.id;
    const trade = {
      id: tradeId,
      mode: 'live',
      symbol: order.symbol,
      direction: order.direction,
      units: order.units,
      entryPrice: Number(fill.price),
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      riskAmount: order.riskAmount,
      confidence: order.confidence ?? null,
      regime: order.regime ?? 'unknown',
      session: order.session ?? [],
      setup: order.setup ?? 'scanner',
      status: 'open',
      openedAt: fill.time,
      unrealizedPnl: 0,
    };
    this.meta[tradeId] = {
      riskAmount: order.riskAmount,
      confidence: trade.confidence,
      regime: trade.regime,
      session: trade.session,
      setup: trade.setup,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
    };
    this._saveMeta();
    this.bus.emit(EVENTS.TRADE_OPENED, { trade });
    this.logger.warn(`LIVE OPEN ${trade.direction} ${trade.units} ${trade.symbol} @ ${trade.entryPrice}`);
    return trade;
  }

  async closeTrade(tradeId, reason = 'manual') {
    const res = await this.oanda.closeTrade(tradeId);
    const fill = res.orderFillTransaction;
    const m = this.meta[tradeId] || {};
    const pnl = fill ? Number(fill.pl) : 0;
    const stopDistance = m.stopLoss && fill
      ? Math.abs(Number(fill.price) - (m.entryPrice ?? Number(fill.price)))
      : null;
    const trade = {
      id: tradeId,
      mode: 'live',
      symbol: fill?.instrument || m.symbol,
      direction: m.direction,
      pnl,
      rMultiple: m.riskAmount ? Number((pnl / m.riskAmount).toFixed(2)) : (stopDistance ? null : null),
      exitPrice: fill ? Number(fill.price) : null,
      closeReason: reason,
      status: 'closed',
      closedAt: fill?.time || new Date().toISOString(),
      confidence: m.confidence ?? null,
      regime: m.regime ?? 'unknown',
      session: m.session ?? [],
      setup: m.setup ?? 'scanner',
    };
    delete this.meta[tradeId];
    this._saveMeta();
    this.bus.emit(EVENTS.TRADE_CLOSED, { trade });
    this.logger.warn(`LIVE CLOSE ${trade.symbol} pnl ${pnl} (${reason})`);
    return trade;
  }

  async modifyTrade(tradeId, { stopLoss, takeProfit }) {
    await this.oanda.updateTradeOrders(tradeId, { stopLossPrice: stopLoss, takeProfitPrice: takeProfit });
    if (this.meta[tradeId]) {
      if (stopLoss !== undefined) this.meta[tradeId].stopLoss = stopLoss;
      if (takeProfit !== undefined) this.meta[tradeId].takeProfit = takeProfit;
      this._saveMeta();
    }
    return { id: tradeId, stopLoss, takeProfit };
  }

  async closeAll(reason = 'close_all') {
    const open = await this.getOpenPositions();
    const closed = [];
    for (const t of open) {
      try {
        closed.push(await this.closeTrade(t.id, reason));
      } catch (err) {
        this.logger.error(`Failed to close live trade ${t.id}: ${err.message}`);
      }
    }
    return closed;
  }

  onPrice() { /* OANDA handles SL/TP server-side */ }

  performance() {
    return { mode: 'live', note: 'See OANDA account for authoritative performance.' };
  }
}
