// Liquidity Agent — judges spread cost, session liquidity, sweep context,
// and volatility conditions for clean execution.
import { BaseAgent, VOTES } from './baseAgent.js';
import { getInstrument } from '../data/instruments.js';
import { detectLiquiditySweep, atr } from '../scanner/indicators.js';

export class LiquidityAgent extends BaseAgent {
  constructor({ marketData }) {
    super('Liquidity Agent');
    this.marketData = marketData;
  }

  async evaluate({ signal, candles, session }) {
    let score = 55;
    const reasons = [];

    // Session liquidity.
    if (session?.overlap) { score += 15; reasons.push('London/NY overlap'); }
    else if (session?.active?.includes('london') || session?.active?.includes('newyork')) {
      score += 8; reasons.push('major session active');
    } else if (session?.active?.length === 1 && session.active[0] === 'sydney') {
      score -= 12; reasons.push('thin Sydney-only liquidity');
    }
    if (session?.weekend && getInstrument(signal.symbol)?.assetClass !== 'crypto') {
      return this.result(VOTES.REJECT, 10, 'Market closed for the weekend.');
    }

    // Spread relative to ATR — wide spread in quiet markets kills edge.
    const tick = this.marketData?.getLastTick?.(signal.symbol);
    const currentAtr = candles ? atr(candles, 14) : null;
    if (tick && currentAtr) {
      const spread = tick.ask - tick.bid;
      const spreadRatio = spread / currentAtr;
      if (spreadRatio > 0.25) { score -= 25; reasons.push('spread too wide vs ATR'); }
      else if (spreadRatio < 0.08) { score += 10; reasons.push('tight spread'); }
    }

    // Sweep alignment: entering after a sweep in our favor is prime liquidity.
    const sweep = candles ? detectLiquiditySweep(candles, 20) : { swept: false };
    if (sweep.swept) {
      if (sweep.bias === signal.direction) { score += 15; reasons.push(`liquidity sweep favors ${signal.direction}`); }
      else { score -= 15; reasons.push('sweep against direction'); }
    }

    const reason = reasons.length ? reasons.join('; ') + '.' : 'Neutral liquidity conditions.';
    if (score >= 60) return this.result(VOTES.APPROVE, score, reason);
    if (score >= 40) return this.result(VOTES.ABSTAIN, score, reason);
    return this.result(VOTES.REJECT, score, reason);
  }
}
