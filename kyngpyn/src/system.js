// Orchestrator — wires all eight layers together and exposes the control
// surface used by the HTTP API and voice commands.
import { EVENTS, createBus } from './events.js';
import { MODES, ensureDataDir } from './config.js';
import { Logger } from './logger.js';
import { defaultWatchlist, INSTRUMENTS } from './data/instruments.js';
import { MarketDataEngine } from './data/marketData.js';
import { Scanner } from './scanner/scanner.js';
import { sessionContext } from './scanner/sessions.js';
import { NewsCalendar } from './news/calendar.js';
import { AgentCouncil } from './agents/council.js';
import { DecisionEngine } from './decision/decisionEngine.js';
import { SafetyMonitor } from './safety/safety.js';
import { LearningEngine } from './learning/learningEngine.js';
import { PaperBroker } from './execution/paperBroker.js';
import { LiveBroker } from './execution/liveBroker.js';
import { ExecutionBot } from './execution/executionBot.js';
import { PositionManagerBot, StopLossBot, TakeProfitBot } from './execution/positionBots.js';
import { JournalBot } from './execution/journalBot.js';
import { AlertBot } from './alerts/notifier.js';
import { parseCommand } from './voice/commands.js';

export class TradingSystem {
  constructor(config) {
    this.config = config;
    ensureDataDir(config);
    this.bus = createBus();
    this.logger = new Logger({ name: 'kyngpyn', dir: config.dataDir, level: process.env.LOG_LEVEL || 'info' });
    this.startedAt = null;

    const watchlist = (process.env.WATCHLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.watchlist = watchlist.length ? watchlist : defaultWatchlist();

    // Layer 1 — market data
    this.marketData = new MarketDataEngine({
      config, bus: this.bus, logger: this.logger.child('marketData'), watchlist: this.watchlist,
    });

    // Shared services
    this.calendar = new NewsCalendar({ dataDir: config.dataDir, logger: this.logger });
    this.safety = new SafetyMonitor({ config, bus: this.bus, logger: this.logger.child('safety') });
    this.learning = new LearningEngine({ config, bus: this.bus, logger: this.logger.child('learning') });

    // Layer 2 — scanner
    this.scanner = new Scanner({
      config, bus: this.bus, logger: this.logger.child('scanner'), marketData: this.marketData,
    });

    // Layer 3 — agent council
    this.council = new AgentCouncil({
      config,
      bus: this.bus,
      logger: this.logger.child('council'),
      marketData: this.marketData,
      calendar: this.calendar,
      learningEngine: this.learning,
    });

    // Layer 4 — decision engine
    this.decisionEngine = new DecisionEngine({
      config,
      bus: this.bus,
      logger: this.logger.child('decision'),
      calendar: this.calendar,
      learningEngine: this.learning,
    });

    // Layer 5 — brokers + bots
    if (config.mode === MODES.LIVE) {
      this.broker = new LiveBroker({
        config, bus: this.bus, logger: this.logger.child('live'), marketData: this.marketData, oanda: this.marketData.oanda,
      });
    } else {
      // Paper broker also backs simulation-mode accounting (unused: sim never trades).
      this.broker = new PaperBroker({
        config, bus: this.bus, logger: this.logger.child('paper'), marketData: this.marketData,
      });
    }

    this.executionBot = new ExecutionBot({
      config, bus: this.bus, logger: this.logger.child('execution'), broker: this.broker, safety: this.safety, learningEngine: this.learning, marketData: this.marketData,
    });
    this.positionManager = new PositionManagerBot({
      config, bus: this.bus, logger: this.logger.child('posManager'), broker: this.broker, safety: this.safety,
    });
    this.stopLossBot = new StopLossBot({
      config, bus: this.bus, logger: this.logger.child('stopLoss'), broker: this.broker, marketData: this.marketData,
    });
    this.takeProfitBot = new TakeProfitBot({
      config, bus: this.bus, logger: this.logger.child('takeProfit'), broker: this.broker, marketData: this.marketData,
    });
    this.journalBot = new JournalBot({
      config, bus: this.bus, logger: this.logger.child('journal'), safety: this.safety, learningEngine: this.learning, broker: this.broker,
    });
    this.alertBot = new AlertBot({ config, bus: this.bus, logger: this.logger.child('alerts') });

    this.lastVotes = [];
    this.health = {};
    this._wire();
  }

  _wire() {
    // Signals flow: scanner -> council -> decision -> execution bot (via bus).
    this.bus.on(EVENTS.SCANNER_SIGNAL, (signal) => {
      this.evaluateSignal(signal).catch((err) => this.logger.error(`Signal pipeline error: ${err.message}`));
    });
    this.bus.on(EVENTS.COUNCIL_VOTES, ({ signal, votes }) => {
      this.lastVotes = [{ signal, votes, at: new Date().toISOString() }, ...this.lastVotes].slice(0, 20);
    });
    this.bus.on(EVENTS.HEALTH, ({ component, status, detail }) => {
      this.health[component] = { status, detail, at: new Date().toISOString() };
    });
    // Paper broker marks-to-market on every tick.
    this.bus.on(EVENTS.PRICE, (tick) => this.broker.onPrice?.(tick));
  }

  async evaluateSignal(signal) {
    const candles = await this.marketData.getCandles(signal.symbol);
    const balance = await this.broker.getBalance().catch(() => null);
    const ctx = {
      signal,
      candles,
      session: sessionContext(),
      portfolio: {
        balance,
        openPositions: await this.broker.getOpenPositions().catch(() => []),
        unrealizedPnl: this.broker.performance?.().unrealizedPnl ?? 0,
      },
      safety: this.safety.snapshot(balance),
      learning: this.learning.statsFor(signal),
    };
    const votes = await this.council.convene(ctx);
    return this.decisionEngine.decide({ signal, votes, safety: ctx.safety });
  }

  async start() {
    this.startedAt = new Date().toISOString();
    this.logger.info(`KYNGPYN TRADE CONTROL SYSTEM starting in ${this.config.mode.toUpperCase()} mode`);
    if (this.config.mode === MODES.LIVE) {
      this.logger.warn('LIVE MODE: real orders will be placed. Kill switch: POST /api/command {"action":"kill_switch"}');
    }
    await this.marketData.start();
    this.scanner.start();
    this.executionBot.start();
    this.positionManager.start();
    this.stopLossBot.start();
    this.takeProfitBot.start();
    this.journalBot.start();
    this.alertBot.start();
    this.calendar.prune();
    this.logger.info('All layers online');
  }

  async stop() {
    this.scanner.stop();
    this.positionManager.stop();
    this.stopLossBot.stop();
    this.takeProfitBot.stop();
    this.marketData.stop();
    this.logger.info('System stopped');
  }

  /** Unified command entry — API buttons and voice both land here. */
  async command(action, args = {}, source = 'api') {
    this.bus.emit(EVENTS.COMMAND, { action, args, source });
    switch (action) {
      case 'kill_switch':
        this.safety.engageKillSwitch(source);
        return { ok: true, message: 'Kill switch engaged. Flattening positions.' };
      case 'release_kill_switch':
        this.safety.releaseKillSwitch(source);
        return { ok: true, message: 'Kill switch released.' };
      case 'pause':
        this.safety.pause(source);
        return { ok: true, message: 'Trading paused.' };
      case 'resume':
        this.safety.resume(source);
        return { ok: true, message: 'Trading resumed.' };
      case 'override_safety':
        this.safety.override(source);
        return { ok: true, message: 'Safety counters reset (human override).' };
      case 'scan': {
        const signals = await this.scanner.scanOnce();
        return { ok: true, message: `Scan complete: ${signals.length} signal(s).`, signals };
      }
      case 'close_all': {
        const closed = await this.broker.closeAll(`${source}_close_all`);
        return { ok: true, message: `Closed ${closed.length} position(s).` };
      }
      case 'close_symbol': {
        const open = await this.broker.getOpenPositions();
        const matches = open.filter((t) => t.symbol === args.symbol);
        for (const t of matches) await this.broker.closeTrade(t.id, `${source}_close`);
        return { ok: true, message: `Closed ${matches.length} ${args.symbol} position(s).` };
      }
      case 'execute_setup': {
        // Voice-initiated setup: still goes through the FULL pipeline —
        // council + decision engine + safety. Voice cannot bypass controls.
        const candles = await this.marketData.getCandles(args.symbol);
        const analysis = this.scanner.analyzeSymbol(args.symbol, candles);
        if (!analysis || analysis.direction === 'NONE') {
          return { ok: false, message: `No actionable setup on ${args.symbol} right now.` };
        }
        const decision = await this.evaluateSignal(analysis);
        return {
          ok: decision.approved,
          message: decision.approved
            ? `${args.symbol} setup approved (confidence ${decision.confidence}) — executing.`
            : `${args.symbol} setup rejected: ${decision.reasons.join('; ')}`,
          decision: { approved: decision.approved, confidence: decision.confidence, reasons: decision.reasons },
        };
      }
      case 'dnt_add':
        this.decisionEngine.setDoNotTrade(args.symbol, true);
        return { ok: true, message: `${args.symbol} added to Do-Not-Trade list.` };
      case 'dnt_remove':
        this.decisionEngine.setDoNotTrade(args.symbol, false);
        return { ok: true, message: `${args.symbol} removed from Do-Not-Trade list.` };
      case 'status':
        return { ok: true, message: this._statusText(), state: await this.snapshot() };
      case 'ignored':
        return { ok: false, message: 'No wake word ("Doris") detected.' };
      default:
        return { ok: false, message: `Unknown command: ${action}`, args };
    }
  }

  async voiceCommand(transcript) {
    const parsed = parseCommand(transcript);
    this.logger.info(`Voice: "${transcript}" -> ${parsed.action}`);
    const result = await this.command(parsed.action, parsed.args, 'voice');
    return { ...result, parsed };
  }

  _statusText() {
    const s = this.safety.snapshot();
    const perf = this.broker.performance?.() || {};
    return `Mode ${this.config.mode}. ${s.killSwitch ? 'KILL SWITCH ON. ' : ''}${s.paused ? 'Paused. ' : ''}`
      + `${perf.openTrades ?? '?'} open, daily P&L ${s.dailyPnl}.`;
  }

  async snapshot() {
    const balance = await this.broker.getBalance().catch(() => null);
    const openPositions = await this.broker.getOpenPositions().catch(() => []);
    return {
      name: 'KYNGPYN TRADE CONTROL SYSTEM',
      mode: this.config.mode,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000) : 0,
      safety: this.safety.snapshot(balance),
      scanner: this.scanner.snapshot(),
      session: sessionContext(),
      votes: this.lastVotes,
      decisions: this.decisionEngine.recentDecisions.slice(-20).reverse(),
      doNotTrade: [...this.decisionEngine.doNotTrade],
      positions: openPositions,
      balance,
      performance: this.broker.performance?.() || {},
      learning: this.learning.summary(),
      execution: this.executionBot.stats(),
      alerts: this.alertBot.history.slice(-30).reverse(),
      news: this.calendar.upcoming(48),
      health: {
        ...this.health,
        marketData: { ...this.marketData.health(), at: new Date().toISOString() },
      },
      watchlist: this.watchlist,
      instrumentsAvailable: INSTRUMENTS.length,
    };
  }
}
