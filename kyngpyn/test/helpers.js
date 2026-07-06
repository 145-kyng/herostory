// Shared test scaffolding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createBus } from '../src/events.js';

export function testConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyngpyn-test-'));
  const config = loadConfig({ mode: 'paper', ...overrides });
  config.dataDir = dataDir;
  return config;
}

export function silentLogger() {
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, recent: [] };
  logger.child = () => logger;
  return logger;
}

export function makeBus() {
  return createBus();
}

/** Candles trending in `direction` with mild noise — enough for indicators. */
export function trendingCandles(count = 120, { start = 1.0, step = 0.001, direction = 1 } = {}) {
  const candles = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price += direction * step * (0.6 + (i % 5) * 0.2);
    const close = price;
    candles.push({
      time: new Date(Date.now() - (count - i) * 300_000).toISOString(),
      open,
      close,
      high: Math.max(open, close) + step * 0.4,
      low: Math.min(open, close) - step * 0.4,
      volume: 100,
    });
  }
  return candles;
}

/** Fixed-price fake market data engine. */
export function fakeMarketData(price = 1.1, spread = 0.0002) {
  return {
    watchlist: ['EUR_USD'],
    prices: new Map(),
    setPrice(symbol, p) { this.prices.set(symbol, p); },
    getLastTick(symbol) {
      const p = this.prices.get(symbol) ?? price;
      return { symbol, bid: p - spread / 2, ask: p + spread / 2, time: new Date().toISOString() };
    },
    async getCandles() { return trendingCandles(); },
    health() { return { source: 'fake', connected: true, instruments: 1 }; },
  };
}
