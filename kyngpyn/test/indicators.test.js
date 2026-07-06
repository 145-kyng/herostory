import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, atr, detectLiquiditySweep } from '../src/scanner/indicators.js';
import { classifyRegime, REGIMES } from '../src/scanner/regime.js';
import { trendingCandles } from './helpers.js';

test('sma computes simple average of the tail', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5);
  assert.equal(sma([1, 2], 5), null);
});

test('ema tracks rising series above older values', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + i);
  const e = ema(values, 20);
  assert.ok(e > 140 && e <= 159, `ema was ${e}`);
});

test('rsi extremes', () => {
  const rising = Array.from({ length: 30 }, (_, i) => 1 + i * 0.01);
  const falling = Array.from({ length: 30 }, (_, i) => 2 - i * 0.01);
  assert.equal(rsi(rising, 14), 100);
  assert.ok(rsi(falling, 14) < 5);
});

test('atr is positive on real ranges', () => {
  const candles = trendingCandles(50);
  assert.ok(atr(candles, 14) > 0);
});

test('liquidity sweep detected when wick pierces prior high but closes back inside', () => {
  const candles = trendingCandles(40, { direction: 0, step: 0.0005 });
  const priorHigh = Math.max(...candles.slice(-21, -1).map((c) => c.high));
  const last = candles[candles.length - 1];
  last.high = priorHigh + 0.002;
  last.close = priorHigh - 0.001;
  last.open = priorHigh - 0.0015;
  const sweep = detectLiquiditySweep(candles, 20);
  assert.equal(sweep.swept, true);
  assert.equal(sweep.side, 'high');
  assert.equal(sweep.bias, 'SHORT');
});

test('regime classifier sees a strong uptrend', () => {
  const { regime } = classifyRegime(trendingCandles(120, { direction: 1, step: 0.002 }));
  assert.equal(regime, REGIMES.TRENDING_UP);
});

test('regime classifier reports unknown on insufficient data', () => {
  assert.equal(classifyRegime(trendingCandles(10)).regime, REGIMES.UNKNOWN);
});
