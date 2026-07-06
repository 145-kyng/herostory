// Learning Agent — votes based on historical outcomes for this symbol /
// session / regime, sourced from the Learning Engine. Its influence is
// bounded: it can nudge, never override risk controls.
import { BaseAgent, VOTES } from './baseAgent.js';

export class LearningAgent extends BaseAgent {
  constructor({ config, learningEngine }) {
    super('Learning Agent');
    this.config = config;
    this.learningEngine = learningEngine;
  }

  async evaluate({ signal }) {
    if (!this.config.learning.enabled || !this.learningEngine) {
      return this.result(VOTES.ABSTAIN, 50, 'Learning disabled.');
    }
    const stats = this.learningEngine.statsFor(signal);
    if (!stats || stats.samples < this.config.learning.minSamples) {
      return this.result(VOTES.ABSTAIN, 50, `Not enough history (${stats?.samples ?? 0} samples).`);
    }

    const winRate = stats.winRate; // 0..1
    const expectancy = stats.expectancy; // avg R multiple
    let score = 50 + (winRate - 0.5) * 60 + Math.max(-15, Math.min(15, expectancy * 10));
    score = Math.max(0, Math.min(100, score));

    const summary = `${stats.samples} similar trades: ${(winRate * 100).toFixed(0)}% wins, ${expectancy.toFixed(2)}R expectancy.`;
    if (score >= 58) return this.result(VOTES.APPROVE, score, summary);
    if (score >= 42) return this.result(VOTES.ABSTAIN, score, summary);
    return this.result(VOTES.REJECT, score, summary);
  }
}
