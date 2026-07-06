// Portfolio Agent — looks at the whole book: diversification, direction
// concentration, recent performance momentum.
import { BaseAgent, VOTES } from './baseAgent.js';
import { getInstrument } from '../data/instruments.js';

export class PortfolioAgent extends BaseAgent {
  constructor() { super('Portfolio Agent'); }

  async evaluate({ signal, portfolio }) {
    const open = portfolio?.openPositions ?? [];
    let score = 65;
    const reasons = [];

    // Direction concentration: an all-LONG book adding another LONG is fragile.
    const sameDir = open.filter((p) => p.direction === signal.direction).length;
    if (open.length >= 2 && sameDir === open.length) {
      score -= 15; reasons.push(`book already all-${signal.direction}`);
    }

    // Asset-class concentration.
    const cls = getInstrument(signal.symbol)?.assetClass;
    const sameClass = open.filter((p) => getInstrument(p.symbol)?.assetClass === cls).length;
    if (sameClass >= 3) { score -= 15; reasons.push(`concentrated in ${cls}`); }
    else if (sameClass === 0 && open.length > 0) { score += 10; reasons.push('adds diversification'); }

    // Unrealized P&L context: deep red book argues for caution.
    const unrealized = portfolio?.unrealizedPnl ?? 0;
    const balance = portfolio?.balance || 1;
    const unrealizedPct = (unrealized / balance) * 100;
    if (unrealizedPct < -1.5) { score -= 15; reasons.push('book deeply underwater'); }
    else if (unrealizedPct > 0.5) { score += 5; reasons.push('book in profit'); }

    const reason = reasons.length ? reasons.join('; ') + '.' : 'Portfolio balance is healthy.';
    if (score >= 55) return this.result(VOTES.APPROVE, score, reason);
    if (score >= 40) return this.result(VOTES.ABSTAIN, score, reason);
    return this.result(VOTES.REJECT, score, reason);
  }
}
