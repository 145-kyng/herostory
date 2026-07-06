import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningEngine } from '../src/learning/learningEngine.js';
import { testConfig, silentLogger, makeBus } from './helpers.js';

function engine() {
  const config = testConfig();
  return new LearningEngine({ config, bus: makeBus(), logger: silentLogger() });
}

function record(e, { pnl, r = pnl > 0 ? 1.5 : -1 }) {
  e.recordOutcome({
    symbol: 'EUR_USD', direction: 'LONG', regime: 'trending_up', session: ['london'],
    pnl, rMultiple: r, openedAt: new Date().toISOString(),
  });
}

const SIGNAL = { symbol: 'EUR_USD', direction: 'LONG', regime: 'trending_up' };

test('no adjustment until minimum samples', () => {
  const e = engine();
  record(e, { pnl: 100 });
  record(e, { pnl: 100 });
  assert.equal(e.confidenceAdjustment(SIGNAL), 0);
  assert.equal(e.riskMultiplier(SIGNAL), 1);
});

test('winning history nudges confidence up, bounded by maxAdjustment', () => {
  const e = engine();
  for (let i = 0; i < 20; i += 1) record(e, { pnl: 100, r: 2 });
  const adj = e.confidenceAdjustment(SIGNAL);
  assert.ok(adj > 0);
  assert.ok(adj <= e.config.learning.maxAdjustment);
});

test('losing history nudges down but never below -maxAdjustment', () => {
  const e = engine();
  for (let i = 0; i < 20; i += 1) record(e, { pnl: -100, r: -1 });
  const adj = e.confidenceAdjustment(SIGNAL);
  assert.ok(adj < 0);
  assert.ok(adj >= -e.config.learning.maxAdjustment);
});

test('risk multiplier stays within [0.5, 1.25] no matter the history', () => {
  const winner = engine();
  for (let i = 0; i < 50; i += 1) record(winner, { pnl: 500, r: 3 });
  assert.ok(winner.riskMultiplier(SIGNAL) <= 1.25);

  const loser = engine();
  for (let i = 0; i < 50; i += 1) record(loser, { pnl: -500, r: -1 });
  assert.ok(loser.riskMultiplier(SIGNAL) >= 0.5);
});

test('stats segment by symbol and direction', () => {
  const e = engine();
  for (let i = 0; i < 6; i += 1) record(e, { pnl: 100 });
  assert.equal(e.statsFor({ symbol: 'GBP_USD', direction: 'LONG' }).samples, 0);
  assert.equal(e.statsFor({ symbol: 'EUR_USD', direction: 'SHORT' }).samples, 0);
  assert.equal(e.statsFor(SIGNAL).samples, 6);
});

test('summary aggregates outcomes', () => {
  const e = engine();
  record(e, { pnl: 100 });
  record(e, { pnl: -50 });
  const s = e.summary();
  assert.equal(s.totalRecords, 2);
  assert.equal(s.totalPnl, 50);
});
