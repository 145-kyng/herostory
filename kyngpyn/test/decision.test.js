import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionEngine } from '../src/decision/decisionEngine.js';
import { NewsCalendar } from '../src/news/calendar.js';
import { testConfig, silentLogger, makeBus } from './helpers.js';

const SIGNAL = { symbol: 'EUR_USD', direction: 'LONG', confidence: 80, regime: 'trending_up' };
const SAFE = { killSwitch: false, paused: false, dailyLossPct: 0, consecutiveLosses: 0 };
// A weekday 14:00 UTC — London/NY overlap, so session restriction passes.
const NOW = new Date('2026-07-06T14:00:00Z');

function approvals(score = 80) {
  return ['Market Agent', 'Liquidity Agent', 'Risk Agent', 'News Agent', 'Portfolio Agent', 'Learning Agent']
    .map((agent) => ({ agent, vote: 'APPROVE', score, reason: 'ok' }));
}

function engine(configMutator = () => {}) {
  const config = testConfig();
  configMutator(config);
  return new DecisionEngine({ config, bus: makeBus(), logger: silentLogger(), calendar: null, learningEngine: null });
}

test('unanimous strong approval is approved', () => {
  const d = engine().decide({ signal: SIGNAL, votes: approvals(85), safety: SAFE, now: NOW });
  assert.equal(d.approved, true);
  assert.ok(d.confidence >= 70);
});

test('risk agent veto blocks even with high scores', () => {
  const votes = approvals(90);
  votes[2] = { agent: 'Risk Agent', vote: 'REJECT', score: 90, reason: 'no' };
  const d = engine().decide({ signal: SIGNAL, votes, safety: SAFE, now: NOW });
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some((r) => r.startsWith('VETO')));
});

test('kill switch is a terminal restriction', () => {
  const d = engine().decide({ signal: SIGNAL, votes: approvals(95), safety: { ...SAFE, killSwitch: true }, now: NOW });
  assert.equal(d.approved, false);
});

test('daily loss limit is a terminal restriction', () => {
  const d = engine().decide({ signal: SIGNAL, votes: approvals(95), safety: { ...SAFE, dailyLossPct: 5 }, now: NOW });
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some((r) => r.includes('daily loss limit')));
});

test('do-not-trade zone blocks the symbol', () => {
  const e = engine();
  e.setDoNotTrade('EUR_USD', true);
  const d = e.decide({ signal: SIGNAL, votes: approvals(95), safety: SAFE, now: NOW });
  assert.equal(d.approved, false);
  e.setDoNotTrade('EUR_USD', false);
  assert.equal(e.decide({ signal: SIGNAL, votes: approvals(95), safety: SAFE, now: NOW }).approved, true);
});

test('volatile regime blocks entries', () => {
  const d = engine().decide({
    signal: { ...SIGNAL, regime: 'volatile' }, votes: approvals(95), safety: SAFE, now: NOW,
  });
  assert.equal(d.approved, false);
});

test('session restriction blocks disallowed sessions', () => {
  const d = engine((c) => { c.sessions.allowed = ['tokyo']; })
    .decide({ signal: SIGNAL, votes: approvals(95), safety: SAFE, now: NOW }); // 14:00 UTC = not Tokyo
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some((r) => r.includes('session not allowed')));
});

test('low confidence or too few approvals rejects', () => {
  const weak = engine().decide({ signal: { ...SIGNAL, confidence: 30 }, votes: approvals(40), safety: SAFE, now: NOW });
  assert.equal(weak.approved, false);

  const votes = approvals(85);
  votes[0].vote = 'ABSTAIN';
  votes[1].vote = 'ABSTAIN';
  votes[4].vote = 'ABSTAIN';
  const few = engine().decide({ signal: SIGNAL, votes, safety: SAFE, now: NOW });
  assert.equal(few.approved, false);
  assert.ok(few.reasons.some((r) => r.includes('agents approve')));
});

test('high-impact news window blocks trades on affected currencies', () => {
  const config = testConfig();
  const calendar = new NewsCalendar({ dataDir: config.dataDir, logger: silentLogger() });
  calendar.addEvent({ time: NOW.toISOString(), currency: 'USD', impact: 'high', title: 'NFP' });
  const e = new DecisionEngine({ config, bus: makeBus(), logger: silentLogger(), calendar, learningEngine: null });
  const d = e.decide({ signal: SIGNAL, votes: approvals(95), safety: SAFE, now: NOW });
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some((r) => r.includes('news window')));
});
