// Risk Agent — the veto holder. Checks account state against hard limits:
// daily loss, consecutive losses, exposure, volatility. Learning may never
// override this agent (enforced in the Decision Engine).
import { BaseAgent, VOTES } from './baseAgent.js';

export class RiskAgent extends BaseAgent {
  constructor({ config }) {
    super('Risk Agent');
    this.config = config;
  }

  async evaluate({ signal, portfolio, safety }) {
    const r = this.config.risk;

    if (safety?.killSwitch) return this.result(VOTES.REJECT, 0, 'Kill switch engaged.');
    if (safety?.paused) return this.result(VOTES.REJECT, 5, 'Trading manually paused.');

    if (safety?.dailyLossPct >= r.dailyMaxLossPct) {
      return this.result(VOTES.REJECT, 0, `Daily loss limit hit (${safety.dailyLossPct.toFixed(2)}% >= ${r.dailyMaxLossPct}%).`);
    }
    if (safety?.consecutiveLosses >= r.maxConsecutiveLosses) {
      return this.result(VOTES.REJECT, 5, `${safety.consecutiveLosses} consecutive losses — cooling off.`);
    }

    const open = portfolio?.openPositions ?? [];
    if (open.length >= r.maxOpenPositions) {
      return this.result(VOTES.REJECT, 10, `Max open positions reached (${open.length}/${r.maxOpenPositions}).`);
    }
    const sameSymbol = open.filter((p) => p.symbol === signal.symbol).length;
    if (sameSymbol >= r.maxPositionsPerSymbol) {
      return this.result(VOTES.REJECT, 15, `Already holding ${signal.symbol}.`);
    }

    let score = 75;
    const reasons = [];

    // Correlated exposure: crude but effective — same base or quote currency.
    const [base, quote] = signal.symbol.split('_');
    const correlated = open.filter((p) => p.symbol.includes(base) || p.symbol.includes(quote)).length;
    if (correlated >= 2) { score -= 20; reasons.push('correlated exposure elevated'); }
    else if (correlated === 1) { score -= 8; reasons.push('some correlated exposure'); }

    // Drawdown proximity: approaching (not at) the daily limit trims risk.
    const lossRatio = (safety?.dailyLossPct ?? 0) / r.dailyMaxLossPct;
    if (lossRatio > 0.66) { score -= 25; reasons.push('near daily loss limit'); }
    else if (lossRatio > 0.33) { score -= 10; reasons.push('drawdown building'); }

    // Volatility regime: chaotic tape widens stops beyond plan.
    if (signal.regime === 'volatile') { score -= 15; reasons.push('volatile regime'); }

    const reason = reasons.length ? reasons.join('; ') + '.' : 'Risk acceptable.';
    if (score >= 55) return this.result(VOTES.APPROVE, score, reason);
    if (score >= 40) return this.result(VOTES.ABSTAIN, score, reason);
    return this.result(VOTES.REJECT, score, reason);
  }
}
