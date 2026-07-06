import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker } from '../src/execution/paperBroker.js';
import { testConfig, silentLogger, makeBus, fakeMarketData } from './helpers.js';

function broker(md = fakeMarketData(1.1)) {
  const config = testConfig();
  return new PaperBroker({ config, bus: makeBus(), logger: silentLogger(), marketData: md });
}

const ORDER = {
  symbol: 'EUR_USD', direction: 'LONG', units: 10_000,
  stopLoss: 1.09, takeProfit: 1.12, riskAmount: 100,
};

test('paper broker opens at the ask and tracks unrealized pnl', async () => {
  const md = fakeMarketData(1.1, 0.0002);
  const b = broker(md);
  const trade = await b.openTrade(ORDER);
  assert.equal(trade.entryPrice, 1.1001);
  md.setPrice('EUR_USD', 1.105);
  b.onPrice(md.getLastTick('EUR_USD'));
  const [open] = await b.getOpenPositions();
  assert.ok(open.unrealizedPnl > 0);
});

test('manual close realizes pnl into the balance', async () => {
  const md = fakeMarketData(1.1, 0);
  const b = broker(md);
  const start = await b.getBalance();
  const trade = await b.openTrade(ORDER);
  md.setPrice('EUR_USD', 1.11);
  const closed = await b.closeTrade(trade.id, 'test');
  assert.ok(Math.abs(closed.pnl - 100) < 1, `pnl was ${closed.pnl}`); // 0.01 * 10000
  assert.equal(await b.getBalance(), start + closed.pnl);
  assert.equal((await b.getOpenPositions()).length, 0);
});

test('stop loss fills virtually when price crosses it', async () => {
  const md = fakeMarketData(1.1, 0);
  const b = broker(md);
  await b.openTrade(ORDER);
  md.setPrice('EUR_USD', 1.0899);
  b.onPrice(md.getLastTick('EUR_USD'));
  assert.equal((await b.getOpenPositions()).length, 0);
  const perf = b.performance();
  assert.equal(perf.totalTrades, 1);
  assert.equal(perf.losses, 1);
  assert.equal(b.account.closedTrades[0].closeReason, 'stop_loss');
});

test('take profit fills virtually and rMultiple is computed', async () => {
  const md = fakeMarketData(1.1, 0);
  const b = broker(md);
  await b.openTrade(ORDER);
  md.setPrice('EUR_USD', 1.121);
  b.onPrice(md.getLastTick('EUR_USD'));
  const closed = b.account.closedTrades[0];
  assert.equal(closed.closeReason, 'take_profit');
  assert.ok(closed.rMultiple > 1.5, `R was ${closed.rMultiple}`);
});

test('short trades settle with inverted pnl', async () => {
  const md = fakeMarketData(1.1, 0);
  const b = broker(md);
  const trade = await b.openTrade({ ...ORDER, direction: 'SHORT', stopLoss: 1.11, takeProfit: 1.08 });
  md.setPrice('EUR_USD', 1.09);
  const closed = await b.closeTrade(trade.id, 'test');
  assert.ok(closed.pnl > 0);
});

test('closeAll flattens the book', async () => {
  const md = fakeMarketData(1.1, 0);
  const b = broker(md);
  await b.openTrade(ORDER);
  await b.openTrade({ ...ORDER, symbol: 'EUR_USD' });
  const closed = await b.closeAll('test');
  assert.equal(closed.length, 2);
  assert.equal((await b.getOpenPositions()).length, 0);
});
