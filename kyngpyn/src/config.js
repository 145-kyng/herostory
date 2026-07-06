// Central configuration. Every value can be overridden via environment
// variables so the same build runs in simulation, paper, and live.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MODES = Object.freeze({
  SIMULATION: 'simulation',
  PAPER: 'paper',
  LIVE: 'live',
});

function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function resolveMode() {
  const raw = (process.env.TRADING_MODE || MODES.SIMULATION).toLowerCase();
  if (!Object.values(MODES).includes(raw)) {
    throw new Error(`Invalid TRADING_MODE "${raw}". Use one of: ${Object.values(MODES).join(', ')}`);
  }
  return raw;
}

export function loadConfig(overrides = {}) {
  const mode = overrides.mode ?? resolveMode();

  const config = {
    mode,
    dataDir: process.env.KYNGPYN_DATA_DIR || path.join(__dirname, '..', 'data'),

    server: {
      host: process.env.HOST || '0.0.0.0',
      port: envNum('PORT', 8420),
    },

    oanda: {
      apiKey: process.env.OANDA_API_KEY || '',
      accountId: process.env.OANDA_ACCOUNT_ID || '',
      // 'practice' (fxTrade Practice) or 'live' (fxTrade)
      environment: (process.env.OANDA_ENV || 'practice').toLowerCase(),
      requestTimeoutMs: envNum('OANDA_TIMEOUT_MS', 10_000),
      maxReconnectDelayMs: envNum('OANDA_MAX_RECONNECT_MS', 60_000),
    },

    scanner: {
      intervalMs: envNum('SCAN_INTERVAL_MS', 15_000),
      candleGranularity: process.env.CANDLE_GRANULARITY || 'M5',
      candleCount: envNum('CANDLE_COUNT', 120),
      minConfidence: envNum('SCANNER_MIN_CONFIDENCE', 60),
      maxSignalsPerScan: envNum('MAX_SIGNALS_PER_SCAN', 5),
    },

    decision: {
      approvalThreshold: envNum('APPROVAL_THRESHOLD', 70),
      minApproveVotes: envNum('MIN_APPROVE_VOTES', 4),
      vetoAgents: ['Risk Agent', 'News Agent'],
    },

    risk: {
      riskPerTradePct: envNum('RISK_PER_TRADE_PCT', 0.5),
      maxOpenPositions: envNum('MAX_OPEN_POSITIONS', 5),
      maxPositionsPerSymbol: envNum('MAX_POSITIONS_PER_SYMBOL', 1),
      dailyMaxLossPct: envNum('DAILY_MAX_LOSS_PCT', 3),
      maxConsecutiveLosses: envNum('MAX_CONSECUTIVE_LOSSES', 4),
      defaultStopAtrMultiple: envNum('STOP_ATR_MULTIPLE', 1.5),
      defaultTakeProfitAtrMultiple: envNum('TP_ATR_MULTIPLE', 2.5),
      trailingStopAtrMultiple: envNum('TRAIL_ATR_MULTIPLE', 2.0),
    },

    sessions: {
      // UTC hours during which new trades may be opened. 24h coverage by
      // default; tighten via env, e.g. ALLOWED_SESSIONS="london,newyork".
      allowed: (process.env.ALLOWED_SESSIONS || 'sydney,tokyo,london,newyork')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      // Minutes to block trading around high-impact news events.
      newsWindowMinutes: envNum('NEWS_WINDOW_MINUTES', 30),
    },

    paper: {
      startingBalance: envNum('PAPER_STARTING_BALANCE', 100_000),
      spreadPips: envNum('PAPER_SPREAD_PIPS', 1.2),
    },

    learning: {
      enabled: envBool('LEARNING_ENABLED', true),
      // Learning may nudge confidence within this bound, never beyond.
      maxAdjustment: envNum('LEARNING_MAX_ADJUSTMENT', 10),
      minSamples: envNum('LEARNING_MIN_SAMPLES', 5),
    },

    alerts: {
      webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
      emailTo: process.env.ALERT_EMAIL_TO || '',
      smtpUrl: process.env.ALERT_SMTP_URL || '',
      smsWebhookUrl: process.env.ALERT_SMS_WEBHOOK_URL || '',
    },

    live: {
      // Live trading requires BOTH flags plus OANDA credentials. This is the
      // "explicit live mode enabled" requirement from the spec.
      enabled: envBool('LIVE_TRADING_ENABLED', false),
      confirmationPhrase: process.env.LIVE_CONFIRMATION || '',
      requiredPhrase: 'I UNDERSTAND LIVE TRADING RISKS',
      maxUnitsPerTrade: envNum('LIVE_MAX_UNITS', 10_000),
    },

    ...overrides,
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (config.mode === MODES.LIVE) {
    const problems = [];
    if (!config.live.enabled) problems.push('LIVE_TRADING_ENABLED must be set to true');
    if (config.live.confirmationPhrase !== config.live.requiredPhrase) {
      problems.push(`LIVE_CONFIRMATION must equal "${config.live.requiredPhrase}"`);
    }
    if (!config.oanda.apiKey) problems.push('OANDA_API_KEY is required');
    if (!config.oanda.accountId) problems.push('OANDA_ACCOUNT_ID is required');
    if (problems.length) {
      throw new Error(`Live mode refused:\n - ${problems.join('\n - ')}`);
    }
  }
  if (config.risk.dailyMaxLossPct <= 0) throw new Error('DAILY_MAX_LOSS_PCT must be > 0');
  if (config.risk.maxOpenPositions < 1) throw new Error('MAX_OPEN_POSITIONS must be >= 1');
  return true;
}

export function ensureDataDir(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}
