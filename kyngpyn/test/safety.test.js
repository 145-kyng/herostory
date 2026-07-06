import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyMonitor } from '../src/safety/safety.js';
import { testConfig, silentLogger, makeBus } from './helpers.js';
import { EVENTS } from '../src/events.js';

function monitor(configOverrides = {}) {
  const config = testConfig();
  Object.assign(config.risk, configOverrides);
  return new SafetyMonitor({ config, bus: makeBus(), logger: silentLogger() });
}

test('daily loss limit trips and blocks trading', () => {
  const m = monitor({ dailyMaxLossPct: 3 });
  m.recordTradeResult({ pnl: -1000, balance: 99_000 }); // 1% of 100k
  assert.equal(m.snapshot().tradingAllowed, true);
  m.recordTradeResult({ pnl: -2500, balance: 96_500 }); // total 3.5%
  const s = m.snapshot();
  assert.ok(s.dailyLossPct >= 3);
  assert.equal(s.tradingAllowed, false);
  assert.ok(s.trippedRules.some((r) => r.rule === 'daily_max_loss'));
});

test('consecutive losses trip; a win resets the streak', () => {
  const m = monitor({ maxConsecutiveLosses: 3, dailyMaxLossPct: 50 });
  m.recordTradeResult({ pnl: -10, balance: 100_000 });
  m.recordTradeResult({ pnl: -10, balance: 100_000 });
  m.recordTradeResult({ pnl: 50, balance: 100_000 });
  assert.equal(m.snapshot().consecutiveLosses, 0);
  m.recordTradeResult({ pnl: -10, balance: 100_000 });
  m.recordTradeResult({ pnl: -10, balance: 100_000 });
  m.recordTradeResult({ pnl: -10, balance: 100_000 });
  assert.equal(m.snapshot().tradingAllowed, false);
});

test('kill switch blocks trading and emits event', () => {
  const m = monitor();
  let event = null;
  m.bus.on(EVENTS.KILL_SWITCH, (e) => { event = e; });
  m.engageKillSwitch('test');
  assert.equal(m.snapshot().tradingAllowed, false);
  assert.deepEqual(event, { engaged: true, by: 'test' });
  m.releaseKillSwitch('test');
  assert.equal(m.snapshot().killSwitch, false);
});

test('pause and resume', () => {
  const m = monitor();
  m.pause('test');
  assert.equal(m.snapshot().tradingAllowed, false);
  m.resume('test');
  assert.equal(m.snapshot().tradingAllowed, true);
});

test('safety state survives restart (persistence)', () => {
  const config = testConfig();
  const bus = makeBus();
  const m1 = new SafetyMonitor({ config, bus, logger: silentLogger() });
  m1.engageKillSwitch('test');
  const m2 = new SafetyMonitor({ config, bus, logger: silentLogger() });
  assert.equal(m2.snapshot().killSwitch, true);
});
