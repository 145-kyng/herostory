// Market Agent — validates the technical case: trend structure, momentum
// quality, and whether the scanner's direction holds up on the candles.
import { BaseAgent, VOTES } from './baseAgent.js';
import { ema, rsi, roc } from '../scanner/indicators.js';

export class MarketAgent extends BaseAgent {
  constructor() { super('Market Agent'); }

  async evaluate({ signal, candles }) {
    if (!candles || candles.length < 60) {
      return this.result(VOTES.ABSTAIN, 50, 'Insufficient candle history.');
    }
    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];
    const fast = ema(closes, 20);
    const slow = ema(closes, 50);
    const momentum = roc(closes, 10) ?? 0;
    const strength = rsi(closes, 14) ?? 50;

    let score = 50;
    const long = signal.direction === 'LONG';

    // Structure agreement.
    if ((long && fast > slow) || (!long && fast < slow)) score += 20;
    else score -= 20;

    // Price on the right side of the fast EMA.
    if ((long && price > fast) || (!long && price < fast)) score += 10;
    else score -= 10;

    // Momentum agreement.
    if ((long && momentum > 0) || (!long && momentum < 0)) score += 10;
    else score -= 10;

    // Penalize chasing exhaustion.
    if ((long && strength > 75) || (!long && strength < 25)) score -= 15;

    if (score >= 60) return this.result(VOTES.APPROVE, score, `Structure and momentum support ${signal.direction}.`);
    if (score >= 45) return this.result(VOTES.ABSTAIN, score, 'Mixed technical picture.');
    return this.result(VOTES.REJECT, score, `Technicals disagree with ${signal.direction}.`);
  }
}
