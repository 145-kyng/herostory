// End-to-end pipeline tests: signal -> council -> decision -> execution bot,
// plus mode behavior (simulation never trades) and voice parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCouncil } from '../src/agents/council.js';
import { DecisionEngine } from '../src/decision/decisionEngine.js';
import { ExecutionBot } from '../src/execution/executionBot.js';
import { PaperBroker } from '../src/execution/paperBroker.js';
import { SafetyMonitor } from '../src/safety/safety.js';
import { LearningEngine } from '../src/learning/learningEngine.js';
import { NewsCalendar } from '../src/news/calendar.js';
import { Scanner } from '../src/scanner/scanner.js';
import { parseCommand, resolveSymbol } from '../src/voice/commands.js';
import { loadConfig, MODES } from '../src/config.js';
import { testConfig, silentLogger, makeBus, fakeMarketData, trendingCandles } from './helpers.js';
import { sessionContext } from '../src/scanner/sessions.js';

function rig(mode = 'paper') {
  const config = testConfig({ mode });
  const bus = makeBus();
  const logger = silentLogger();
  const marketData = fakeMarketData(1.1);
  const safety = new SafetyMonitor({ config, bus, logger });
  const learning = new LearningEngine({ config, bus, logger });
  const calendar = new NewsCalendar({ dataDir: config.dataDir, logger });
  const council = new AgentCouncil({ config, bus, logger, marketData, calendar, learningEngine: learning });
  const decisionEngine = new DecisionEngine({ config, bus, logger, calendar, learningEngine: learning });
  const broker = new PaperBroker({ config, bus, logger, marketData });
  const executionBot = new ExecutionBot({ config, bus, logger, broker, safety, learningEngine: learning, marketData });
  return { config, bus, marketData, safety, learning, calendar, council, decisionEngine, broker, executionBot };
}

const SIGNAL = {
  symbol: 'EUR_USD', direction: 'LONG', confidence: 82, price: 1.1,
  atr: 0.002, regime: 'trending_up', session: ['london', 'newyork'],
};

async function runPipeline(r, signal = SIGNAL) {
  const ctx = {
    signal,
    candles: trendingCandles(120, { start: 1.0, step: 0.001, direction: 1 }),
    session: { active: ['london', 'newyork'], overlap: true, weekend: false },
    portfolio: { balance: await r.broker.getBalance(), openPositions: await r.broker.getOpenPositions(), unrealizedPnl: 0 },
    safety: r.safety.snapshot(),
    learning: r.learning.statsFor(signal),
  };
  const votes = await r.council.convene(ctx);
  return r.decisionEngine.decide({
    signal, votes, safety: ctx.safety, now: new Date('2026-07-06T14:00:00Z'),
  });
}

test('council returns six votes in the required shape', async () => {
  const r = rig();
  const ctx = {
    signal: SIGNAL,
    candles: trendingCandles(120, { direction: 1, step: 0.001 }),
    session: sessionContext(new Date('2026-07-06T14:00:00Z')),
    portfolio: { balance: 100_000, openPositions: [], unrealizedPnl: 0 },
    safety: r.safety.snapshot(),
    learning: r.learning.statsFor(SIGNAL),
  };
  const votes = await r.council.convene(ctx);
  assert.equal(votes.length, 6);
  for (const v of votes) {
    assert.ok(typeof v.agent === 'string');
    assert.ok(['APPROVE', 'REJECT', 'ABSTAIN'].includes(v.vote));
    assert.ok(v.score >= 0 && v.score <= 100);
    assert.ok(typeof v.reason === 'string');
  }
});

test('paper mode: approved decision opens a paper trade with SL/TP', async () => {
  const r = rig('paper');
  const decision = await runPipeline(r);
  const trade = await r.executionBot.handleDecision(decision);
  if (decision.approved) {
    assert.ok(trade, 'approved decision should execute');
    assert.equal(trade.symbol, 'EUR_USD');
    assert.ok(trade.stopLoss < trade.entryPrice);
    assert.ok(trade.takeProfit > trade.entryPrice);
    assert.equal((await r.broker.getOpenPositions()).length, 1);
  } else {
    assert.equal(trade, null);
  }
});

test('rejected decisions never execute', async () => {
  const r = rig('paper');
  const decision = { approved: false, confidence: 95, signal: SIGNAL };
  assert.equal(await r.executionBot.handleDecision(decision), null);
  assert.equal((await r.broker.getOpenPositions()).length, 0);
});

test('simulation mode never places trades even when approved', async () => {
  const r = rig('simulation');
  const decision = { approved: true, confidence: 90, signal: SIGNAL };
  const trade = await r.executionBot.handleDecision(decision);
  assert.equal(trade, null);
  assert.equal((await r.broker.getOpenPositions()).length, 0);
});

test('execution re-checks safety: kill switch blocks an already-approved decision', async () => {
  const r = rig('paper');
  r.safety.engageKillSwitch('test');
  const decision = { approved: true, confidence: 90, signal: SIGNAL };
  assert.equal(await r.executionBot.handleDecision(decision), null);
});

test('position limits enforced at execution time', async () => {
  const r = rig('paper');
  r.config.risk.maxOpenPositions = 1;
  const decision = { approved: true, confidence: 90, signal: SIGNAL };
  await r.executionBot.handleDecision(decision);
  const second = await r.executionBot.handleDecision({ ...decision, signal: { ...SIGNAL, symbol: 'GBP_USD' } });
  assert.equal(second, null);
  assert.equal((await r.broker.getOpenPositions()).length, 1);
});

test('orders are anchored to the live tick, not the stale scan price', async () => {
  const r = rig('paper');
  r.marketData.setPrice('EUR_USD', 1.1010); // price moved since scan (signal.price = 1.1)
  const decision = { approved: true, confidence: 90, signal: SIGNAL };
  const trade = await r.executionBot.handleDecision(decision);
  assert.ok(trade);
  assert.ok(trade.stopLoss < trade.entryPrice, 'SL below LONG entry');
  assert.ok(trade.takeProfit > trade.entryPrice, 'TP above LONG entry');
});

test('execution skips a signal whose price drifted more than a stop-width', async () => {
  const r = rig('paper');
  r.marketData.setPrice('EUR_USD', 1.2); // absurd drift vs signal.price 1.1
  const decision = { approved: true, confidence: 90, signal: SIGNAL };
  assert.equal(await r.executionBot.handleDecision(decision), null);
});

test('paper broker rejects orders with stops on the wrong side of the fill', async () => {
  const r = rig('paper');
  await assert.rejects(
    r.broker.openTrade({ symbol: 'EUR_USD', direction: 'SHORT', units: 1000, stopLoss: 1.05, takeProfit: 1.2, riskAmount: 10 }),
    /Invalid stop/,
  );
});

test('scanner produces the spec output shape', async () => {
  const r = rig('paper');
  const scanner = new Scanner({ config: r.config, bus: r.bus, logger: silentLogger(), marketData: r.marketData });
  const analysis = scanner.analyzeSymbol('EUR_USD', trendingCandles(120, { direction: 1, step: 0.002 }));
  assert.equal(analysis.symbol, 'EUR_USD');
  assert.ok(['LONG', 'SHORT', 'NONE'].includes(analysis.direction));
  assert.ok(analysis.confidence >= 0 && analysis.confidence <= 100);
});

test('live mode config refuses to load without explicit enablement', () => {
  assert.throws(() => loadConfig({ mode: MODES.LIVE }), /Live mode refused/);
});

test('voice commands parse', () => {
  assert.equal(parseCommand('Doris scan markets').action, 'scan');
  assert.equal(parseCommand('doris stop trading').action, 'pause');
  assert.equal(parseCommand('Doris emergency stop').action, 'kill_switch');
  assert.equal(parseCommand('Doris resume trading').action, 'resume');
  assert.equal(parseCommand('hey doris close all positions').action, 'close_all');
  const exec = parseCommand('Doris execute gold setup');
  assert.equal(exec.action, 'execute_setup');
  assert.equal(exec.args.symbol, 'XAU_USD');
  assert.equal(parseCommand('scan markets').action, 'ignored'); // no wake word
  assert.equal(resolveSymbol('euro dollar'), 'EUR_USD');
  assert.equal(resolveSymbol('eur/usd'), 'EUR_USD');
  assert.equal(resolveSymbol('nasdaq'), 'NAS100_USD');
});
