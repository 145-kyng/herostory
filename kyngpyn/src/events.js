// System-wide event bus. Every layer communicates through named events so
// layers stay decoupled and testable.
import { EventEmitter } from 'node:events';

export const EVENTS = Object.freeze({
  PRICE: 'price',                       // { symbol, bid, ask, time }
  CANDLES: 'candles',                   // { symbol, granularity, candles }
  SCANNER_SIGNAL: 'scanner:signal',     // { symbol, direction, confidence, ... }
  SCANNER_CYCLE: 'scanner:cycle',       // { results, startedAt, durationMs }
  COUNCIL_VOTES: 'council:votes',       // { signal, votes }
  DECISION: 'decision',                 // { signal, votes, approved, confidence, reasons }
  TRADE_OPENED: 'trade:opened',         // { trade }
  TRADE_CLOSED: 'trade:closed',         // { trade }
  TRADE_UPDATED: 'trade:updated',       // { trade }
  SAFETY_TRIPPED: 'safety:tripped',     // { rule, detail }
  KILL_SWITCH: 'safety:killswitch',     // { engaged, by }
  ALERT: 'alert',                       // { severity, title, body }
  HEALTH: 'health',                     // { component, status, detail }
  COMMAND: 'command',                   // { action, args, source }
  LEARNING_UPDATED: 'learning:updated', // { symbol, stats }
});

export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  return bus;
}
