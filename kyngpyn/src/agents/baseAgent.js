// Agents analyze and vote. They NEVER place trades — they only return
// { agent, vote, score, reason } for the Decision Engine to weigh.

export const VOTES = Object.freeze({
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  ABSTAIN: 'ABSTAIN',
});

export class BaseAgent {
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {object} ctx — { signal, candles, portfolio, learning, safety, news, session }
   * @returns {Promise<{agent: string, vote: string, score: number, reason: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async evaluate(ctx) {
    throw new Error(`${this.name} must implement evaluate()`);
  }

  result(vote, score, reason) {
    return {
      agent: this.name,
      vote,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reason,
    };
  }
}
