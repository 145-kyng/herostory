// Paper broker — full virtual execution against live (or simulated) prices.
// Used in PAPER mode, and its accounting is also what SIMULATION mode would
// produce if trades were allowed (simulation never opens trades at all).
// State persists to disk so the account survives restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EVENTS } from '../events.js';

export class PaperBroker {
  constructor({ config, bus, logger, marketData }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.marketData = marketData;
    this.file = path.join(config.dataDir, 'paper-account.json');
    this.account = {
      balance: config.paper.startingBalance,
      openTrades: [],
      closedTrades: [],
    };
    this._load();
  }

  get name() { return 'paper'; }

  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.account = { ...this.account, ...saved };
    } catch { /* fresh account */ }
  }

  _save() {
    try {
      // Cap persisted history; the journal keeps the full audit trail.
      const toSave = {
        ...this.account,
        closedTrades: this.account.closedTrades.slice(-500),
      };
      fs.writeFileSync(this.file, JSON.stringify(toSave, null, 2));
    } catch (err) {
      this.logger.warn(`Failed to persist paper account: ${err.message}`);
    }
  }

  async getBalance() { return this.account.balance; }

  async getOpenPositions() { return this.account.openTrades; }

  _fillPrice(symbol, direction) {
    const tick = this.marketData.getLastTick(symbol);
    if (!tick) throw new Error(`No price available for ${symbol}`);
    return direction === 'LONG' ? tick.ask : tick.bid;
  }

  async openTrade(order) {
    const entryPrice = this._fillPrice(order.symbol, order.direction);
    // Reject inverted stops outright — a stop on the wrong side of the fill
    // means the order is stale and would close instantly at a loss.
    const dir = order.direction === 'LONG' ? 1 : -1;
    if (order.stopLoss && (entryPrice - order.stopLoss) * dir <= 0) {
      throw new Error(`Invalid stop for ${order.direction} ${order.symbol}: SL ${order.stopLoss} vs fill ${entryPrice}`);
    }
    if (order.takeProfit && (order.takeProfit - entryPrice) * dir <= 0) {
      throw new Error(`Invalid target for ${order.direction} ${order.symbol}: TP ${order.takeProfit} vs fill ${entryPrice}`);
    }
    const trade = {
      id: crypto.randomUUID(),
      mode: 'paper',
      symbol: order.symbol,
      direction: order.direction,
      units: order.units,
      entryPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      riskAmount: order.riskAmount,
      confidence: order.confidence ?? null,
      regime: order.regime ?? 'unknown',
      session: order.session ?? [],
      setup: order.setup ?? 'scanner',
      status: 'open',
      openedAt: new Date().toISOString(),
      unrealizedPnl: 0,
    };
    this.account.openTrades.push(trade);
    this._save();
    this.bus.emit(EVENTS.TRADE_OPENED, { trade });
    this.logger.info(`PAPER OPEN ${trade.direction} ${trade.units} ${trade.symbol} @ ${entryPrice.toFixed(5)} (SL ${trade.stopLoss?.toFixed(5)}, TP ${trade.takeProfit?.toFixed(5)})`);
    return trade;
  }

  async closeTrade(tradeId, reason = 'manual') {
    const idx = this.account.openTrades.findIndex((t) => t.id === tradeId);
    if (idx === -1) throw new Error(`No open paper trade ${tradeId}`);
    const trade = this.account.openTrades[idx];
    const tick = this.marketData.getLastTick(trade.symbol);
    const exitPrice = trade.direction === 'LONG' ? tick.bid : tick.ask;
    return this._settle(trade, idx, exitPrice, reason);
  }

  _settle(trade, idx, exitPrice, reason) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const pnl = (exitPrice - trade.entryPrice) * dir * trade.units;
    const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss) || 1e-9;
    const rMultiple = ((exitPrice - trade.entryPrice) * dir) / stopDistance;

    trade.status = 'closed';
    trade.exitPrice = exitPrice;
    trade.pnl = Number(pnl.toFixed(2));
    trade.rMultiple = Number(rMultiple.toFixed(2));
    trade.closeReason = reason;
    trade.closedAt = new Date().toISOString();

    this.account.openTrades.splice(idx, 1);
    this.account.closedTrades.push(trade);
    this.account.balance = Number((this.account.balance + trade.pnl).toFixed(2));
    this._save();
    this.bus.emit(EVENTS.TRADE_CLOSED, { trade });
    this.logger.info(`PAPER CLOSE ${trade.symbol} @ ${exitPrice.toFixed(5)} pnl ${trade.pnl} (${reason})`);
    return trade;
  }

  /** Mark open trades to market; trigger virtual SL/TP fills. */
  onPrice(tick) {
    const toClose = [];
    for (const trade of this.account.openTrades) {
      if (trade.symbol !== tick.symbol) continue;
      const dir = trade.direction === 'LONG' ? 1 : -1;
      const closePrice = trade.direction === 'LONG' ? tick.bid : tick.ask;
      trade.unrealizedPnl = Number(((closePrice - trade.entryPrice) * dir * trade.units).toFixed(2));

      if (trade.direction === 'LONG') {
        if (trade.stopLoss && tick.bid <= trade.stopLoss) toClose.push([trade, trade.stopLoss, 'stop_loss']);
        else if (trade.takeProfit && tick.bid >= trade.takeProfit) toClose.push([trade, trade.takeProfit, 'take_profit']);
      } else {
        if (trade.stopLoss && tick.ask >= trade.stopLoss) toClose.push([trade, trade.stopLoss, 'stop_loss']);
        else if (trade.takeProfit && tick.ask <= trade.takeProfit) toClose.push([trade, trade.takeProfit, 'take_profit']);
      }
    }
    for (const [trade, price, reason] of toClose) {
      const idx = this.account.openTrades.indexOf(trade);
      if (idx !== -1) this._settle(trade, idx, price, reason);
    }
  }

  async modifyTrade(tradeId, { stopLoss, takeProfit }) {
    const trade = this.account.openTrades.find((t) => t.id === tradeId);
    if (!trade) throw new Error(`No open paper trade ${tradeId}`);
    if (stopLoss !== undefined) trade.stopLoss = stopLoss;
    if (takeProfit !== undefined) trade.takeProfit = takeProfit;
    this._save();
    this.bus.emit(EVENTS.TRADE_UPDATED, { trade });
    return trade;
  }

  async closeAll(reason = 'close_all') {
    const ids = this.account.openTrades.map((t) => t.id);
    const closed = [];
    for (const id of ids) closed.push(await this.closeTrade(id, reason));
    return closed;
  }

  performance() {
    const closed = this.account.closedTrades;
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl < 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    return {
      balance: this.account.balance,
      startingBalance: this.config.paper.startingBalance,
      totalTrades: closed.length,
      openTrades: this.account.openTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
      totalPnl: Number(closed.reduce((a, t) => a + t.pnl, 0).toFixed(2)),
      unrealizedPnl: Number(this.account.openTrades.reduce((a, t) => a + (t.unrealizedPnl || 0), 0).toFixed(2)),
    };
  }
}
